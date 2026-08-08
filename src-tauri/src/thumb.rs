//! Thumbnail generation with an on-disk cache.
//!
//! Two paths: raster formats the `image` crate can decode go through it directly,
//! and everything else (PDF, video, HEIC, Sketch, …) falls back to Quick Look, which
//! is how macOS itself previews arbitrary files. Results are cached by
//! (path, mtime, size) so scrolling back through a folder never re-decodes.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Files larger than this go to Quick Look rather than being decoded in-process,
/// so one enormous TIFF can't balloon our resident memory.
const MAX_INLINE_DECODE: u64 = 32 * 1024 * 1024;

/// Formats `image` decodes and that are worth previewing.
const RASTER: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "tif", "tiff", "webp", "avif", "tga", "dds", "ff",
    "hdr", "exr", "pnm", "pbm", "pgm", "ppm", "qoi",
];

/// Types Quick Look renders well and users expect previews for.
const QUICKLOOK: &[&str] = &[
    "pdf", "heic", "heif", "svg", "mov", "mp4", "m4v", "avi", "mkv", "webm", "psd", "ai", "sketch",
    "key", "pages", "numbers", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "epub", "raw", "cr2",
    "nef", "arw", "dng", "icns", "usdz", "obj", "stl",
];

pub fn can_thumbnail(path: &Path) -> bool {
    match ext_of(path) {
        Some(e) => RASTER.contains(&e.as_str()) || QUICKLOOK.contains(&e.as_str()),
        None => false,
    }
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn cache_root() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    base.join("app.fiddler.desktop").join("thumbnails")
}

/// Produce (or reuse) a thumbnail and return the cached file's path.
pub fn generate(path: &Path, max_px: u32) -> Result<PathBuf, String> {
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
    let key = h.finish();

    let dir = cache_root();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{key:016x}.png"));
    if out.exists() {
        return Ok(out);
    }

    let ext = ext_of(path).unwrap_or_default();
    let inline_ok = RASTER.contains(&ext.as_str()) && meta.len() <= MAX_INLINE_DECODE;

    if inline_ok && decode_and_scale(path, max_px, &out).is_ok() {
        return Ok(out);
    }
    quicklook(path, max_px, &out)?;
    Ok(out)
}

fn decode_and_scale(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    let img = image::open(path).map_err(|e| e.to_string())?;
    // `thumbnail` keeps aspect ratio and uses a fast filter chain tuned for
    // large downscales, which is exactly this workload.
    let small = img.thumbnail(max_px, max_px);
    small.save(out).map_err(|e| e.to_string())
}

fn quicklook(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    // qlmanage writes `<outdir>/<filename>.png`, so give it a private scratch dir
    // and move the single result into place.
    let scratch = out.with_extension("ql");
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;

    let status = Command::new("qlmanage")
        .args(["-t", "-s"])
        .arg(max_px.to_string())
        .arg("-o")
        .arg(&scratch)
        .arg(path)
        .output();

    let result = (|| {
        status.map_err(|e| e.to_string())?;
        let produced = std::fs::read_dir(&scratch)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().map(|e| e == "png").unwrap_or(false))
            .ok_or_else(|| "Quick Look produced no preview".to_string())?;
        std::fs::rename(&produced, out).map_err(|e| e.to_string())
    })();

    std::fs::remove_dir_all(&scratch).ok();
    result
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
    fn missing_files_error_rather_than_panicking() {
        let missing = std::env::temp_dir().join("fiddler-does-not-exist.png");
        std::fs::remove_file(&missing).ok();
        assert!(generate(&missing, 128).is_err());
    }

    #[test]
    fn extensions_are_matched_case_insensitively() {
        assert_eq!(ext_of(Path::new("/a/IMG_0001.HEIC")).as_deref(), Some("heic"));
        assert_eq!(ext_of(Path::new("/a/noext")), None);
    }
}
