//! Android's Back button, borrowed by the front end.
//!
//! Two directions, and they are deliberately asymmetric. Going *out* — "I have
//! somewhere to go, hold the press for me" — is a command, because it is the
//! front end changing its mind and it must not be lost. Coming *in* is an
//! event with no payload, for the same reason `opened.rs` carries none: what to
//! do with a press is decided entirely by front-end state, and a payload would
//! only be a second, staler copy of it.
//!
//! The default is Android's own. Until the front end asks, Back closes Fiddler
//! — which is what should happen if the webview never boots.

/// Tell Android whether Fiddler wants the next Back press.
pub use imp::set_enabled;

/// Remember the handle the incoming press is emitted on.
pub use imp::remember;

#[cfg(target_os = "android")]
mod imp {
    use std::sync::OnceLock;

    use jni::objects::{JClass, JValue};
    use jni::JNIEnv;
    use tauri::{AppHandle, Emitter};

    /// Where the press is delivered. Payload-free by design; see the module doc.
    const BACK_EVENT: &str = "fiddler:back";

    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn remember(app: AppHandle) {
        let _ = APP.set(app);
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        crate::android_jni::with_env(|env| {
            let gesture = crate::android_jni::class(env, "app.fiddler.desktop.BackGesture")?;
            let context = crate::android_jni::context()?;
            env.call_static_method(
                gesture,
                "setEnabled",
                "(Landroid/app/Activity;Z)V",
                &[JValue::Object(context.as_obj()), JValue::Bool(enabled.into())],
            )
            .map(|_| ())
            .map_err(|e| format!("couldn't set the Back handler: {e}"))
        })
    }

    /// Called from `BackGesture.kt` on the main thread.
    ///
    /// # Safety
    /// Invoked by the JVM with a live env and no arguments to read. Nothing
    /// here can fail in a way worth aborting the process for: a press that
    /// arrives before `setup` has run has no window to reach, and is dropped.
    #[no_mangle]
    pub extern "system" fn Java_app_fiddler_desktop_NativeBridge_back(
        _env: JNIEnv,
        _class: JClass,
    ) {
        if let Some(app) = APP.get() {
            let _ = app.emit(BACK_EVENT, ());
        }
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use tauri::AppHandle;

    pub fn remember(_app: AppHandle) {}

    /// No other platform has a system Back to lend. Silently accepted rather
    /// than refused: the front end enables this whenever it has history, and
    /// that is true on every platform — only Android has anywhere to send it.
    pub fn set_enabled(_enabled: bool) -> Result<(), String> {
        Ok(())
    }
}
