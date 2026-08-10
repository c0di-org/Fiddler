//! Mobile thumbnail policy.
//!
//! Android's WebView can decode ordinary image files itself, but it does not
//! expose a native equivalent of macOS Quick Look or Core Text to Rust. Return
//! image paths directly so `convertFileSrc` can serve them through Tauri's asset
//! protocol; everything else keeps its normal file glyph and can be opened in a
//! system app. This is intentionally cheap and avoids copying full-resolution
//! photos into the app cache just to display a small tile.

use std::path::{Path, PathBuf};

const RASTER: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "gif", "bmp", "webp", "avif", "heic", "heif", "ico", "tif", "tiff",
];

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Text,
    Raster,
    Page,
    QuickLook,
    None,
}

pub fn lane_of(path: &Path) -> Lane {
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    match extension.as_deref() {
        Some(ext) if RASTER.contains(&ext) => Lane::Raster,
        _ => Lane::None,
    }
}

pub fn can_thumbnail(path: &Path) -> bool {
    lane_of(path) == Lane::Raster
}

/// A raster file is already a WebView-ready preview on mobile.
pub fn cached(path: &Path, _max_px: u32) -> Option<PathBuf> {
    (lane_of(path) == Lane::Raster && path.is_file()).then(|| path.to_path_buf())
}

pub fn generate(path: &Path, _max_px: u32) -> Result<PathBuf, String> {
    cached(path, 0).ok_or_else(|| "no mobile preview available for this file type".into())
}

/// Kept for the PDF command's shared interface. PDF page rasterisation is not
/// available in the Android backend yet; callers receive a clear error instead
/// of attempting to link Apple-only frameworks.
#[allow(dead_code)]
pub fn keyed(_path: &Path, _max_px: u32, _variant: u64) -> Result<PathBuf, String> {
    Err("PDF rendering is not available on Android yet; open the file in a PDF app".into())
}
