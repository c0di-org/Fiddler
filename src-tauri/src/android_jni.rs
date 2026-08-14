//! The Java side of the process, reachable from a Rust worker thread.
//!
//! Three of Fiddler's Android features are thin bridges to Kotlin — the PDF
//! renderer, the package installer, and files handed over by another app — and
//! all three need the same two things: the `JavaVM`, and this app's `Context`.
//!
//! `ndk_context` is the usual way to ask for those, and it is the wrong one
//! here: it is populated by `ndk-glue`, which a Tauri app does not use. Nothing
//! in the tree ever calls `initialize_android_context`, so `android_context()`
//! panics — and with `panic = "abort"` that is the whole process, from a
//! background thread, with no message on screen. So Kotlin hands them over
//! instead, once, from a thread that definitionally has them.
//!
//! The class loader is cached at the same time and for a related reason:
//! `FindClass` on a thread Rust created only searches the bootstrap loader,
//! which cannot see this app's classes. The Activity's loader can.

use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

struct Bridge {
    vm: JavaVM,
    context: GlobalRef,
    loader: GlobalRef,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Called from `NativeBridge.kt` as the Activity is created.
///
/// # Safety
/// Invoked by the JVM on the main thread with a live env and this app's
/// Context. Both are turned into owned handles here and not held as raw
/// pointers.
#[no_mangle]
pub extern "system" fn Java_app_fiddler_desktop_NativeBridge_attach(
    mut env: JNIEnv,
    _class: JClass,
    context: JObject,
) {
    if BRIDGE.get().is_some() {
        return;
    }
    // A failure here disables the three bridges rather than taking the process
    // with it; each of them reports "unavailable" to the UI, which is a screen
    // someone can act on.
    let Ok(bridge) = build(&mut env, &context) else {
        return;
    };
    let _ = BRIDGE.set(bridge);
}

fn build(env: &mut JNIEnv, context: &JObject) -> Result<Bridge, jni::errors::Error> {
    let vm = env.get_java_vm()?;
    let class = env
        .call_method(context, "getClass", "()Ljava/lang/Class;", &[])?
        .l()?;
    let loader = env
        .call_method(&class, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    Ok(Bridge {
        vm,
        context: env.new_global_ref(context)?,
        loader: env.new_global_ref(loader)?,
    })
}

fn bridge() -> Result<&'static Bridge, String> {
    BRIDGE
        .get()
        .ok_or_else(|| "Android bridge unavailable — the Activity never attached".into())
}

/// Run `f` with this thread attached to the VM.
///
/// Commands run on workers Rust made, which are not Java threads until they say
/// so. Attaching as a daemon means a worker that outlives the Activity does not
/// keep the VM alive.
pub fn with_env<T>(f: impl FnOnce(&mut JNIEnv<'_>) -> Result<T, String>) -> Result<T, String> {
    let mut env = bridge()?
        .vm
        .attach_current_thread_as_daemon()
        .map_err(|e| format!("couldn't attach this worker to Android: {e}"))?;
    f(&mut env)
}

/// This app's `Context`, for the Kotlin that needs one.
pub fn context() -> Result<&'static GlobalRef, String> {
    Ok(&bridge()?.context)
}

/// One of this app's own classes, by name, from a thread that can't see it.
pub fn class<'a>(env: &mut JNIEnv<'a>, name: &str) -> Result<JClass<'a>, String> {
    let loader = &bridge()?.loader;
    let name_string: JString = env
        .new_string(name)
        .map_err(|e| format!("couldn't encode the name of {name}: {e}"))?;
    env.call_method(
        loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[JValue::Object(&JObject::from(name_string))],
    )
    .and_then(|v| v.l())
    .map(JClass::from)
    .map_err(|e| format!("couldn't load {name}: {e}"))
}
