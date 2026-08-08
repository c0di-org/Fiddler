//! Thumbnail generation with an on-disk cache.
//!
//! Two paths, both of them the ones macOS uses for itself. Raster formats go
//! through ImageIO, which decodes straight to the size we asked for — reusing the
//! embedded EXIF preview when there is one, and DCT-scaling when there isn't —
//! rather than expanding a 24-megapixel JPEG we are about to throw away.
//! Everything else (PDF, video, Sketch, Keynote, …) goes to
//! QuickLookThumbnailing, which renders out-of-process and shares the system
//! thumbnail cache, so files Finder has already previewed come back for free.
//!
//! Results are cached by (path, mtime, size, requested px) so scrolling back
//! through a folder never re-renders.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFString, CFType, CFURL, CGSize};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSError, NSString, NSURL};
use objc2_image_io::{
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceShouldCacheImmediately, kCGImageSourceThumbnailMaxPixelSize, CGImageDestination,
    CGImageSource,
};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
    QLThumbnailGenerator, QLThumbnailRepresentation,
};

/// Files past this size skip ImageIO and go to Quick Look, which renders in a
/// separate process — so one pathological TIFF can't balloon our resident memory.
const MAX_INLINE_DECODE: u64 = 128 * 1024 * 1024;

/// How long we'll wait on Quick Look before giving up on a file. The agent
/// occasionally wedges on damaged media, and a stuck worker is worse than a
/// missing preview.
const QUICKLOOK_TIMEOUT: Duration = Duration::from_secs(20);

/// Formats ImageIO decodes natively. RAW and HEIC belong here rather than with
/// Quick Look: ImageIO pulls their embedded preview directly, which is far
/// cheaper than asking for a rendered thumbnail.
const RASTER: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "gif", "bmp", "ico", "tif", "tiff", "webp", "avif", "heic",
    "heif", "jp2", "psd", "tga", "exr", "icns", "raw", "cr2", "cr3", "nef", "arw", "dng", "raf",
    "orf", "rw2", "srw", "pef",
];

/// Types Quick Look renders well and users expect previews for.
const QUICKLOOK: &[&str] = &[
    "pdf", "svg", "mov", "mp4", "m4v", "avi", "mkv", "webm", "ai", "sketch", "key", "pages",
    "numbers", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "epub", "usdz", "obj", "stl",
];

pub fn can_thumbnail(path: &Path) -> bool {
    match ext_of(path) {
        Some(e) => RASTER.contains(&e.as_str()) || QUICKLOOK.contains(&e.as_str()),
        None => false,
    }
}

/// Whether this file takes the in-process ImageIO path. The scheduler keeps
/// these in a separate lane from Quick Look, since the two have very different
/// cost profiles.
pub fn is_raster(path: &Path) -> bool {
    ext_of(path).map(|e| RASTER.contains(&e.as_str())).unwrap_or(false)
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn cache_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
        let dir = base.join("app.fiddler.desktop").join("thumbnails");
        std::fs::create_dir_all(&dir).ok();
        dir
    })
}

/// Where the thumbnail for this file *would* live. Costs one `stat`, which is
/// what makes the cache probe cheap enough to run over a whole viewport.
fn cache_path(path: &Path, max_px: u32) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    meta.len().hash(&mut h);
    max_px.hash(&mut h);

    Ok(cache_root().join(format!("{:016x}.png", h.finish())))
}

/// An already-rendered thumbnail, if we have one. Never renders, so it's safe to
/// call for every tile on screen before queueing any real work.
pub fn cached(path: &Path, max_px: u32) -> Option<PathBuf> {
    let out = cache_path(path, max_px).ok()?;
    out.is_file().then_some(out)
}

/// Produce (or reuse) a thumbnail and return the cached file's path.
pub fn generate(path: &Path, max_px: u32) -> Result<PathBuf, String> {
    let out = cache_path(path, max_px)?;
    if out.is_file() {
        return Ok(out);
    }

    let small_enough = std::fs::metadata(path).map(|m| m.len() <= MAX_INLINE_DECODE).unwrap_or(false);
    if is_raster(path) && small_enough && image_io(path, max_px, &out).is_ok() {
        return Ok(out);
    }
    quicklook(path, max_px, &out)?;
    Ok(out)
}

/// Decode straight to thumbnail size via ImageIO.
fn image_io(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    let url = CFURL::from_file_path(path).ok_or("unrepresentable path")?;
    let src = unsafe { CGImageSource::with_url(&url, None) }.ok_or("not a readable image")?;

    let keys: [&CFString; 4] = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceThumbnailMaxPixelSize,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceShouldCacheImmediately,
        ]
    };
    let max = CFNumber::new_i32(max_px as i32);
    // `WithTransform` applies the EXIF orientation, so portrait photos shot on a
    // phone don't come back on their side.
    let values: [&CFType; 4] = [
        CFBoolean::new(true),
        &max,
        CFBoolean::new(true),
        CFBoolean::new(true),
    ];
    let opts = CFDictionary::from_slices(&keys, &values);

    let image = unsafe { src.thumbnail_at_index(0, Some(opts.as_ref())) }
        .ok_or("ImageIO produced no thumbnail")?;
    write_png(&image, out)
}

/// Ask Quick Look — the same machinery behind Finder's previews — for a
/// thumbnail. The API is completion-block based, so the calling worker parks on a
/// channel until the agent answers.
fn quicklook(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let request = unsafe {
        QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
            QLThumbnailGenerationRequest::alloc(),
            &url,
            CGSize::new(max_px as f64, max_px as f64),
            1.0,
            QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
        )
    };
    // Without this, documents come back wearing a page-with-folded-corner frame.
    unsafe { request.setIconMode(false) };

    let (tx, rx) = sync_channel::<Result<(), String>>(1);
    let out = out.to_path_buf();
    // Encoding inside the handler keeps the CGImage on the thread Quick Look
    // handed it to us on, and means only a plain `Result` crosses the channel.
    let handler = RcBlock::new(
        move |rep: *mut QLThumbnailRepresentation, err: *mut NSError| {
            let result = match unsafe { rep.as_ref() } {
                Some(rep) => {
                    let image = unsafe { rep.CGImage() };
                    write_png(&image, &out)
                }
                None => Err(unsafe { err.as_ref() }
                    .map(|e| e.localizedDescription().to_string())
                    .unwrap_or_else(|| "Quick Look produced no preview".into())),
            };
            let _ = tx.send(result);
        },
    );

    unsafe {
        QLThumbnailGenerator::sharedGenerator()
            .generateBestRepresentationForRequest_completionHandler(&request, &handler)
    };

    match rx.recv_timeout(QUICKLOOK_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            unsafe { QLThumbnailGenerator::sharedGenerator().cancelRequest(&request) };
            Err("Quick Look timed out".into())
        }
    }
}

/// Write a CGImage out as PNG, via a unique temp name so a half-written file is
/// never visible under the cache key — two workers can race on the same key, and
/// the webview reads these paths directly.
fn write_png(image: &CGImage, out: &Path) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = out.with_extension(format!("{}.part", SEQ.fetch_add(1, Ordering::Relaxed)));

    let url = CFURL::from_file_path(&tmp).ok_or("unrepresentable cache path")?;
    let png = CFString::from_static_str("public.png");
    let write = (|| {
        let dest = unsafe { CGImageDestination::with_url(&url, &png, 1, None) }
            .ok_or("could not open the thumbnail cache for writing")?;
        unsafe { dest.add_image(image, None) };
        unsafe { dest.finalize() }
            .then_some(())
            .ok_or_else(|| "could not encode the thumbnail".to_string())
    })();

    match write {
        Ok(()) => std::fs::rename(&tmp, out).map_err(|e| e.to_string()),
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_previewable_types() {
        assert!(can_thumbnail(Path::new("/a/b/photo.JPG")));
        assert!(can_thumbnail(Path::new("/a/b/doc.pdf")));
        assert!(can_thumbnail(Path::new("/a/b/clip.mov")));
        assert!(!can_thumbnail(Path::new("/a/b/main.rs")));
        assert!(!can_thumbnail(Path::new("/a/b/Makefile")));
    }

    #[test]
    fn raster_and_quicklook_lanes_are_distinct() {
        assert!(is_raster(Path::new("/a/IMG_0001.heic")));
        assert!(is_raster(Path::new("/a/shot.CR2")));
        assert!(!is_raster(Path::new("/a/deck.key")));
        assert!(!is_raster(Path::new("/a/notes.txt")));
    }

    #[test]
    fn missing_files_error_rather_than_panicking() {
        let missing = std::env::temp_dir().join("fiddler-does-not-exist.png");
        std::fs::remove_file(&missing).ok();
        assert!(generate(&missing, 128).is_err());
        assert!(cached(&missing, 128).is_none());
    }

    #[test]
    fn extensions_are_matched_case_insensitively() {
        assert_eq!(ext_of(Path::new("/a/IMG_0001.HEIC")).as_deref(), Some("heic"));
        assert_eq!(ext_of(Path::new("/a/noext")), None);
    }

    #[test]
    fn cache_keys_track_size_and_content() {
        let f = std::env::temp_dir().join("fiddler-cache-key-probe.txt");
        std::fs::write(&f, b"one").unwrap();
        let a = cache_path(&f, 128).unwrap();
        assert_ne!(a, cache_path(&f, 256).unwrap(), "requested size must key the cache");
        std::fs::write(&f, b"a different length").unwrap();
        assert_ne!(a, cache_path(&f, 128).unwrap(), "edits must invalidate the cache");
        std::fs::remove_file(&f).ok();
    }
}

#[cfg(test)]
mod smoke {
    //! Exercised against real files on disk; skipped when the fixtures are absent.
    use super::*;

    fn render(fixture: &str) -> Option<PathBuf> {
        let p = Path::new(fixture);
        if !p.is_file() {
            eprintln!("skipping, no fixture at {fixture}");
            return None;
        }
        let out = generate(p, 256).unwrap_or_else(|e| panic!("{fixture}: {e}"));
        let bytes = std::fs::metadata(&out).unwrap().len();
        assert!(bytes > 0, "{fixture} produced an empty thumbnail");
        eprintln!("ok {fixture} -> {} ({bytes} bytes)", out.display());
        Some(out)
    }

    #[test]
    fn renders_a_png_via_image_io() {
        render("icons/128x128.png").expect("bundled icon should always render");
    }

    #[test]
    fn renders_a_heic_via_image_io() {
        render("/System/Library/CoreServices/DefaultDesktop.heic");
    }

    #[test]
    fn renders_a_pdf_via_quick_look() {
        render("/System/Library/CoreServices/liquiddetectiond.app/lockScreenLiquidDetection.pdf");
    }

    #[test]
    fn renders_a_movie_via_quick_look() {
        render("/System/Library/CoreServices/NotificationCenter.app/Contents/Resources/mac_widgets-edu_full.mov");
    }
}
