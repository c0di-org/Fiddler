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
    }
  }
}
