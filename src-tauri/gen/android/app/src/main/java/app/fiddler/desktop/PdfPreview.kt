package app.fiddler.desktop

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Thin bridge to Android's built-in PDF renderer. Keeping this native has two
 * important properties for a file browser: no multi-megabyte PDF engine in the
 * APK, and rendering happens at the exact pixel size the Quick Look window
 * requested rather than decoding a full document in JavaScript.
 */
object PdfPreview {
  @JvmStatic
  fun meta(path: String): DoubleArray? = runCatching {
    ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      PdfRenderer(fd).use { pdf ->
        require(pdf.pageCount > 0)
        pdf.openPage(0).use { page ->
          require(page.height > 0)
          doubleArrayOf(pdf.pageCount.toDouble(), page.width.toDouble() / page.height.toDouble())
        }
      }
    }
  }.getOrNull()

  /**
   * Serializing a render prevents the foreground request and its adjacent-page
   * warm-up from doing the same expensive native work twice. Cache hits return
   * immediately and do not allocate a bitmap.
   */
  @JvmStatic
  @Synchronized
  fun render(context: Context, path: String, pageNumber: Int, maxPx: Int): String? = runCatching {
    require(pageNumber >= 1)
    require(maxPx in 64..4096)

    val source = File(path)
    val key = cacheKey(source, pageNumber, maxPx)
    val dir = File(context.cacheDir, "fiddler-pdf").apply { mkdirs() }
    val out = File(dir, "$key.png")
    if (out.isFile && out.length() > 0L) return@runCatching out.absolutePath

    ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      PdfRenderer(fd).use { pdf ->
        require(pageNumber <= pdf.pageCount)
        pdf.openPage(pageNumber - 1).use { page ->
          require(page.width > 0 && page.height > 0)
          val scale = maxPx.toDouble() / max(page.width, page.height).toDouble()
          val width = max(1, (page.width * scale).roundToInt())
          val height = max(1, (page.height * scale).roundToInt())
          val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
          try {
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val temp = File(dir, "$key.tmp")
            FileOutputStream(temp).use { stream ->
              check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
            }
            if (!temp.renameTo(out)) {
              temp.delete()
              check(out.isFile && out.length() > 0L)
            }
          } finally {
            bitmap.recycle()
          }
        }
      }
    }
    out.absolutePath
  }.getOrNull()

  private fun cacheKey(file: File, page: Int, maxPx: Int): String {
    val source = "${file.absolutePath}\u0000${file.length()}\u0000${file.lastModified()}\u0000$page\u0000$maxPx"
    return MessageDigest.getInstance("SHA-256")
      .digest(source.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
  }
}
