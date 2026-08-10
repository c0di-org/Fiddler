package app.fiddler.desktop

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/** Opens a local APK in Android's package installer. */
object ApkInstaller {
  /**
   * Returns a message when the user must take an action before installation can
   * continue; otherwise hands the APK directly to the system installer.
   */
  @JvmStatic
  fun install(context: Context, path: String): String? {
    val apk = File(path)
    require(apk.isFile) { "The APK no longer exists or is not a file." }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
      return "Allow Fiddler to install unknown apps in Settings, then open the APK again."
    }

    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
    context.startActivity(
      Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    )
    return null
  }
}
