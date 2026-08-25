//! Mobile thumbnail policy.
//!
//! Tiles used to be the original file handed straight to the WebView, which
//! meant decoding full-resolution photos into 128px squares — and no tiles at
//! all for HEIF, the format Samsung cameras actually shoot. Now `Thumbs.kt`
//! decodes through `ImageDecoder`, downscaling during decode and honouring
//! EXIF orientation, and caches a WebView-ready JPEG/PNG in the app cache
//! keyed by path, size, mtime and requested pixels — the same shape the
//! desktop cache has.
//!
//! Where the platform decoder refuses a file but the WebView could have shown
//! the original (an odd ICO, a truncated GIF), the original path is still the
//! fallback rather than a dead tile.

use std::path::{Path, PathBuf};

/// What `ImageDecoder` can decode into a tile. AVIF requires API 31 and HEIF
/// API 28; below those the decode fails and falls back (or the tile stays a
/// glyph, which is the honest answer for a format the device cannot read).
const DECODABLE: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "gif", "bmp", "webp", "avif", "heic", "heif", "ico",
];

/// What the WebView can draw as-is, for the fallback path. HEIF deliberately
/// absent: the WebView cannot decode it, so a broken-image tile is all a
/// passthrough could produce.
const WEBVIEW_RASTER: &[&str] = &["png", "jpg", "jpeg", "jpe", "gif", "bmp", "webp", "avif", "ico"];

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Text,
    Raster,
    Page,
    QuickLook,
    None,
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

pub fn lane_of(path: &Path) -> Lane {
    match extension_of(path).as_deref() {
        Some(ext) if DECODABLE.contains(&ext) => Lane::Raster,
        _ => Lane::None,
    }
}

pub fn can_thumbnail(path: &Path) -> bool {
    lane_of(path) == Lane::Raster
}

/// Nothing is answered synchronously: the cache lives on the Kotlin side, and
/// asking it means a JNI hop that belongs on the raster lane, not on the
/// request path. A cache hit over there is one `stat`.
pub fn cached(_path: &Path, _max_px: u32) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "android")]
pub fn generate(path: &Path, max_px: u32) -> Result<PathBuf, String> {
    if lane_of(path) != Lane::Raster || !path.is_file() {
        return Err("no mobile preview available for this file type".into());
    }
    match call_render(path, max_px.clamp(32, 4096)) {
        Ok(rendered) => Ok(PathBuf::from(rendered)),
        Err(error) => {
            // The decoder refused it; the WebView may still manage the original.
            if extension_of(path).as_deref().is_some_and(|ext| WEBVIEW_RASTER.contains(&ext)) {
                Ok(path.to_path_buf())
            } else {
                Err(error)
            }
        }
    }
}

/// The web-in-a-tab build compiles this file too (`#[path]` in lib.rs picks it
/// per platform), and has no JNI to reach; it never calls this at runtime.
#[cfg(not(target_os = "android"))]
pub fn generate(path: &Path, _max_px: u32) -> Result<PathBuf, String> {
    if lane_of(path) == Lane::Raster && path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err("no mobile preview available for this file type".into())
    }
}

#[cfg(target_os = "android")]
fn call_render(path: &Path, max_px: u32) -> Result<String, String> {
    use jni::objects::{JObject, JString, JValue};

    crate::android_jni::with_env(|env| {
        let class = crate::android_jni::class(env, "app.fiddler.desktop.Thumbs")?;
        let context = crate::android_jni::context()?;
        let encoded = env
            .new_string(path.to_string_lossy().as_ref())
            .map_err(|e| format!("couldn't encode image path: {e}"))?;
        let encoded = JObject::from(encoded);
        let result = env
            .call_static_method(
                class,
                "render",
                "(Landroid/content/Context;Ljava/lang/String;I)Ljava/lang/String;",
                &[
                    JValue::Object(context.as_obj()),
                    JValue::Object(&encoded),
                    JValue::Int(max_px as i32),
                ],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("couldn't render a thumbnail: {e}"))?;
        if result.is_null() {
            return Err("this image couldn't be decoded".into());
        }
        let result = JString::from(result);
        let result: String = env
            .get_string(&result)
            .map_err(|e| format!("couldn't read the thumbnail path: {e}"))?
            .into();
        Ok(result)
    })
}

/// Kept for the PDF command's shared interface. PDF page rasterisation is not
/// available in the Android backend yet; callers receive a clear error instead
/// of attempting to link Apple-only frameworks.
#[allow(dead_code)]
pub fn keyed(_path: &Path, _max_px: u32, _variant: u64) -> Result<PathBuf, String> {
    Err("PDF rendering is not available on Android yet; open the file in a PDF app".into())
}
