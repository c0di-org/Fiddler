package app.fiddler.desktop

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.util.concurrent.Executors

/**
 * Files another app has handed Fiddler to open.
 *
 * Android delivers these as a `content://` URI, and Fiddler is a file browser:
 * every reader below the command layer takes a path. So the job here is to get
 * back to a real path wherever one exists, because that is the difference
 * between opening a document and *finding* it — landing in the folder it lives
 * in, with its neighbours around it and the arrow keys able to walk them.
 * Copying into the cache is the fallback, not the plan.
 *
 * Resolution can read the whole file, so it never runs on the main thread — and
 * the result is pushed to Rust rather than left here to be fetched, so nothing
 * has to poll and Rust never has to reach back into Java to ask.
 */
object OpenedFile {
  private const val TAG = "Fiddler"

  private val worker = Executors.newSingleThreadExecutor { r ->
    Thread(r, "fiddler-opened-file").apply { isDaemon = true }
  }

  /** Past this, a provider with no real path is not worth duplicating onto the
   * user's own storage to look at. Everything resolvable is unaffected — this
   * only bounds the copy fallback. */
  private const val MAX_COPY_BYTES = 512L * 1024L * 1024L

  /**
   * Take whatever this intent is carrying, if anything. Safe to call with every
   * intent the activity sees; a launch has nothing in it and returns quietly.
   */
  @JvmStatic
  fun offer(context: Context, intent: Intent?) {
    val uris = urisIn(intent ?: return)
    if (uris.isEmpty()) return

    // The read grant rides on the activity's task, so hold the application
    // context and let the worker use the grant while the task is alive.
    val app = context.applicationContext
    worker.execute {
      val found = uris.mapNotNull { uri -> runCatching { resolve(app, uri) }.getOrNull() }
      if (found.isEmpty()) return@execute
      // Rust holds these until the front end asks, so arriving before the
      // webview exists — a cold start, which is the common case — is fine.
      runCatching { NativeBridge.opened(found.toTypedArray()) }
    }
  }

  private fun urisIn(intent: Intent): List<Uri> = when (intent.action) {
    Intent.ACTION_VIEW -> listOfNotNull(intent.data)
    Intent.ACTION_SEND -> listOfNotNull(parcelable(intent, Intent.EXTRA_STREAM))
    Intent.ACTION_SEND_MULTIPLE -> parcelableList(intent, Intent.EXTRA_STREAM)
    else -> emptyList()
  }

  @Suppress("DEPRECATION")
  private fun parcelable(intent: Intent, key: String): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(key, Uri::class.java)
    } else {
      intent.getParcelableExtra(key)
    }

  @Suppress("DEPRECATION")
  private fun parcelableList(intent: Intent, key: String): List<Uri> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(key, Uri::class.java) ?: emptyList()
    } else {
      intent.getParcelableArrayListExtra<Uri>(key) ?: emptyList()
    }

  /**
   * A readable path for this URI: the file itself where one can be reached, a
   * copy in the cache where it cannot.
   *
   * Every route is checked by actually reading the file rather than by trusting
   * the shape of the URI. A path that looks right but isn't readable — the wrong
   * volume, a revoked permission, a provider that lied — has to fall through to
   * the copy rather than be handed on as a path that will fail later, further
   * away, as an empty folder.
   */
  private fun resolve(context: Context, uri: Uri): String? {
    when (uri.scheme) {
      ContentResolver.SCHEME_FILE -> uri.path?.let { path ->
        val file = File(path)
        if (file.isFile && file.canRead()) return file.absolutePath
      }
      ContentResolver.SCHEME_CONTENT -> {
        documentPath(context, uri)?.let { return it }
        mediaPath(context, uri)?.let { return it }
      }
    }
    return copyIntoCache(context, uri)
  }

  /**
   * The path behind a Storage Access Framework document.
   *
   * `primary:Download/report.pdf` is shared storage, which Fiddler can read
   * directly with the all-files access it already asks for on launch. A document
   * on a removable volume names its volume by UUID, and `/storage/<uuid>` is
   * where Android mounts it.
   */
  private fun documentPath(context: Context, uri: Uri): String? {
    if (!DocumentsContract.isDocumentUri(context, uri)) return null
    val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return null

    if (uri.authority == "com.android.externalstorage.documents") {
      val volume = docId.substringBefore(':', "")
      val relative = docId.substringAfter(':', "")
      if (relative.isEmpty()) return null
      val root =
        if (volume.equals("primary", ignoreCase = true)) Environment.getExternalStorageDirectory()
        else File("/storage/$volume")
      return readable(File(root, relative))
    }

    // Downloads and the media documents provider both describe files that
    // MediaStore also knows about, and MediaStore is the one that can name them.
    if (docId.startsWith("raw:")) return readable(File(docId.removePrefix("raw:")))
    return mediaPath(context, uri)
  }

  /** What MediaStore thinks this file is called on disk. Deprecated for writing,
   * still the only answer to "where is it" for a photo or a download. */
  @Suppress("DEPRECATION")
  private fun mediaPath(context: Context, uri: Uri): String? = runCatching {
    context.contentResolver
      .query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)
      ?.use { cursor ->
        val column = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
        if (column < 0 || !cursor.moveToFirst()) return@use null
        cursor.getString(column)?.let { readable(File(it)) }
      }
  }.getOrNull()

  private fun readable(file: File): String? =
    if (file.isFile && file.canRead()) file.absolutePath else null

  /**
   * The fallback: a provider that streams bytes and has no file behind them —
   * Drive, Photos, a mail attachment. The copy keeps the original name so the
   * preview is chosen the same way it would have been, and is reused when the
   * same document is opened twice.
   */
  private fun copyIntoCache(context: Context, uri: Uri): String? {
    val name = displayName(context, uri) ?: return null
    val dir = File(context.cacheDir, "fiddler-opened").apply { mkdirs() }
    // Keyed by document rather than by name: two attachments called
    // `invoice.pdf` are two files, and the second must not open as the first.
    val slot = File(dir, Integer.toHexString(uri.toString().hashCode())).apply { mkdirs() }
    val out = File(slot, name.replace('/', '_'))
    if (out.isFile && out.length() > 0L) return out.absolutePath

    val size = sizeOf(context, uri)
    if (size != null && size > MAX_COPY_BYTES) {
      Log.w(TAG, "$name is too large to open from a provider with no file behind it")
      return null
    }

    val temp = File(slot, ".partial")
    return runCatching {
      context.contentResolver.openInputStream(uri)!!.use { input ->
        temp.outputStream().use { output ->
          var copied = 0L
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            copied += read
            // Providers are allowed not to know their own size, so the ceiling
            // is enforced against what actually arrives as well.
            if (copied > MAX_COPY_BYTES) throw IllegalStateException("too large to copy")
            output.write(buffer, 0, read)
          }
        }
      }
      check(temp.renameTo(out)) { "couldn't put the copy in place" }
      out.absolutePath
    }.getOrElse {
      temp.delete()
      Log.w(TAG, "couldn't read $name from the app that sent it: $it")
      null
    }
  }

  private fun displayName(context: Context, uri: Uri): String? {
    val queried = runCatching {
      context.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (column < 0 || !cursor.moveToFirst()) null else cursor.getString(column)
        }
    }.getOrNull()
    return (queried ?: uri.lastPathSegment?.substringAfterLast('/'))?.takeIf { it.isNotBlank() }
  }

  private fun sizeOf(context: Context, uri: Uri): Long? = runCatching {
    context.contentResolver
      .query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
      ?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (column < 0 || !cursor.moveToFirst() || cursor.isNull(column)) null
        else cursor.getLong(column)
      }
  }.getOrNull()
}
