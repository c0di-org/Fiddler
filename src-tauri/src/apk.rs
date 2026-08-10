//! Launch Android's package installer for a user-selected APK.
//!
//! The generic opener deliberately has no package-archive special case. Android
//! requires a content URI with a temporary read grant, so this tiny JNI bridge
//! delegates that sensitive platform interaction to the app's Kotlin code.

use std::path::Path;

#[cfg(target_os = "android")]
pub fn install(path: &Path) -> Result<(), String> {
    use jni::{
        objects::{JClass, JObject, JString, JValue},
        JavaVM,
    };

    if !path.is_file() {
        return Err("the APK no longer exists or is not a file".into());
    }

    // Tauri creates the Android context before Rust enters `run`. Commands run
    // on workers, so attach only for this JNI call.
    let vm = unsafe { JavaVM::from_raw(ndk_context::android_context().vm().cast()) }
        .map_err(|e| format!("Android VM unavailable: {e}"))?;
    let mut env = vm
        .attach_current_thread_as_daemon()
        .map_err(|e| format!("couldn't attach APK installer worker: {e}"))?;

    // A worker thread's class loader cannot see app classes through FindClass.
    // Resolve it through the Activity's loader instead.
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let context_class = env
        .call_method(&context, "getClass", "()Ljava/lang/Class;", &[])
        .and_then(|v| v.l())
        .map_err(|e| format!("couldn't find Android context class: {e}"))?;
    let loader = env
        .call_method(
            &context_class,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("couldn't get Android class loader: {e}"))?;
    let class_name = env
        .new_string("app.fiddler.desktop.ApkInstaller")
        .map_err(|e| format!("couldn't create APK installer bridge name: {e}"))?;
    let installer = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&JObject::from(class_name))],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("couldn't load APK installer bridge: {e}"))?;
    let installer = JClass::from(installer);
    let path = env
        .new_string(path.to_string_lossy().as_ref())
        .map_err(|e| format!("couldn't encode APK path: {e}"))?;
    let result = env
        .call_static_method(
            installer,
            "install",
            "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(&context),
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
}

#[cfg(not(target_os = "android"))]
pub fn install(_path: &Path) -> Result<(), String> {
    Err("APK installation is only available on Android".into())
}
