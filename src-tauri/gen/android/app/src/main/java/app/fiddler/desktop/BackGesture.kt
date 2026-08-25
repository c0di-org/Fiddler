package app.fiddler.desktop

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/**
 * Android's Back, handed to the front end when — and only when — Fiddler has
 * somewhere of its own to go.
 *
 * Back is the most reflexive gesture on the platform, and in a file browser it
 * means "the folder I came from". Left alone it finishes the Activity, so
 * walking three folders deep and swiping back quits the app.
 *
 * The enable flag is what keeps that failure from being replaced by a worse
 * one. If the callback were always enabled, a front end that never booted —
 * or wedged — would swallow Back forever and leave no way out of the app but
 * the task switcher. So the default is Android's: Back closes Fiddler. The
 * front end turns the callback on once it has a history, a sheet or a
 * selection to spend the press on, and off again the moment it doesn't. The
 * unsafe state is the one that has to be asked for.
 */
object BackGesture {
  private val main = Handler(Looper.getMainLooper())

  /** Registered per Activity: the callback is lifecycle-bound and dies with
   * its host, so a recreated Activity — Back out and reopen, a rotation —
   * needs a fresh one. Keeping only the first would leave every later session
   * with Back going straight to the launcher. */
  private var callback: OnBackPressedCallback? = null
  private var host: ComponentActivity? = null

  /**
   * Called from Rust, on a worker thread. The dispatcher is main-thread-only,
   * so the work is posted rather than done here.
   */
  @JvmStatic
  fun setEnabled(activity: Activity, enabled: Boolean) {
    main.post {
      val current = activity as? ComponentActivity ?: return@post
      val existing = callback
      if (existing != null && host === current) {
        existing.isEnabled = enabled
        return@post
      }
      // A previous Activity's callback was removed by its lifecycle when that
      // Activity was destroyed; dropping our reference just agrees with it.
      callback = null
      host = null
      // Nothing is registered until the front end first asks for Back, which
      // means an app that never gets that far never installs a callback at all.
      if (!enabled) return@post
      val fresh = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          NativeBridge.back()
        }
      }
      callback = fresh
      host = current
      current.onBackPressedDispatcher.addCallback(current, fresh)
    }
  }
}
