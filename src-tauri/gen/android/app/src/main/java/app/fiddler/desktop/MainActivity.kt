package app.fiddler.desktop

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Scoped storage deliberately blocks arbitrary project files. Sending the
    // user to the per-app setting makes the required access explicit and avoids
    // a misleading empty file browser on first launch.
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    // Edge-to-edge is required on recent Android versions. Keep the system
    // bars transparent, but inset the WebView's content so app controls never
    // sit under the status bar, navigation bar, or a display cutout.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val safeInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(safeInsets.left, safeInsets.top, safeInsets.right, safeInsets.bottom)
      windowInsets
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
