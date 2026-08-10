//! Thumbnail generation with an on-disk cache.
//!
//! Four paths, all of them the ones macOS uses for itself. Raster formats go
//! through ImageIO, which decodes straight to the size we asked for — reusing the
//! embedded EXIF preview when there is one, and DCT-scaling when there isn't —
//! rather than expanding a 24-megapixel JPEG we are about to throw away. Text
//! files are laid out as a page by Core Text, and PDFs are rasterised by Core
//! Graphics; both are in-process and cost well under a millisecond, where asking
//! Quick Look for the same thing costs tens and a trip to another process.
//! Everything left over (video, Sketch, Keynote, …) does go to
//! QuickLookThumbnailing, which shares the system thumbnail cache, so files
//! Finder has already previewed come back for free.
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
use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize, CFURL,
};
use objc2_core_graphics::{CGBitmapContextCreateImage, CGColor, CGColorSpace, CGContext, CGImage};
use objc2_foundation::{NSError, NSString, NSURL};
use objc2_image_io::{
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailFromImageIfAbsent,
    kCGImageSourceCreateThumbnailWithTransform,
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

/// Types Quick Look renders well and users expect previews for. PDF is handled
/// directly instead — see `Lane::Page`.
const QUICKLOOK: &[&str] = &[
    "svg", "mov", "mp4", "m4v", "avi", "mkv", "webm", "ai", "sketch", "key", "pages", "numbers",
    "ppt", "pptx", "doc", "docx", "xls", "xlsx", "epub", "usdz", "obj", "stl",
];

/// Everything we'll draw as a page of text. Deliberately broad: a source file
/// the user can recognise by its shape is worth far more than another grey
/// document glyph, and the render is cheap enough that breadth costs nothing.
const TEXT: &[&str] = &[
    "md",
    "mdx",
    "markdown",
    "rst",
    "txt",
    "text",
    "log",
    "csv",
    "tsv",
    "diff",
    "patch",
    "tex",
    "srt",
    "vtt",
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "xml",
    "plist",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "sql",
    "graphql",
    "sh",
    "zsh",
    "bash",
    "fish",
    "ps1",
    "bat",
    "rs",
    "go",
    "py",
    "rb",
    "swift",
    "java",
    "kt",
    "kts",
    "gradle",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hh",
    "cs",
    "m",
    "mm",
    "php",
    "lua",
    "pl",
    "r",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "vue",
    "svelte",
    "dart",
    "ex",
    "exs",
    "erl",
    "hs",
    "scala",
    "clj",
    "zig",
    "nim",
    "sol",
    "proto",
    "cmake",
    "mk",
    "lock",
];

/// Files everyone recognises that carry no extension to key off.
const TEXT_NAMES: &[&str] = &[
    "Makefile",
    "Dockerfile",
    "Justfile",
    "Rakefile",
    "Gemfile",
    "Procfile",
    "Brewfile",
    "CODEOWNERS",
    "LICENCE",
    "LICENSE",
    "README",
    "CHANGELOG",
    "AUTHORS",
    "NOTICE",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".env",
    ".zshrc",
    ".bashrc",
    ".profile",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".npmrc",
];

pub fn can_thumbnail(path: &Path) -> bool {
    !matches!(lane_of(path), Lane::None)
}

/// Which of the four renderers this file belongs to. The scheduler keeps them in
/// separate queues, because their cost profiles are nothing alike: text is
/// microseconds, raster is CPU-bound and scales with cores, PDF is somewhere in
/// between, and Quick Look mostly waits on another process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Text,
    Raster,
    Page,
    QuickLook,
    /// Nothing we can preview.
    None,
}

pub fn lane_of(path: &Path) -> Lane {
    if let Some(e) = ext_of(path) {
        if RASTER.contains(&e.as_str()) {
            return Lane::Raster;
        }
        if e == "pdf" {
            return Lane::Page;
        }
        if QUICKLOOK.contains(&e.as_str()) {
            return Lane::QuickLook;
        }
        if TEXT.contains(&e.as_str()) {
            return Lane::Text;
        }
    }
    let named = path
        .file_name()
        .map(|n| TEXT_NAMES.contains(&n.to_string_lossy().as_ref()))
        .unwrap_or(false);
    if named {
        return Lane::Text;
    }
    Lane::None
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
    keyed(path, max_px, 0)
}

/// The same, for renders that need a second axis — PDF pages, where one file
/// produces a different image per page at the same requested size.
pub fn keyed(path: &Path, max_px: u32, variant: u64) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(keyed_with(path, max_px, variant, mtime, meta.len()))
}

/// The cache path for content whose mtime and size the caller already knows.
///
/// Objects on a USB device have no `stat` to call, but a listing has already
/// reported both — so a phone's photos land in the same cache, under the same
/// key shape, as everything else. Same inputs, same file on disk.
pub fn keyed_with(path: &Path, max_px: u32, variant: u64, mtime: u64, len: u64) -> PathBuf {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    len.hash(&mut h);
    max_px.hash(&mut h);
    variant.hash(&mut h);

    cache_root().join(format!("{:016x}.png", h.finish()))
}

/// An already-rendered thumbnail, if we have one. Never renders, so it's safe to
/// call for every tile on screen before queueing any real work.
pub fn cached(path: &Path, max_px: u32) -> Option<PathBuf> {
    let out = usb_cache_path(path, max_px).unwrap_or_else(|| cache_path(path, max_px).ok())?;
    out.is_file().then_some(out)
}

/// The cache path for an object on a USB device, or `None` if this isn't one.
///
/// The outer `Option` distinguishes "not a device path" from "a device path we
/// have no listing for" — the second is a miss we can't key, and must not fall
/// through to `cache_path`, which would try to `stat` a `mtp://` string.
#[cfg(not(target_os = "android"))]
fn usb_cache_path(path: &Path, max_px: u32) -> Option<Option<PathBuf>> {
    let text = path.to_str()?;
    if crate::mtp::path::parse(text).is_none() {
        return None;
    }
    let meta = crate::mtp::service().and_then(|s| s.meta(text));
    Some(meta.map(|(len, mtime)| keyed_with(path, max_px, 0, mtime.max(0) as u64, len)))
}

#[cfg(target_os = "android")]
fn usb_cache_path(_path: &Path, _max_px: u32) -> Option<Option<PathBuf>> {
    None
}

/// Produce (or reuse) a thumbnail and return the cached file's path.
pub fn generate(path: &Path, max_px: u32) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "android"))]
    if let Some(out) = usb_cache_path(path, max_px) {
        return usb_thumbnail(path, max_px, out.ok_or("that device path has not been listed")?);
    }

    let out = cache_path(path, max_px)?;
    if out.is_file() {
        return Ok(out);
    }

    match lane_of(path) {
        // A text file that turns out to be binary, or a PDF that turns out to be
        // damaged, still gets Quick Look's opinion before we give up on it.
        Lane::Text => crate::thumb_text::render(path, max_px, &out)
            .or_else(|_| quicklook(path, max_px, &out))?,
        Lane::Page => {
            crate::page::render(path, 1, max_px, &out).or_else(|_| quicklook(path, max_px, &out))?
        }
        Lane::Raster => {
            let small_enough = std::fs::metadata(path)
                .map(|m| m.len() <= MAX_INLINE_DECODE)
                .unwrap_or(false);
            if !(small_enough && image_io(path, max_px, &out).is_ok()) {
                quicklook(path, max_px, &out)?;
            }
        }
        Lane::QuickLook | Lane::None => quicklook(path, max_px, &out)?,
    }
    Ok(out)
}

/// How much of a file to pull off a device before trying to draw it.
///
/// A phone photo carries a full-size JPEG thumbnail in its EXIF block, within
/// the first couple of hundred kilobytes. Measured on a Galaxy Z Fold 7 over
/// USB 2.0: 256 KB arrives in ~8.9ms and contains a ~50 KB embedded thumbnail
/// every time, where pulling the whole 4-8 MB image would cost over a hundred
/// milliseconds each and swamp the bus for a screen of tiles.
const USB_HEAD_BYTES: u32 = 256 * 1024;

/// A thumbnail for an object on a USB device.
///
/// ImageIO wants somewhere to read from, so the head of the file lands in a
/// temporary file and takes the ordinary raster path from there. That costs one
/// 256 KB write and buys the EXIF-thumbnail extraction, orientation transform
/// and PNG encoding already tuned for local files.
///
/// A truncated file is the normal case here, not an error: ImageIO finds the
/// embedded thumbnail in the header and never reaches the missing tail. When a
/// format keeps nothing useful up front, this fails and the tile falls back to
/// its glyph rather than dragging megabytes over the cable on spec.
#[cfg(not(target_os = "android"))]
fn usb_thumbnail(path: &Path, max_px: u32, out: PathBuf) -> Result<PathBuf, String> {
    if out.is_file() {
        return Ok(out);
    }
    let service = crate::mtp::service().ok_or("the USB service is not running")?;
    let text = path.to_str().ok_or("unrepresentable path")?;
    let lane = lane_of(path);

    // Work out where the pixels can come from before fetching anything.
    //
    // Text and images can usually be drawn from the front of the file, which is
    // one cheap read. Video cannot: an mp4 keeps nothing an image decoder can
    // use up there, so reading its head would cost 256 KB and buy a glyph. The
    // device can decode a frame, so ask it directly and skip the read.
    //
    // A truncated image must never be rendered either way. ImageIO will
    // cheerfully decode the fraction of a photo that arrived and produce a
    // picture that fades to blank part way down, which looks like a broken app
    // rather than a missing preview.
    let head = match lane {
        Lane::Text | Lane::Raster => Some(service.read_range(text, 0, USB_HEAD_BYTES)?),
        _ => None,
    };
    let source = plan_source(lane, head.as_deref());

    // The scratch file keeps the real extension: `thumb_text` picks its syntax
    // highlighting from it, and ImageIO uses it as a decoding hint.
    let suffix = path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let scratch = cache_root().join(format!(
        ".head-{:016x}.{suffix}",
        out.file_name().map_or(0, hash_of)
    ));

    let result = match source {
        // Whole file, or text drawn from its first bytes: the ordinary paths.
        Source::Whole => {
            let head = head.as_deref().ok_or("nothing was read")?;
            std::fs::write(&scratch, head).map_err(|e| e.to_string())?;
            match lane {
                Lane::Text => crate::thumb_text::render(&scratch, max_px, &out),
                _ => image_io_opts(&scratch, max_px, &out, false),
            }
        }
        // The device draws it. The only route that works for video, and the
        // last resort for anything else whose front held nothing usable.
        //
        // A device thumbnail is generated for display, so it arrives the right
        // way up — but it is still a JPEG that may carry its own orientation
        // tag, and honouring one costs nothing.
        Source::Device => {
            let bytes = service.device_thumbnail(text)?;
            std::fs::write(&scratch, &bytes).map_err(|e| e.to_string())?;
            decode_upright(&scratch, max_px, &out, exif_orientation(&bytes))
        }
        // Only the front of a photo arrived.
        //
        // Handing that to ImageIO does not work even with `IfAbsent`: it
        // decodes the truncated main image anyway and returns a picture that
        // fades to grey part way down. Measured, not assumed — the first fix
        // for this bug set `IfAbsent` and changed nothing.
        //
        // So cut the embedded JPEG out and decode that instead. It is a whole,
        // valid image, which is the only thing ImageIO can be trusted with
        // here. It carries no EXIF of its own, so the parent's orientation has
        // to be read and applied by hand or portrait photos come back sideways.
        Source::Embedded => {
            let head = head.as_deref().ok_or("nothing was read")?;
            let thumbnail = embedded_thumbnail(head).ok_or("no embedded thumbnail")?;
            std::fs::write(&scratch, thumbnail).map_err(|e| e.to_string())?;
            decode_upright(&scratch, max_px, &out, exif_orientation(head))
        }
    };
    let _ = std::fs::remove_file(&scratch);
    result.map(|_| out)
}

/// Decode an image and write it out turned the right way up.
#[cfg(not(target_os = "android"))]
fn decode_upright(src: &Path, max_px: u32, out: &Path, orientation: u16) -> Result<(), String> {
    let image = image_io_image(src, max_px)?;
    if orientation <= 1 {
        return write_png(&image, out);
    }
    let upright = oriented(&image, orientation)?;
    write_png(&upright, out)
}

/// Decide where a device thumbnail's pixels will come from.
///
/// Split out from the fetching so the routing is testable on its own: which
/// kind of file takes which route is the part that keeps being got wrong.
#[cfg(not(target_os = "android"))]
fn plan_source(lane: Lane, head: Option<&[u8]>) -> Source {
    match head {
        // Text is drawn from its first lines, so a partial read is the point.
        Some(_) if matches!(lane, Lane::Text) => Source::Whole,
        // A read that came back short covered the whole file: nothing was cut.
        Some(head) if (head.len() as u32) < USB_HEAD_BYTES => Source::Whole,
        Some(head) if embedded_thumbnail(head).is_some() => Source::Embedded,
        // Either there was no head worth having (video, PDF), or the head we
        // got holds no complete thumbnail. Both are the device's problem now.
        _ => Source::Device,
    }
}

/// Where a device thumbnail's pixels come from.
#[cfg(not(target_os = "android"))]
#[derive(Debug, PartialEq, Eq)]
enum Source {
    /// The read covered the entire file, so it can be decoded like any other.
    Whole,
    /// Only the front arrived, but it contains a complete EXIF thumbnail.
    Embedded,
    /// Nothing we can read cheaply will draw this, so the device draws it.
    Device,
}

#[cfg(not(target_os = "android"))]
fn hash_of(name: &std::ffi::OsStr) -> u64 {
    let mut h = DefaultHasher::new();
    name.hash(&mut h);
    h.finish()
}

/// Decode straight to thumbnail size via ImageIO.
fn image_io(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    image_io_opts(path, max_px, out, false)
}

/// The complete JPEG embedded in this buffer's EXIF block, if there is one.
///
/// A camera photo carries a full thumbnail of itself near the front, between a
/// second SOI marker and its matching EOI. Finding a *complete* one is the test
/// for whether a truncated file can be drawn at all: ImageIO will happily decode
/// the partial full-size image otherwise and produce a picture that fades into
/// blank half way down.
fn embedded_thumbnail(buf: &[u8]) -> Option<&[u8]> {
    // Skip the outer SOI, then find the nested one that opens the thumbnail.
    let start = buf.windows(2).skip(2).position(|w| w == [0xFF, 0xD8])? + 2;
    let end = buf[start..].windows(2).position(|w| w == [0xFF, 0xD9])? + 2;
    Some(&buf[start..start + end])
}

/// The EXIF orientation of a JPEG, or 1 when it doesn't say.
///
/// Needed because an embedded thumbnail is stored the way the sensor read it
/// and carries no EXIF of its own — the orientation lives in the parent file.
/// Pull the thumbnail out on its own and a portrait photo comes back on its
/// side, so the tag has to be read here and applied by hand.
fn exif_orientation(buf: &[u8]) -> u16 {
    // Walk JPEG segments looking for APP1/Exif. Bounded, and bails on anything
    // malformed rather than trusting lengths from a half-downloaded file.
    let mut at = 2; // past SOI
    while at + 4 <= buf.len() {
        if buf[at] != 0xFF {
            return 1;
        }
        let marker = buf[at + 1];
        let len = u16::from_be_bytes([buf[at + 2], buf[at + 3]]) as usize;
        if len < 2 || at + 2 + len > buf.len() {
            return 1;
        }
        if marker == 0xE1 && buf[at + 4..].starts_with(b"Exif\0\0") {
            return orientation_in_tiff(&buf[at + 10..at + 2 + len]);
        }
        at += 2 + len;
    }
    1
}

/// Read tag 0x0112 out of IFD0 of a TIFF block, which is what an EXIF APP1 is.
fn orientation_in_tiff(tiff: &[u8]) -> u16 {
    if tiff.len() < 8 {
        return 1;
    }
    let big = match &tiff[..2] {
        b"MM" => true,
        b"II" => false,
        _ => return 1,
    };
    let u16_at = |b: &[u8], i: usize| -> u16 {
        if big { u16::from_be_bytes([b[i], b[i + 1]]) } else { u16::from_le_bytes([b[i], b[i + 1]]) }
    };
    let u32_at = |b: &[u8], i: usize| -> u32 {
        let v = [b[i], b[i + 1], b[i + 2], b[i + 3]];
        if big { u32::from_be_bytes(v) } else { u32::from_le_bytes(v) }
    };

    let ifd = u32_at(tiff, 4) as usize;
    if ifd + 2 > tiff.len() {
        return 1;
    }
    let count = u16_at(tiff, ifd) as usize;
    for i in 0..count {
        let entry = ifd + 2 + i * 12;
        if entry + 12 > tiff.len() {
            return 1;
        }
        if u16_at(tiff, entry) == 0x0112 {
            let value = u16_at(tiff, entry + 8);
            return if (1..=8).contains(&value) { value } else { 1 };
        }
    }
    1
}

/// Turn a decoded image the right way up for an EXIF orientation.
///
/// Only the four rotations are handled; the mirrored orientations (2, 4, 5, 7)
/// come from flatbed scanners and effectively never off a phone, so they pass
/// through rather than earning a transform nobody will see.
fn oriented(image: &CGImage, orientation: u16) -> Result<CFRetained<CGImage>, String> {
    let w = CGImage::width(Some(image)) as f64;
    let h = CGImage::height(Some(image)) as f64;
    let quarter = std::f64::consts::FRAC_PI_2;
    // A quarter turn swaps the output's width and height.
    let (out_w, out_h) = match orientation {
        6 | 8 => (h, w),
        _ => (w, h),
    };

    let ctx = bitmap(out_w as usize, out_h as usize)?;
    match orientation {
        3 => {
            CGContext::translate_ctm(Some(&ctx), out_w, out_h);
            CGContext::rotate_ctm(Some(&ctx), std::f64::consts::PI);
        }
        // Core Graphics has a bottom-left origin and rotates counter-clockwise
        // for positive angles, so these run the opposite way round to the
        // top-left, clockwise convention EXIF is written in. Verified against a
        // real orientation-6 phone photo rather than reasoned about: the other
        // pairing renders upside down.
        6 => {
            CGContext::translate_ctm(Some(&ctx), 0.0, out_h);
            CGContext::rotate_ctm(Some(&ctx), -quarter);
        }
        8 => {
            CGContext::translate_ctm(Some(&ctx), out_w, 0.0);
            CGContext::rotate_ctm(Some(&ctx), quarter);
        }
        _ => {}
    }
    CGContext::draw_image(
        Some(&ctx),
        CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w, h)),
        Some(image),
    );
    CGBitmapContextCreateImage(Some(&ctx)).ok_or_else(|| "could not read back the rotation".into())
}

/// Decode via ImageIO, choosing where the thumbnail comes from.
///
/// `prefer_embedded` is the difference between a whole file and the front of
/// one. `...FromImageAlways` decodes the full-size image and ignores any
/// embedded thumbnail, which is right for a local file and catastrophic for a
/// 256 KB head: it renders the sliver of the photo that arrived. `IfAbsent`
/// uses the embedded thumbnail, which is the whole picture at small size.
fn image_io_opts(path: &Path, max_px: u32, out: &Path, prefer_embedded: bool) -> Result<(), String> {
    let image = image_io_thumbnail(path, max_px, prefer_embedded)?;
    write_png(&image, out)
}

/// Decode a whole image file to at most `max_px`, without writing it anywhere.
fn image_io_image(path: &Path, max_px: u32) -> Result<CFRetained<CGImage>, String> {
    image_io_thumbnail(path, max_px, false)
}

fn image_io_thumbnail(
    path: &Path,
    max_px: u32,
    prefer_embedded: bool,
) -> Result<CFRetained<CGImage>, String> {
    let url = CFURL::from_file_path(path).ok_or("unrepresentable path")?;
    let src = unsafe { CGImageSource::with_url(&url, None) }.ok_or("not a readable image")?;

    let keys: [&CFString; 4] = unsafe {
        [
            if prefer_embedded {
                kCGImageSourceCreateThumbnailFromImageIfAbsent
            } else {
                kCGImageSourceCreateThumbnailFromImageAlways
            },
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

    unsafe { src.thumbnail_at_index(0, Some(opts.as_ref())) }
        .ok_or_else(|| "ImageIO produced no thumbnail".to_string())
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

/// An RGBA bitmap of `w`×`h` device pixels, ready to draw into. Premultiplied
/// BGRA is the layout the window server and ImageIO both want, so nothing has to
/// swizzle the bytes on the way back out.
pub fn bitmap(w: usize, h: usize) -> Result<CFRetained<CGContext>, String> {
    const PREMULTIPLIED_FIRST: u32 = 2;
    const BYTE_ORDER_32_LITTLE: u32 = 2 << 12;

    extern "C-unwind" {
        fn CGBitmapContextCreate(
            data: *mut std::ffi::c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: Option<&CGColorSpace>,
            bitmap_info: u32,
        ) -> Option<std::ptr::NonNull<CGContext>>;
    }

    if w == 0 || h == 0 {
        return Err("empty bitmap".into());
    }
    let space = CGColorSpace::new_device_rgb().ok_or("no device RGB colour space")?;
    // A zero row stride lets Core Graphics pick its own alignment, which is
    // faster than any stride we'd compute by hand.
    let ctx = unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            w,
            h,
            8,
            0,
            Some(&space),
            PREMULTIPLIED_FIRST | BYTE_ORDER_32_LITTLE,
        )
    }
    .ok_or("could not create a bitmap context")?;
    Ok(unsafe { CFRetained::from_raw(ctx) })
}

/// Snapshot a bitmap context and write it to the cache.
pub fn save(ctx: &CGContext, out: &Path) -> Result<(), String> {
    let image = CGBitmapContextCreateImage(Some(ctx)).ok_or("could not read back the bitmap")?;
    write_png(&image, out)
}

/// Fill the whole context with one colour.
pub fn wash(ctx: &CGContext, w: f64, h: f64, gray: f64) {
    CGContext::set_fill_color_with_color(Some(ctx), Some(&CGColor::new_generic_gray(gray, 1.0)));
    CGContext::fill_rect(
        Some(ctx),
        CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w, h)),
    );
}

/// Write a CGImage out as PNG, via a unique temp name so a half-written file is
/// never visible under the cache key — two workers can race on the same key, and
/// the webview reads these paths directly.
pub fn write_png(image: &CGImage, out: &Path) -> Result<(), String> {
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
        assert!(can_thumbnail(Path::new("/a/b/main.rs")));
        assert!(can_thumbnail(Path::new("/a/b/Makefile")));
        assert!(!can_thumbnail(Path::new("/a/b/archive.zip")));
        assert!(!can_thumbnail(Path::new("/a/b/mystery")));
    }

    #[test]
    fn every_renderer_gets_its_own_lane() {
        assert_eq!(lane_of(Path::new("/a/IMG_0001.heic")), Lane::Raster);
        assert_eq!(lane_of(Path::new("/a/shot.CR2")), Lane::Raster);
        assert_eq!(lane_of(Path::new("/a/paper.pdf")), Lane::Page);
        assert_eq!(lane_of(Path::new("/a/deck.key")), Lane::QuickLook);
        assert_eq!(lane_of(Path::new("/a/notes.txt")), Lane::Text);
        assert_eq!(lane_of(Path::new("/a/README.md")), Lane::Text);
        assert_eq!(lane_of(Path::new("/a/.gitignore")), Lane::Text);
        assert_eq!(lane_of(Path::new("/a/data.bin")), Lane::None);
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
        assert_eq!(
            ext_of(Path::new("/a/IMG_0001.HEIC")).as_deref(),
            Some("heic")
        );
        assert_eq!(ext_of(Path::new("/a/noext")), None);
    }

    #[test]
    fn cache_keys_track_size_and_content() {
        let f = std::env::temp_dir().join("fiddler-cache-key-probe.txt");
        std::fs::write(&f, b"one").unwrap();
        let a = cache_path(&f, 128).unwrap();
        assert_ne!(
            a,
            cache_path(&f, 256).unwrap(),
            "requested size must key the cache"
        );
        std::fs::write(&f, b"a different length").unwrap();
        assert_ne!(
            a,
            cache_path(&f, 128).unwrap(),
            "edits must invalidate the cache"
        );
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn a_device_object_keys_the_cache_the_same_way_a_file_does() {
        // A phone's photos have no `stat`, so their mtime and size arrive from
        // the listing instead. The key must still turn on all four inputs, or
        // a replaced photo would show its predecessor's thumbnail forever.
        let p = Path::new("mtp://RFCY71NMVTA/65537/DCIM/Camera/20260727_102034.jpg");
        let base = keyed_with(p, 128, 0, 1_786_348_440, 7_828_774);

        assert_eq!(base, keyed_with(p, 128, 0, 1_786_348_440, 7_828_774), "same inputs, same file");
        assert_ne!(base, keyed_with(p, 256, 0, 1_786_348_440, 7_828_774), "requested size must key it");
        assert_ne!(base, keyed_with(p, 128, 0, 1_786_348_441, 7_828_774), "a newer mtime must key it");
        assert_ne!(base, keyed_with(p, 128, 0, 1_786_348_440, 7_828_775), "a changed size must key it");

        let other = Path::new("mtp://RFCY71NMVTA/65537/DCIM/Camera/20260518_162248.jpg");
        assert_ne!(base, keyed_with(other, 128, 0, 1_786_348_440, 7_828_774), "two photos are two keys");
    }


    #[test]
    fn exif_orientation_is_read_from_the_parent_file() {
        // An embedded thumbnail carries no EXIF of its own, so the tag has to
        // come out of the photo around it. Build a minimal little-endian APP1.
        fn jpeg_with_orientation(value: u16) -> Vec<u8> {
            let mut tiff = Vec::new();
            tiff.extend_from_slice(b"II");                        // little-endian
            tiff.extend_from_slice(&42u16.to_le_bytes());         // magic
            tiff.extend_from_slice(&8u32.to_le_bytes());          // IFD0 at offset 8
            tiff.extend_from_slice(&1u16.to_le_bytes());          // one entry
            tiff.extend_from_slice(&0x0112u16.to_le_bytes());     // Orientation
            tiff.extend_from_slice(&3u16.to_le_bytes());          // SHORT
            tiff.extend_from_slice(&1u32.to_le_bytes());          // count
            tiff.extend_from_slice(&value.to_le_bytes());         // value, then pad
            tiff.extend_from_slice(&[0, 0]);

            let payload = [b"Exif\0\0".as_ref(), &tiff].concat();
            let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
            out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
            out.extend_from_slice(&payload);
            out
        }

        // 6 is the common one: a phone held upright.
        assert_eq!(exif_orientation(&jpeg_with_orientation(6)), 6);
        assert_eq!(exif_orientation(&jpeg_with_orientation(1)), 1);
        assert_eq!(exif_orientation(&jpeg_with_orientation(8)), 8);
        // Out-of-range values are not trusted into the rotation table.
        assert_eq!(exif_orientation(&jpeg_with_orientation(99)), 1);

        // Anything without usable EXIF reads as upright rather than erroring:
        // a missing tag must never stop a thumbnail being drawn.
        assert_eq!(exif_orientation(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), 1);
        assert_eq!(exif_orientation(&[]), 1);
        assert_eq!(exif_orientation(&[0xFF, 0xD8]), 1);
        // A length that runs off the end of a truncated file must not panic.
        assert_eq!(exif_orientation(&[0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0x00]), 1);
    }

    #[test]
    fn a_quarter_turn_swaps_the_thumbnail_dimensions() {
        // Cheap proof that the rotation actually transposes rather than just
        // redrawing: a portrait photo must not come back landscape.
        let ctx = bitmap(40, 20).unwrap();
        wash(&ctx, 40.0, 20.0, 0.5);
        let wide = CGBitmapContextCreateImage(Some(&ctx)).unwrap();
        assert_eq!(CGImage::width(Some(&wide)), 40);

        for turned in [6, 8] {
            let out = oriented(&wide, turned).unwrap();
            assert_eq!(CGImage::width(Some(&out)), 20, "orientation {turned}");
            assert_eq!(CGImage::height(Some(&out)), 40, "orientation {turned}");
        }
        // A half turn keeps them.
        let flipped = oriented(&wide, 3).unwrap();
        assert_eq!(CGImage::width(Some(&flipped)), 40);
    }

    #[test]
    fn a_video_asks_the_device_rather_than_reading_its_head() {
        // An mp4 keeps nothing an image decoder can use near the front, so the
        // head is never even fetched: `plan_source` is handed None for it and
        // must route to the device. Getting this wrong costs 256 KB per tile
        // and still draws a glyph.
        assert_eq!(plan_source(Lane::QuickLook, None), Source::Device);
        // A PDF is the same story: its page objects can sit anywhere in the file.
        assert_eq!(plan_source(Lane::Page, None), Source::Device);
    }

    #[test]
    fn a_photo_takes_the_cheap_route_and_falls_back_when_it_cannot() {
        // A short read means the whole file arrived, so decode it directly.
        assert_eq!(plan_source(Lane::Raster, Some(&[0xFF, 0xD8, 0x11])), Source::Whole);

        // A full-length read means the file was cut. Drawable only if the head
        // carries a complete embedded thumbnail...
        let mut with_thumb = vec![0xFF, 0xD8, 0xFF, 0xE1];
        with_thumb.extend_from_slice(&[0xFF, 0xD8]);
        with_thumb.extend_from_slice(b"thumb");
        with_thumb.extend_from_slice(&[0xFF, 0xD9]);
        with_thumb.resize(USB_HEAD_BYTES as usize, 0x42);
        assert_eq!(plan_source(Lane::Raster, Some(&with_thumb)), Source::Embedded);

        // ...and otherwise the device is the last resort, rather than rendering
        // the fragment that arrived.
        let no_thumb = vec![0x42; USB_HEAD_BYTES as usize];
        assert_eq!(plan_source(Lane::Raster, Some(&no_thumb)), Source::Device);
    }

    #[test]
    fn text_is_drawn_from_its_head_however_long_the_file_is() {
        // A source file is a page of its first lines by design, so a truncated
        // read is not a problem to route around — it is the whole idea.
        let long = vec![b'x'; USB_HEAD_BYTES as usize];
        assert_eq!(plan_source(Lane::Text, Some(&long)), Source::Whole);
        assert_eq!(plan_source(Lane::Text, Some(b"short file")), Source::Whole);
    }

    #[test]
    fn a_truncated_photo_is_only_drawable_via_its_embedded_thumbnail() {
        // The bug this exists to prevent: ImageIO asked to build a thumbnail
        // "from image always" decodes whatever part of a truncated JPEG it has
        // and returns a photo that fades to blank part way down. A head is only
        // drawable when it carries a complete embedded thumbnail — SOI to EOI —
        // and that is what we must be able to detect.
        let mut head = vec![0xFF, 0xD8, 0xFF, 0xE1]; // outer SOI + APP1
        head.extend_from_slice(&[0x00; 12]);
        let thumb_start = head.len();
        head.extend_from_slice(&[0xFF, 0xD8]); // the thumbnail's own SOI
        head.extend_from_slice(b"thumbnail pixels");
        head.extend_from_slice(&[0xFF, 0xD9]); // and its EOI
        let tail_start = head.len();
        head.extend_from_slice(&[0x42; 64]); // the main image, cut off

        let found = embedded_thumbnail(&head).expect("a complete embedded thumbnail");
        // The slice is a JPEG in its own right: its own SOI, its payload, its EOI.
        assert_eq!(found.len(), tail_start - thumb_start);
        assert_eq!(&found[..2], &[0xFF, 0xD8]);
        assert_eq!(&found[found.len() - 2..], &[0xFF, 0xD9]);
        assert!(found[2..].starts_with(b"thumbnail pixels"));
        // And it stops at the thumbnail: none of the truncated main image.
        assert!(!found.contains(&0x42));

        // A head whose thumbnail was itself cut off must not be drawn: this is
        // exactly the 4 MB photo where 256 KB was not enough.
        let cut = &head[..thumb_start + 8];
        assert!(embedded_thumbnail(cut).is_none(), "an incomplete thumbnail is not usable");

        // Nor may a bare truncated JPEG with no embedded thumbnail at all.
        let bare = [&[0xFF, 0xD8, 0xFF, 0xE0][..], &[0x11; 200]].concat();
        assert!(embedded_thumbnail(&bare).is_none(), "no nested SOI means nothing to draw");
    }

    #[test]
    fn a_device_path_never_falls_through_to_a_filesystem_stat() {
        // `cache_path` would try to stat the literal string "mtp://…" and fail.
        // The device branch has to claim the path first, and report "no listing
        // yet" as a miss it owns rather than letting it escape.
        let device = Path::new("mtp://SERIAL/1/DCIM/never-listed.jpg");
        assert!(cache_path(device, 128).is_err(), "a device path has nothing to stat");
        assert!(
            usb_cache_path(device, 128).is_some(),
            "the device branch must claim it rather than deferring"
        );
        assert!(usb_cache_path(Path::new("/etc/hosts"), 128).is_none(), "local paths are not claimed");
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

