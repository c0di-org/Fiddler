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
//! instead, from a thread that definitionally has them.
//!
//! The class loader is cached at the same time and for a related reason:
//! `FindClass` on a thread Rust created only searches the bootstrap loader,
//! which cannot see this app's classes. The Activity's loader can.
//!
//! The handles are *replaced* on every `attach`, not set once. Android
//! recreates the Activity freely — Back out and reopen, rotate, a theme
//! change — and a bridge that kept the first one would spend the rest of the
//! process talking to a destroyed Activity: Back permanently broken, Share
//! aimed at a dead Context, and the old view tree pinned in memory by the
//! global ref. The VM itself is per-process and is kept once.

use std::sync::{OnceLock, RwLock};

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

/// One per process, never replaced.
static VM: OnceLock<JavaVM> = OnceLock::new();

struct Handles {
    context: GlobalRef,
    loader: GlobalRef,
}

/// Refreshed by every `attach`; dropping the previous pair releases the old
/// Activity for the GC.
static HANDLES: RwLock<Option<Handles>> = RwLock::new(None);

/// Called from `NativeBridge.kt` as each Activity is created.
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
    // A failure here disables the three bridges rather than taking the process
    // with it; each of them reports "unavailable" to the UI, which is a screen
    // someone can act on.
    let Ok(handles) = build(&mut env, &context) else {
        return;
    };
    if VM.get().is_none() {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
    }
    if let Ok(mut slot) = HANDLES.write() {
        *slot = Some(handles);
    }
}

fn build(env: &mut JNIEnv, context: &JObject) -> Result<Handles, jni::errors::Error> {
    let class = env
        .call_method(context, "getClass", "()Ljava/lang/Class;", &[])?
        .l()?;
    let loader = env
        .call_method(&class, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    Ok(Handles {
        context: env.new_global_ref(context)?,
        loader: env.new_global_ref(loader)?,
    })
}

fn vm() -> Result<&'static JavaVM, String> {
    VM.get()
        .ok_or_else(|| "Android bridge unavailable — the Activity never attached".into())
}

/// Run `f` with this thread attached to the VM.
///
/// Commands run on workers Rust made, which are not Java threads until they say
/// so. Attaching as a daemon means a worker that outlives the Activity does not
/// keep the VM alive — and also that the thread stays attached between calls,
/// which is why the frame and exception hygiene below are load-bearing:
///
/// - Every call runs inside its own local frame. Locals on an attached native
///   thread otherwise live until the thread exits, and tokio's blocking pool
///   reuses hot threads; ~10 stray locals per PDF page turn overflows ART's
///   512-entry table mid-book and aborts the process.
/// - A pending Java exception is described and cleared before returning. The
///   jni crate maps it to an error but leaves it *pending* on the thread, and
///   making the next JNI call on a thread with a pending exception is
///   undefined behaviour — an instant abort under CheckJNI, a mystery crash
///   far from the cause otherwise.
pub fn with_env<T>(f: impl FnOnce(&mut JNIEnv<'_>) -> Result<T, String>) -> Result<T, String> {
    let mut env = vm()
        .map_err(|e| e.to_string())?
        .attach_current_thread_as_daemon()
        .map_err(|e| format!("couldn't attach this worker to Android: {e}"))?;
    let out: Result<Result<T, String>, jni::errors::Error> =
        env.with_local_frame(32, |env| Ok(f(env)));
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    out.map_err(|e| format!("Android call failed: {e}"))?
}

/// This app's `Context` — the current Activity — for the Kotlin that needs one.
pub fn context() -> Result<GlobalRef, String> {
    HANDLES
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().map(|h| h.context.clone()))
        .ok_or_else(|| "Android bridge unavailable — the Activity never attached".into())
}

/// One of this app's own classes, by name, from a thread that can't see it.
pub fn class<'a>(env: &mut JNIEnv<'a>, name: &str) -> Result<JClass<'a>, String> {
    let loader = HANDLES
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().map(|h| h.loader.clone()))
        .ok_or_else(|| "Android bridge unavailable — the Activity never attached".to_string())?;
    let name_string: JString = env
        .new_string(name)
        .map_err(|e| format!("couldn't encode the name of {name}: {e}"))?;
    env.call_method(
        &loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[JValue::Object(&JObject::from(name_string))],
    )
    .and_then(|v| v.l())
    .map(JClass::from)
    .map_err(|e| format!("couldn't load {name}: {e}"))
}
