//! Launch Android's package installer for a user-selected APK.
//!
//! The generic opener deliberately has no package-archive special case. Android
//! requires a content URI with a temporary read grant, so this tiny JNI bridge
//! delegates that sensitive platform interaction to the app's Kotlin code.

use std::path::Path;

#[cfg(target_os = "android")]
pub fn install(path: &Path) -> Result<(), String> {
    use jni::objects::{JObject, JString, JValue};

    if !path.is_file() {
        return Err("the APK no longer exists or is not a file".into());
    }

    crate::android_jni::with_env(|env| {
        let installer = crate::android_jni::class(env, "app.fiddler.desktop.ApkInstaller")?;
        let context = crate::android_jni::context()?;
        let path = env
            .new_string(path.to_string_lossy().as_ref())
            .map_err(|e| format!("couldn't encode APK path: {e}"))?;
        let result = env
            .call_static_method(
                installer,
                "install",
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(context.as_obj()),
                    JValue::Object(&JObject::from(path)),
                ],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("couldn't start APK installer: {e}"))?;

        if result.is_null() {
            return Ok(());
        }
        let message: String = env
            .get_string(&JString::from(result))
            .map_err(|e| format!("couldn't read APK installer response: {e}"))?
            .into();
        Err(message)
    })
}

#[cfg(not(target_os = "android"))]
pub fn install(_path: &Path) -> Result<(), String> {
    Err("APK installation is only available on Android".into())
}
