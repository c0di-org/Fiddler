//! PDF rendering uses Core Graphics on macOS. Android opens PDFs externally
//! until a portable renderer is introduced.

use std::path::{Path, PathBuf};

pub struct Meta {
    pub pages: u32,
    pub aspect: f64,
}

fn unavailable<T>() -> Result<T, String> {
    Err("PDF previews are not available on Android yet; open the file in a PDF app".into())
}

pub fn meta(_path: &Path) -> Result<Meta, String> {
    unavailable()
}

#[allow(dead_code)]
pub fn render(_path: &Path, _page: u32, _max_px: u32, _out: &Path) -> Result<(), String> {
    unavailable()
}

pub fn cached_render(_path: &Path, _page: u32, _max_px: u32) -> Result<PathBuf, String> {
    unavailable()
}
