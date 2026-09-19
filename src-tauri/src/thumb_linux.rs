//! Linux raster thumbnails using the freedesktop.org thumbnail cache.
//!
//! The cache belongs to the desktop, not to Fiddler: file managers and file
//! choosers can reuse the PNGs we write, and Fiddler can reuse theirs.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use gdk_pixbuf::Pixbuf;
use glib::{Checksum, ChecksumType};

const RASTER: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "gif", "bmp", "webp", "avif", "heic", "heif", "ico",
    "tif", "tiff",
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

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
}

pub fn lane_of(path: &Path) -> Lane {
    match extension_of(path).as_deref() {
        Some(ext) if RASTER.contains(&ext) => Lane::Raster,
        _ => Lane::None,
    }
}

pub fn can_thumbnail(path: &Path) -> bool {
    lane_of(path) == Lane::Raster
}

struct Source {
    uri: String,
    mtime: String,
    size: String,
}

fn source(path: &Path) -> Option<Source> {
    let canonical = path.canonicalize().ok()?;
    let meta = fs::metadata(&canonical).ok()?;
    if !meta.is_file() {
        return None;
    }
    let uri = url::Url::from_file_path(&canonical).ok()?.to_string();
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        .to_string();
    Some(Source {
        uri,
        mtime,
        size: meta.len().to_string(),
    })
}

fn tier(max_px: u32) -> Option<(&'static str, i32)> {
    match max_px {
        0..=128 => Some(("normal", 128)),
        129..=256 => Some(("large", 256)),
        257..=512 => Some(("x-large", 512)),
        513..=1024 => Some(("xx-large", 1024)),
        _ => None,
    }
}

fn thumbnail_root() -> Option<PathBuf> {
    dirs::cache_dir().map(|cache| cache.join("thumbnails"))
}

fn thumbnail_path(path: &Path, max_px: u32) -> Option<(PathBuf, Source, i32)> {
    let (bucket, pixels) = tier(max_px)?;
    let source = source(path)?;
    let mut checksum = Checksum::new(ChecksumType::Md5)?;
    checksum.update(source.uri.as_bytes());
    let hash = checksum.string()?;
    let root = thumbnail_root()?;
    Some((root.join(bucket).join(format!("{hash}.png")), source, pixels))
}

fn valid_cached(path: &Path, source: &Source) -> bool {
    let Ok(pixbuf) = Pixbuf::from_file(path) else {
        return false;
    };
    pixbuf
        .option("tEXt::Thumb::URI")
        .is_some_and(|value| value.as_str() == source.uri)
        && pixbuf
            .option("tEXt::Thumb::MTime")
            .is_some_and(|value| value.as_str() == source.mtime)
        && pixbuf
            .option("tEXt::Thumb::Size")
            .is_none_or(|value| value.as_str() == source.size)
}

pub fn cached(path: &Path, max_px: u32) -> Option<PathBuf> {
    // Full-screen previews deliberately use the original file. The standard
    // shared cache tops out at 1024px, and the asset protocol is scoped to the
    // folder the user is browsing.
    if max_px > 1024 && path.is_file() {
        return Some(path.to_path_buf());
    }

    let (thumb, source, _) = thumbnail_path(path, max_px)?;
    valid_cached(&thumb, &source).then_some(thumb)
}

pub fn generate(path: &Path, max_px: u32) -> Result<PathBuf, String> {
    if lane_of(path) != Lane::Raster || !path.is_file() {
        return Err("no Linux image preview available for this file type".into());
    }

    if max_px > 1024 {
        return Ok(path.to_path_buf());
    }

    let (thumb, source, pixels) =
        thumbnail_path(path, max_px).ok_or("couldn't determine the thumbnail cache path")?;

    if valid_cached(&thumb, &source) {
        return Ok(thumb);
    }

    // The standard says not to thumbnail the thumbnail cache itself.
    if let Some(root) = thumbnail_root() {
        if path.starts_with(&root) {
            return Ok(path.to_path_buf());
        }
    }

    // Small originals cost less to let WebKit draw directly than to make an
    // equal-sized duplicate in the cache.
    if let Some((_, width, height)) = Pixbuf::file_info(path) {
        if width <= pixels && height <= pixels {
            return Ok(path.to_path_buf());
        }
    }

    let parent = thumb.parent().ok_or("thumbnail path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;

    let loaded = Pixbuf::from_file_at_scale(path, pixels, pixels, true)
        .map_err(|e| format!("couldn't decode image: {e}"))?;
    let pixbuf = loaded.apply_embedded_orientation().unwrap_or(loaded);

    let temporary = parent.join(format!(
        ".fiddler-{}-{}.png",
        std::process::id(),
        thumb.file_stem().and_then(|stem| stem.to_str()).unwrap_or("thumb")
    ));
    pixbuf
        .savev(
            &temporary,
            "png",
            &[
                ("tEXt::Thumb::URI", source.uri.as_str()),
                ("tEXt::Thumb::MTime", source.mtime.as_str()),
                ("tEXt::Thumb::Size", source.size.as_str()),
                ("tEXt::Software", "Fiddler"),
            ],
        )
        .map_err(|e| format!("couldn't save thumbnail: {e}"))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    fs::rename(&temporary, &thumb).map_err(|e| e.to_string())?;
    Ok(thumb)
}

#[allow(dead_code)]
pub fn keyed(_path: &Path, _max_px: u32, _variant: u64) -> Result<PathBuf, String> {
    Err("PDF rendering is not available on Linux yet; open the file in a PDF app".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freedesktop_sizes_map_to_the_standard_directories() {
        assert_eq!(tier(96), Some(("normal", 128)));
        assert_eq!(tier(200), Some(("large", 256)));
        assert_eq!(tier(400), Some(("x-large", 512)));
        assert_eq!(tier(900), Some(("xx-large", 1024)));
        assert_eq!(tier(2048), None);
    }
}
