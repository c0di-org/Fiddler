package app.fiddler.desktop

import android.content.Context

/**
 * What Rust needs from the Java side of the process, handed over rather than
 * looked up.
 *
 * A worker thread in Rust cannot find this app's `Context` or its class loader
 * on its own — the usual `ndk_context` route is populated by `ndk-glue`, which
 * a Tauri app doesn't use. So the Activity gives them up once, on the main
 * thread, where both are simply in scope. See `android_jni.rs`.
 */
object NativeBridge {
  /** Hand Rust the VM, this app's Context, and the loader that can see these
   * classes. Called once, as the Activity is created. */
  @JvmStatic external fun attach(context: Context)

  /** Files another app asked Fiddler to open, already resolved to paths. */
  @JvmStatic external fun opened(paths: Array<String>)

  /** The user pressed Back while the front end had somewhere of its own to go.
   * See `BackGesture`, which only forwards the press once asked to. */
  @JvmStatic external fun back()
}
