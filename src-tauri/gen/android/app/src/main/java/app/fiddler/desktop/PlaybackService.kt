package app.fiddler.desktop

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/**
 * The foreground service that keeps a book playing, and the controls that come
 * with it.
 *
 * Nothing here decodes any audio. The sound is still an `<audio>` element in
 * the webview, four layers up — this service exists for the three things that
 * element cannot do for itself on Android:
 *
 * 1. **Stay alive.** A backgrounded webview is a background app, and Android
 *    reaps those. A foreground service of type `mediaPlayback` is the platform's
 *    own answer to "this app is doing something the user can hear".
 * 2. **Be controlled.** The lock screen, the notification shade, a headphone
 *    remote, a car head unit and a watch all speak `MediaSession` and nothing
 *    else. Every press arrives here and is forwarded to the front end, which is
 *    where the decision about what a press means already lives.
 * 3. **Share the speaker.** Audio focus is how a book pauses for a phone call
 *    and stops for the next app, and unplugging headphones in a quiet room is
 *    the one failure everybody remembers.
 *
 * The MediaSession here is deliberately a mirror, not a source of truth. It is
 * told what is playing and where; it never decides. Two things that both think
 * they know the position is the bug this shape rules out.
 */
class PlaybackService : Service() {
  companion object {
    const val ACTION_UPDATE = "app.fiddler.desktop.action.PLAYBACK_UPDATE"
    const val ACTION_TRANSPORT = "app.fiddler.desktop.action.PLAYBACK_TRANSPORT"
    const val EXTRA_STATE = "state"
    const val EXTRA_VERB = "verb"
    const val EXTRA_VALUE = "value"

    private const val CHANNEL_ID = "fiddler.playback"
    private const val NOTIFICATION_ID = 91
  }

  private var session: MediaSessionCompat? = null
  private var focusRequest: AudioFocusRequest? = null
  private var holdsFocus = false
  /** Set when *we* paused the book for something else's sake, so that getting
   * focus back can put it on again — and so that a pause the user asked for is
   * never undone by an interruption ending. */
  private var pausedForFocus = false
  private var playing = false
  private var started = false

  /** Keyed by path: a chapter change inside one book must not re-decode the
   * same cover forty times. One entry, because there is one book. */
  private var artPath: String? = null
  private var art: Bitmap? = null

  /**
   * One instance, held.
   *
   * `AudioManager` finds a registration by the listener's identity, and a
   * method reference is a fresh wrapper object every time it is written. Two
   * `::onFocusChange` references are two different objects, so on API 24–25 —
   * where focus is abandoned by listener rather than by request — the abandon
   * would quietly match nothing and Fiddler would hold the audio focus of a
   * book it had already put down.
   */
  private val focusListener = AudioManager.OnAudioFocusChangeListener(::onFocusChange)

  private val noisy =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        // Headphones pulled out. Pausing is not politeness, it is the
        // difference between a private book and a public one.
        if (playing) forward("pause")
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val media =
      MediaSessionCompat(this, "Fiddler").apply {
        setCallback(
          object : MediaSessionCompat.Callback() {
            override fun onPlay() = forward("play")

            override fun onPause() = forward("pause")

            override fun onStop() = forward("pause")

            override fun onSkipToNext() = forward("next")

            override fun onSkipToPrevious() = forward("previous")

            override fun onFastForward() = forward("forward")

            override fun onRewind() = forward("back")

            override fun onSeekTo(pos: Long) = forward("seek", pos)
          }
        )
        isActive = true
      }
    session = media
    registerNoisy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPDATE -> intent.getStringExtra(EXTRA_STATE)?.let { applyState(it) }
      ACTION_TRANSPORT -> {
        val verb = intent.getStringExtra(EXTRA_VERB) ?: return START_NOT_STICKY
        forward(verb, intent.getLongExtra(EXTRA_VALUE, 0L))
        // Swiping the notification away means putting the book down, and the
        // front end answers by clearing the state — which stops this service.
        // Stopping here as well makes the notification go for good even if the
        // webview is gone and nobody answers.
        if (verb == "close") stopSelf()
      }
      else -> {
        // Started with nothing to say — a restart after being killed, most
        // likely. There is no state to draw, so there is nothing to be.
        if (!started) stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    dropFocus()
    unregisterNoisy()
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
    art = null
    artPath = null
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  // ------------------------------------------------------------------ state

  private fun applyState(json: String) {
    // Never bails. Android's contract for a service started with
    // `startForegroundService` is that it *will* call `startForeground`, and
    // breaking it is not an error message — it is the system killing the
    // process. Unreadable JSON therefore becomes an empty object and every
    // field below falls back to its default, which draws a plain, honest
    // notification instead of a crash.
    val state = runCatching { JSONObject(json) }.getOrElse { JSONObject() }

    playing = state.optBoolean("playing", false)
    val title = state.optString("title", "")
    val subtitle = state.optString("subtitle", "")
    val positionMs = state.optLong("positionMs", 0L)
    val durationMs = state.optLong("durationMs", 0L)
    val speed = state.optDouble("speed", 1.0).toFloat()
    val canPrevious = state.optBoolean("canPrevious", false)
    val canNext = state.optBoolean("canNext", false)
    val skipBack = state.optInt("skipBack", 15)
    val skipForward = state.optInt("skipForward", 30)
    // `optString` on a JSON null hands back the four characters "null" rather
    // than nothing, and that is a path we would then try to decode a bitmap
    // from. Asked properly instead.
    val wantedArt =
      if (state.isNull("artPath")) null else state.optString("artPath", "").ifEmpty { null }

    if (playing) {
      takeFocus()
    } else {
      // A pause the person asked for cancels any intention to resume when an
      // interruption ends. Otherwise hanging up a call would restart a book
      // that had been deliberately stopped mid-call.
      pausedForFocus = false
    }
    loadArt(wantedArt)

    session?.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, subtitle)
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, subtitle)
        // A duration of zero would be honest and useless: the lock screen reads
        // it as "no scrubber". −1 is the platform's word for "still playing,
        // length unknown", which is what a stream actually is.
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, if (durationMs > 0) durationMs else -1L)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
        .build()
    )

    var actions =
      PlaybackStateCompat.ACTION_PLAY or
        PlaybackStateCompat.ACTION_PAUSE or
        PlaybackStateCompat.ACTION_PLAY_PAUSE or
        PlaybackStateCompat.ACTION_STOP or
        PlaybackStateCompat.ACTION_SEEK_TO or
        PlaybackStateCompat.ACTION_FAST_FORWARD or
        PlaybackStateCompat.ACTION_REWIND
    if (canPrevious) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    if (canNext) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT

    session?.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(
          if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          positionMs,
          // The speed is what lets the lock screen's clock run without being
          // told again every second. Zero while paused, or it counts on alone.
          if (playing) speed else 0f,
        )
        .build()
    )

    raise(title, subtitle, skipBack, skipForward)
  }

  /**
   * The notification, which on a locked phone *is* the player.
   *
   * Three buttons, and they are not the three a music player would pick. Skip
   * back, play/pause, skip forward — no chapter skips, because pressing one of
   * those by accident costs an hour and pressing skip-back by accident costs
   * fifteen seconds. The chapter skips are still on the lock screen: they ride
   * in the session's actions, which is where Android reads them from.
   */
  private fun raise(title: String, subtitle: String, skipBack: Int, skipForward: Int) {
    ensureChannel()

    val note =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_playback)
        .setContentTitle(title.ifEmpty { getString(R.string.app_name) })
        .setContentText(subtitle)
        .setLargeIcon(art)
        .setContentIntent(openApp())
        .setDeleteIntent(transportIntent("close", 4))
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        // Silent on every update, and there is one on every seek.
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        // Undismissable while playing, dismissable once paused: a notification
        // you cannot get rid of for a book you have stopped listening to is
        // the thing people uninstall an app over.
        .setOngoing(playing)
        .addAction(
          android.R.drawable.ic_media_rew,
          "Back $skipBack seconds",
          transportIntent("back", 0),
        )
        .addAction(
          if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
          if (playing) "Pause" else "Play",
          transportIntent("toggle", 1),
        )
        .addAction(
          android.R.drawable.ic_media_ff,
          "Forward $skipForward seconds",
          transportIntent("forward", 2),
        )
        .setStyle(
          androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session?.sessionToken)
            // The three that matter on a locked screen. Chapter skips are in
            // the expanded view and in the app; the two intervals and play are
            // what a thumb needs without looking, which is the whole case for
            // this notification existing.
            .setShowActionsInCompactView(0, 1, 2)
        )
        .build()

    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        note,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
          0
        },
      )
      started = true
    } catch (error: Throwable) {
      // API 31+ refuses a foreground service started from the background. The
      // book is still playing; what is lost is the promise that it keeps.
      started = false
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel =
      NotificationChannel(
          CHANNEL_ID,
          getString(R.string.playback_channel),
          NotificationManager.IMPORTANCE_LOW,
        )
        .apply {
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
          lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
    manager.createNotificationChannel(channel)
  }

  private fun openApp(): PendingIntent {
    val intent =
      Intent(this, MainActivity::class.java)
        .setAction(Intent.ACTION_MAIN)
        .addCategory(Intent.CATEGORY_LAUNCHER)
        // `singleTask`, so this brings the running Fiddler forward rather than
        // starting a second one on top of the book.
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(this, 0, intent, immutable())
  }

  private fun transportIntent(verb: String, code: Int): PendingIntent {
    val intent =
      Intent(this, PlaybackService::class.java)
        .setAction(ACTION_TRANSPORT)
        .putExtra(EXTRA_VERB, verb)
    return PendingIntent.getService(this, code, intent, immutable())
  }

  private fun immutable(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }

  /** A press, on its way to the only thing that knows what to do with it. */
  private fun forward(verb: String, value: Long = 0L) {
    runCatching { NativeBridge.transport(verb, value) }
  }

  // ------------------------------------------------------------------- art

  /**
   * The cover, decoded once and sampled down.
   *
   * The path is usually the thumbnailer's copy, which is already small — but it
   * falls back to whatever picture is beside the book, and that is routinely a
   * 3000px scan. Decoding one of those at full size for a 128dp notification
   * icon is tens of megabytes for nothing, on the main thread, every time the
   * chapter changes.
   */
  private fun loadArt(path: String?) {
    if (path == artPath) return
    artPath = path
    art = null
    val file = path?.let(::File) ?: return
    if (!file.isFile || !file.canRead()) return
    runCatching {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.path, bounds)
      val longest = maxOf(bounds.outWidth, bounds.outHeight)
      var sample = 1
      while (longest / sample > 512) sample *= 2
      art =
        BitmapFactory.decodeFile(
          file.path,
          BitmapFactory.Options().apply { inSampleSize = sample },
        )
    }
  }

  // ---------------------------------------------------------------- focus

  private fun takeFocus() {
    if (holdsFocus) return
    val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val granted =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                // Spoken word, and the system uses this to decide what to do
                // when something else wants the speaker for a moment.
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            )
            // Refused rather than ducked. A book quietened under a navigation
            // prompt is a book you have to rewind; pausing loses nothing.
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(focusListener)
            .build()
        focusRequest = request
        audio.requestAudioFocus(request)
      } else {
        @Suppress("DEPRECATION")
        audio.requestAudioFocus(
          focusListener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN,
        )
      }
    holdsFocus = granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun dropFocus() {
    if (!holdsFocus) return
    holdsFocus = false
    val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audio.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION") audio.abandonAudioFocus(focusListener)
    }
  }

  private fun onFocusChange(change: Int) {
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        pausedForFocus = false
        if (playing) forward("pause")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        if (playing) {
          pausedForFocus = true
          forward("pause")
        }
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        // Only if we were the ones who stopped it. Someone who pressed pause
        // and then took a phone call must not come back to a talking phone.
        if (pausedForFocus) {
          pausedForFocus = false
          forward("play")
        }
      }
    }
  }

  private fun registerNoisy() {
    runCatching {
      // Through the compat wrapper because API 34 refuses an unflagged
      // registration, and the flag it wants doesn't exist on API 24.
      ContextCompat.registerReceiver(
        this,
        noisy,
        IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
    }
  }

  private fun unregisterNoisy() {
    runCatching { unregisterReceiver(noisy) }
  }
}
