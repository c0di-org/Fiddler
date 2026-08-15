//! Files another app asked Fiddler to open.
//!
//! Android delivers these to the Activity as intents, and `OpenedFile.kt`
//! resolves each one to a path off the main thread before handing it here. The
//! paths are pushed rather than fetched, which is what keeps this side free of
//! JNI: the call arrives on a Java thread that already has an env, so nothing
//! here ever has to reach back into Java to ask a question.
//!
//! The list is the truth and the event is only a hint. Files that arrive before
//! the webview exists — a cold start, which is the common case — simply wait,
//! and are collected when the front end boots.

use std::sync::Mutex;

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Collect what has arrived, and clear it.
///
/// Draining rather than peeking is what makes this safe to call from more than
/// one place — at startup, and again on every hint — without opening the same
/// file twice.
pub fn take() -> Vec<String> {
    PENDING
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

#[cfg(target_os = "android")]
mod imp {
    use std::sync::OnceLock;

    use jni::objects::{JClass, JObjectArray, JString};
    use jni::JNIEnv;
    use tauri::{AppHandle, Emitter};

    /// Where the hint is delivered. Carries no payload: the list is collected
    /// by command, so the event cannot go stale or disagree with it.
    const OPENED_EVENT: &str = "fiddler:opened-file";

    /// Set once during `setup`. Files can land before that on a cold start,
    /// which is exactly the case `PENDING` already covers.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn remember(app: AppHandle) {
        let _ = APP.set(app);
    }

    /// Called from `NativeBridge.kt` once the paths have been resolved.
    ///
    /// # Safety
    /// Invoked by the JVM on Kotlin's resolver thread with a live env and a
    /// `String[]`. Anything unreadable in that array is skipped rather than
    /// unwrapped — this runs under `panic = "abort"`, where a bad element would
    /// take the whole app down for one file.
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
                found.push(String::from(path));
            }
        }
        if found.is_empty() {
            return;
        }

        if let Ok(mut pending) = super::PENDING.lock() {
            pending.extend(found);
        }
        if let Some(app) = APP.get() {
            let _ = app.emit(OPENED_EVENT, ());
        }
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use tauri::AppHandle;

    /// Nothing hands a running Fiddler a file to open anywhere else yet. macOS
    /// has `application:openFiles:`, which would land here when it's wired up.
    pub fn remember(_app: AppHandle) {}
}

pub use imp::remember;
