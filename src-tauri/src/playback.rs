//! What is playing, told to the platform — and the platform's controls, told
//! back.
//!
//! Shaped exactly like `back.rs`, and for the same reason: one direction is a
//! command because the front end is asserting something that must not be lost,
//! and the other is an event because a press is a press. What is different is
//! how much rides on it. Back is a convenience. This is the difference between
//! an audiobook app and a webview that stops the moment the screen goes off.
//!
//! On Android, `WryActivity.onPause` calls `WebView.onPause`, which suspends
//! the DOM — and with it any `<audio>` mid-sentence. Locking the phone stops
//! the book. Two things fix that together, and neither is enough alone:
//!
//! 1. A foreground service, started from here, so Android keeps the process
//!    and grants it the media-playback exemption from background limits.
//! 2. `MainActivity` undoing the webview pause while that service is up.
//!
//! The notification and the lock screen controls come along for free with (1),
//! which is the other half of what a book needs: nobody unlocks a phone to
//! skip back fifteen seconds.
//!
//! The payload crosses as JSON rather than a dozen JNI arguments. A twelve-slot
//! signature string is a thing that gets edited wrong once and then fails at
//! run time on a device, with `NoSuchMethodError` in a log nobody is reading.

use serde::{Deserialize, Serialize};

pub use imp::{clear, remember, set};

/// Everything the transport controls need to draw themselves.
///
/// Milliseconds and integers throughout: every media API underneath is integer
/// milliseconds, and rounding once at the edge beats rounding in three places.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub playing: bool,
    /// The chapter.
    pub title: String,
    /// The book.
    pub subtitle: String,
    pub position_ms: i64,
    /// Zero where the file hasn't said yet, which the controls read as unknown.
    pub duration_ms: i64,
    pub speed: f64,
    /// A real path to a picture, not a URL — the platform decodes it itself.
    pub art_path: Option<String>,
    pub can_previous: bool,
    pub can_next: bool,
    /// Seconds, for the labels on the two skip buttons.
    pub skip_back: i64,
    pub skip_forward: i64,
}

#[cfg(target_os = "android")]
mod imp {
    use std::sync::OnceLock;

    use jni::objects::{JClass, JObject, JString, JValue};
    use jni::sys::jlong;
    use jni::JNIEnv;
    use tauri::{AppHandle, Emitter};

    use super::PlaybackState;

    /// Where a transport press is delivered. Unlike `back.rs` this one carries
    /// a payload, because "seek to 1:42:07" cannot be recovered from front-end
    /// state — it is information that only exists in the press.
    const TRANSPORT_EVENT: &str = "fiddler:transport";

    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn remember(app: AppHandle) {
        let _ = APP.set(app);
    }

    pub fn set(state: PlaybackState) -> Result<(), String> {
        let json = serde_json::to_string(&state)
            .map_err(|e| format!("couldn't describe what's playing: {e}"))?;
        call("update", &json)
    }

    pub fn clear() -> Result<(), String> {
        call("stop", "")
    }

    fn call(method: &str, json: &str) -> Result<(), String> {
        crate::android_jni::with_env(|env| {
            let playback = crate::android_jni::class(env, "app.fiddler.desktop.Playback")?;
            let context = crate::android_jni::context()?;
            let payload: JString = env
                .new_string(json)
                .map_err(|e| format!("couldn't encode the playback state: {e}"))?;
            env.call_static_method(
                playback,
                method,
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[
                    JValue::Object(context.as_obj()),
                    JValue::Object(&JObject::from(payload)),
                ],
            )
            .map(|_| ())
            .map_err(|e| format!("couldn't update the playback controls: {e}"))
        })
    }

    /// Called from `Playback.kt`, on whichever thread the press arrived on.
    ///
    /// # Safety
    /// Invoked by the JVM with a live env and one string. A press that arrives
    /// before `setup` has run has no window to reach and is dropped, which is
    /// the right answer: there is nothing playing yet to control.
    #[no_mangle]
    pub extern "system" fn Java_app_fiddler_desktop_NativeBridge_transport(
        mut env: JNIEnv,
        _class: JClass,
        action: JString,
        value: jlong,
    ) {
        let Some(app) = APP.get() else { return };
        let Ok(action) = env.get_string(&action) else {
            return;
        };
        let action: String = action.into();
        let _ = app.emit(
            TRANSPORT_EVENT,
            serde_json::json!({ "action": action, "value": value }),
        );
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use tauri::AppHandle;

    use super::PlaybackState;

    pub fn remember(_app: AppHandle) {}

    /// macOS has a Now Playing widget, and the webview already fills it in from
    /// `navigator.mediaSession` without anything here. The browser build is the
    /// same story with the browser's own controls. So this is accepted and
    /// dropped rather than refused: the front end calls it unconditionally, and
    /// only one platform needs a service started to keep a book alive.
    pub fn set(_state: PlaybackState) -> Result<(), String> {
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        Ok(())
    }
}
