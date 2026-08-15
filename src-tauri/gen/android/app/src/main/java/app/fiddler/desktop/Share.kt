package app.fiddler.desktop

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hand files to Android's share sheet.
 *
 * The sheet is the platform's universal verb — the way a file gets to a chat,
 * a mail draft, another device or a cloud folder — and a file browser without
 * it is a room with no door. Every other app on the phone has one, which is
 * exactly why its absence reads as Fiddler being broken rather than sparse.
 *
 * Everything goes out as a `content://` URI through the FileProvider that
 * `ApkInstaller` already uses. Handing over a `file://` path would throw
 * `FileUriExposedException` on anything since Nougat, and the receiving app
 * would have no permission to read it even if it didn't.
 */
object Share {
  /**
   * Returns a message when there is nothing sendable here; otherwise raises the
   * chooser.
   *
   * Folders are dropped rather than refused. A selection of six files and one
   * folder is a perfectly clear request to send the six, and Android has no
   * concept of sharing a directory to fail at.
   */
  @JvmStatic
  fun share(context: Context, paths: Array<String>): String? {
    val files = paths.map(::File).filter { it.isFile && it.canRead() }
    if (files.isEmpty()) return "There's nothing here Android can share — folders can't be sent, only files."

    val authority = "${context.packageName}.fileprovider"
    val uris = ArrayList<Uri>(files.size)
    for (file in files) {
      val uri =
        runCatching { FileProvider.getUriForFile(context, authority, file) }.getOrNull()
          ?: return "Android won't share ${file.name} from where it is."
      uris.add(uri)
    }

    val intent =
      if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
      }
    intent.type = mimeOf(files)
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

    // Always a chooser, never a remembered default: sharing is a decision about
    // where something goes, and it is a different answer nearly every time.
    context.startActivity(
      Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    return null
  }

  /**
   * The narrowest type that honestly covers the whole set.
   *
   * The type is what decides which apps the sheet offers, so it is worth
   * getting right: `image/png` puts a photo editor at the front, where the
   * fully wild type offers a flat list of everything that takes a file. Two
   * PNGs stay `image/png`; a PNG and a JPEG widen to the image family; a PNG
   * and a PDF have nothing in common and widen all the way.
   *
   * (The wildcards are spelled out rather than written, because the one that
   * matches everything ends a block comment.)
   */
  private fun mimeOf(files: List<File>): String {
    val types = files.map { typeOf(it) }.distinct()
    types.singleOrNull()?.let { return it }
    val families = types.map { it.substringBefore('/') }.distinct()
    return families.singleOrNull()?.let { "$it/*" } ?: "*/*"
  }

  /** MimeTypeMap has no entry for `.md`, `.rs` or most source extensions, and
   * the manifest's `Open with` filter already leans on that fact. Unknown means
   * "some kind of file", which is what `application/octet-stream` says. */
  private fun typeOf(file: File): String {
    val extension = file.extension.lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      ?: "application/octet-stream"
  }
}
