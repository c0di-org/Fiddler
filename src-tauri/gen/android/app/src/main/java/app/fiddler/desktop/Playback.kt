package app.fiddler.desktop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * The front end's side of the transport controls: start the service, keep it
 * fed, take it down.
 *
 * Thin on purpose. Everything that has state — the session, the notification,
 * audio focus — lives in the service, because the service is the thing whose
 * lifetime Android controls. This object is only the door Rust knocks on, and
 * one flag that `MainActivity` reads.
 */
object Playback {
  private val main = Handler(Looper.getMainLooper())

  /**
   * Whether a book is loaded and the service is meant to be up.
   *
   * Read by `MainActivity.onPause`, which is the whole reason it is a flag
   * rather than a question asked of the service. `WryActivity.onPause` calls
   * `WebView.onPause`, which suspends the DOM and stops the audio; undoing
   * that has to happen in the same call stack, before the phone has finished
   * locking. Binding to a service to ask permission is not something that can
   * happen there.
   */
  @Volatile
  var active = false
    private set

  /** The notification permission is asked for once per process. Refusing it
   * twice in one session teaches nothing and costs a dialog over a book. */
  private var asked = false

  /** Set from Rust on every meaningful change: play, pause, seek, new chapter,
   * new speed. The payload is JSON — see `playback.rs` for why. */
  @JvmStatic
  fun update(context: Context, json: String) {
    main.post {
      askForNotifications(context)
      val intent =
        Intent(context, PlaybackService::class.java)
          .setAction(PlaybackService.ACTION_UPDATE)
          .putExtra(PlaybackService.EXTRA_STATE, json)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        active = true
      } catch (error: Throwable) {
        // Android refused the service — the usual cause is being asked from the
        // background on API 31+. Playing carries on for as long as the system
        // allows it; what is lost is the notification and the guarantee, not
        // the sound. Reporting it would mean a toast over someone's book.
        active = false
      }
    }
  }

  /** Nothing is playing any more. The second argument exists only so both
   * entry points share one JNI signature. */
  @JvmStatic
  fun stop(context: Context, @Suppress("UNUSED_PARAMETER") json: String) {
    main.post {
      active = false
      runCatching { context.stopService(Intent(context, PlaybackService::class.java)) }
    }
  }

  /**
   * Ask for the notification permission, once, at the moment it first means
   * something.
   *
   * Not on launch. A file browser that opens with a permission dialog about
   * notifications is asking for something it can't yet justify; asked here, the
   * answer is about the book that just started playing, and the controls the
   * person is about to want on their lock screen.
   */
  private fun askForNotifications(context: Context) {
    if (Build.VERSION.SDK_INT < 33) return
    val activity = context as? Activity ?: return
    val permission = "android.permission.POST_NOTIFICATIONS"
    if (activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return
    if (asked) return
    asked = true
    runCatching { activity.requestPermissions(arrayOf(permission), 2) }
  }
}
