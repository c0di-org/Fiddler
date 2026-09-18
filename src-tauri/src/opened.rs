//! Locations another app, the desktop shell, or D-Bus asked Fiddler to show.
//!
//! The queue is the truth and the event is only a hint. Requests that arrive
//! before the webview exists simply wait and are collected during bootstrap.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const OPENED_EVENT: &str = "fiddler:opened-location";
static PENDING: Mutex<Vec<IncomingLocation>> = Mutex::new(Vec::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingLocation {
    pub path: String,
    /// Select the item in its parent rather than opening it as the current folder.
    pub select: bool,
    /// Open Quick Look after selecting it.
    pub preview: bool,
}

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn take() -> Vec<IncomingLocation> {
    PENDING
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

pub fn push(locations: impl IntoIterator<Item = IncomingLocation>) {
    let found: Vec<_> = locations.into_iter().collect();
    if found.is_empty() {
        return;
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.extend(found);
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(OPENED_EVENT, ());
    }
}

pub fn from_inputs(
    inputs: impl IntoIterator<Item = String>,
    cwd: Option<&Path>,
    preview_files: bool,
) -> Vec<IncomingLocation> {
    inputs
        .into_iter()
        .filter(|input| !input.starts_with("--"))
        .filter_map(|input| local_path(&input, cwd))
        .filter(|path| path.exists())
        .map(|path| {
            let select = !path.is_dir();
            IncomingLocation {
                path: path.to_string_lossy().into_owned(),
                select,
                preview: select && preview_files,
            }
        })
        .collect()
}

fn local_path(input: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    if input.starts_with("file:") {
        return url::Url::parse(input).ok()?.to_file_path().ok();
    }
    let path = PathBuf::from(input);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(cwd.unwrap_or_else(|| Path::new(".")).join(path))
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JObjectArray, JString};
    use jni::JNIEnv;

    use super::{push, IncomingLocation};

    #[no_mangle]
    pub extern "system" fn Java_app_fiddler_desktop_NativeBridge_opened(
        mut env: JNIEnv,
        _class: JClass,
        paths: JObjectArray,
    ) {
        let Ok(count) = env.get_array_length(&paths) else {
            return;
        };
        let mut found = Vec::with_capacity(count.max(0) as usize);
        for i in 0..count {
            let Ok(item) = env.get_object_array_element(&paths, i) else {
                continue;
            };
            if item.is_null() {
                continue;
            }
            if let Ok(path) = env.get_string(&JString::from(item)) {
                found.push(IncomingLocation {
                    path: String::from(path),
                    select: true,
                    preview: true,
                });
            }
        }
        push(found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_become_local_paths() {
        let dir = std::env::temp_dir();
        let encoded = url::Url::from_file_path(&dir).unwrap().to_string();
        assert_eq!(local_path(&encoded, None).unwrap(), dir);
    }

    #[test]
    fn flags_are_not_treated_as_paths() {
        let found = from_inputs(["--gapplication-service".into()], None, false);
        assert!(found.is_empty());
    }
}
