package app.fiddler.desktop

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Real thumbnails for the Android build, the way `PdfPreview` does pages.
 *
 * Handing the WebView the original file was cheap to write and expensive to
 * run: a camera roll in icon view meant decoding two thousand 12-megapixel
 * JPEGs into 128-pixel tiles, and a Samsung camera roll — HEIF — meant broken
 * tiles, because the WebView cannot decode HEIF at all. `ImageDecoder` can,
 * downscales during decode, honours EXIF orientation, and hands back a bitmap
 * already at tile size, which is then cached as an ordinary JPEG or PNG the
 * WebView draws for free.
 */
object Thumbs {
  @JvmStatic
  fun render(context: Context, path: String, maxPx: Int): String? = runCatching {
    require(maxPx in 32..4096)
    val source = File(path)
    require(source.isFile)

    val key = cacheKey(source, maxPx)
    val dir = File(context.cacheDir, "fiddler-thumbs").apply { mkdirs() }
    // The extension is settled after decode (alpha decides), so probe both.
    File(dir, "$key.jpg").takeIf { it.isFile && it.length() > 0L }?.let { return@runCatching it.absolutePath }
    File(dir, "$key.png").takeIf { it.isFile && it.length() > 0L }?.let { return@runCatching it.absolutePath }

    val bitmap = decode(source, maxPx) ?: return@runCatching null
    try {
      val png = bitmap.hasAlpha()
      val out = File(dir, if (png) "$key.png" else "$key.jpg")
      // A temp file of its own per call, not "$key.tmp": unlike PdfPreview
      // this is deliberately unsynchronized — the raster pool is eight lanes
      // wide — and two renders of the same photo sharing one temp name would
      // interleave into a corrupt cache entry. The rename is atomic; when two
      // finish, the last complete file wins.
      val temp = File.createTempFile(key, ".tmp", dir)
      try {
        FileOutputStream(temp).use { stream ->
          val format = if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
          check(bitmap.compress(format, if (png) 100 else 82, stream))
        }
        if (!temp.renameTo(out)) {
          temp.delete()
          check(out.isFile && out.length() > 0L)
        }
      } finally {
        temp.delete()
      }
      out.absolutePath
    } finally {
      bitmap.recycle()
    }
  }.getOrNull()

  private fun decode(source: File, maxPx: Int): Bitmap? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return runCatching {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(source)) { decoder, info, _ ->
          decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
          decoder.isMutableRequired = false
          val longest = max(info.size.width, info.size.height)
          if (longest > maxPx) {
            val scale = maxPx.toDouble() / longest.toDouble()
            decoder.setTargetSize(
              max(1, (info.size.width * scale).roundToInt()),
              max(1, (info.size.height * scale).roundToInt()),
            )
          }
        }
      }.getOrNull()
    }

    // API < 28: two-pass BitmapFactory. No HEIF here, but the formats the
    // WebView could show still get properly small tiles.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(source.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPx) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val decoded = BitmapFactory.decodeFile(source.absolutePath, options) ?: return null
    val longest = max(decoded.width, decoded.height)
    if (longest <= maxPx) return decoded
    val scale = maxPx.toFloat() / longest
    val scaled = Bitmap.createScaledBitmap(
      decoded,
      max(1, (decoded.width * scale).roundToInt()),
      max(1, (decoded.height * scale).roundToInt()),
      true,
    )
    if (scaled !== decoded) decoded.recycle()
    return scaled
  }

  private fun cacheKey(file: File, maxPx: Int): String {
    val source = "${file.absolutePath}\u0000${file.length()}\u0000${file.lastModified()}\u0000$maxPx"
    return MessageDigest.getInstance("SHA-256")
      .digest(source.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
  }

  /**
   * Keep the disk caches bounded. Called from the Activity on a worker thread:
   * thumbnails and PDF pages regenerate on demand, and copies made for other
   * apps' URIs ("fiddler-opened") re-copy on the next open, so evicting the
   * oldest is always safe. `min(...)` guards a clock that moved backwards.
   */
  @JvmStatic
  fun sweepCaches(context: Context) = runCatching {
    sweep(File(context.cacheDir, "fiddler-thumbs"), 256L * 1024 * 1024)
    sweep(File(context.cacheDir, "fiddler-pdf"), 256L * 1024 * 1024)
    sweep(File(context.cacheDir, "fiddler-opened"), 512L * 1024 * 1024)
  }.let { }

  private fun sweep(dir: File, capBytes: Long) {
    // Walked, not listed: "fiddler-opened" keeps each copy in a per-URI
    // subdirectory, and a flat listing would count those as zero bytes.
    val files = dir.walkTopDown().filter { it.isFile }.toList()
    var total = files.sumOf { it.length() }
    if (total <= capBytes) return
    for (file in files.sortedBy { min(it.lastModified(), System.currentTimeMillis()) }) {
      val size = file.length()
      if (file.delete()) total -= size
      if (total <= capBytes) break
    }
    // The slot folders the deletions emptied out.
    dir.walkBottomUp().filter { it.isDirectory && it != dir }.forEach { it.delete() }
  }
}
