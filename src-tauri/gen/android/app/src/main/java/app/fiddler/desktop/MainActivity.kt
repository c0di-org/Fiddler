package app.fiddler.desktop

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Rust cannot find this app's Context or class loader from a worker thread
    // of its own, so hand both over from here, where they are simply in scope.
    // Everything Rust reaches back into Kotlin for depends on this.
    NativeBridge.attach(this)
    // Scoped storage deliberately blocks arbitrary project files. Sending the
    // user to the per-app setting makes the required access explicit and avoids
    // a misleading empty file browser on first launch.
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
    } else if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
      // Android 7–10: All files access doesn't exist; the legacy runtime pair
      // is the whole story, and without asking, every listing is EACCES.
      val storage = android.Manifest.permission.WRITE_EXTERNAL_STORAGE
      if (checkSelfPermission(storage) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        requestPermissions(
          arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE, storage),
          1,
        )
      }
    }
    // A file opened from another app while Fiddler wasn't running. After the
    // attach above, so the push it ends in has somewhere to land.
    OpenedFile.offer(this, intent)
    // Thumbnails, PDF pages and copies of other apps' files all accumulate in
    // the cache dir with nothing else evicting them; a long-lived install was
    // gigabytes. Off the main thread — it's disk I/O over many small files.
    Thread({ Thumbs.sweepCaches(applicationContext) }, "fiddler-cache-sweep")
      .apply { isDaemon = true }
      .start()
  }

  /**
   * The same thing while Fiddler is already running. `singleTask` means Android
   * brings this activity forward and delivers the file here rather than starting
   * a second copy of the browser.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    OpenedFile.offer(this, intent)
  }
}
