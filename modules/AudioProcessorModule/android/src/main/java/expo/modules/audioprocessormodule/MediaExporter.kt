package expo.modules.audioprocessormodule

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Publish only app-created audio/video, without requesting access to other media. */
class MediaExporter(private val context: Context) {
    suspend fun export(source: String, filename: String, albumName: String, video: Boolean): String =
        withContext(Dispatchers.IO) {
            val cleanAlbum = albumName.replace(Regex("[^A-Za-z0-9 _-]"), " ").trim().take(80)
                .ifEmpty { "DeepDenoiser" } + if (video) " Video" else " Audio"
            val cleanName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").take(180)
                .ifEmpty { if (video) "denoised.mp4" else "denoised.wav" }
            val mime = if (video) "video/mp4" else "audio/wav"
            val root = if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_MUSIC
            val sourceUri = Uri.parse(source)
            val resolver = context.contentResolver
            fun sourceSize(): Long = resolver.openAssetFileDescriptor(sourceUri, "r")?.use { it.length }
                ?: throw Exception("Could not verify the original file")
            val expectedBytes = sourceSize()
            if (expectedBytes <= 0) throw Exception("Cannot save a missing, empty or unverified file")
            fun verifySource(copiedDigest: ByteArray) {
                if (sourceSize() != expectedBytes) throw Exception("Original file changed while saving; the export is incomplete")
                val currentDigest = resolver.openInputStream(sourceUri)?.use { input ->
                    PcmIntegrity.hashExactly(input, expectedBytes)
                } ?: throw Exception("Could not verify the original file")
                if (sourceSize() != expectedBytes || !MessageDigest.isEqual(copiedDigest, currentDigest)) {
                    throw Exception("Original file changed while saving; the export is incomplete")
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "$root/$cleanAlbum/")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val destination = resolver.insert(collection, values)
                    ?: throw Exception("Could not create the shared media file")
                try {
                    val copiedDigest = resolver.openInputStream(sourceUri)?.use { input ->
                        resolver.openOutputStream(destination, "w")?.use { output -> PcmIntegrity.copyAndHashExactly(input, output, expectedBytes) }
                            ?: throw Exception("Could not open the shared media destination")
                    } ?: throw Exception("Could not open the original file")
                    verifySource(copiedDigest)
                    resolver.openAssetFileDescriptor(destination, "r")?.use { afd ->
                        if (afd.length >= 0 && afd.length != expectedBytes) throw Exception("Incomplete shared media file")
                    } ?: throw Exception("Could not verify the shared media file")
                    val publish = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                    if (resolver.update(destination, publish, null, null) != 1) {
                        throw Exception("Could not publish the shared media file")
                    }
                    destination.toString()
                } catch (error: Exception) {
                    val deleted = try { resolver.delete(destination, null, null) > 0 } catch (_: Exception) { false }
                    if (!deleted) throw Exception("${error.message ?: "Save failed"}. Could not confirm removal of the incomplete media entry.", error)
                    throw error
                }
            } else {
                // Android 8/9: WRITE_EXTERNAL_STORAGE is requested by JS first.
                @Suppress("DEPRECATION")
                val directory = File(Environment.getExternalStoragePublicDirectory(root), cleanAlbum)
                if (!directory.isDirectory && !directory.mkdirs()) throw Exception("Could not create the media folder")
                val dot = cleanName.lastIndexOf('.')
                val base = if (dot > 0) cleanName.substring(0, dot) else cleanName
                val extension = if (dot > 0) cleanName.substring(dot) else ""
                var destination = File(directory, cleanName)
                var suffix = 1
                while (!destination.createNewFile()) {
                    destination = File(directory, "${base}_${suffix++}$extension")
                    if (suffix > 10000) throw Exception("Could not allocate a unique media filename")
                }
                try {
                    val copiedDigest = resolver.openInputStream(sourceUri)?.use { input ->
                        destination.outputStream().use { output -> PcmIntegrity.copyAndHashExactly(input, output, expectedBytes) }
                    } ?: throw Exception("Could not open the original file")
                    verifySource(copiedDigest)
                    if (destination.length() != expectedBytes) throw Exception("Incomplete shared media file")
                    MediaScannerConnection.scanFile(context, arrayOf(destination.absolutePath), arrayOf(mime), null)
                    Uri.fromFile(destination).toString()
                } catch (error: Exception) {
                    if (destination.exists() && !destination.delete()) {
                        throw Exception("${error.message ?: "Save failed"}. An incomplete file may remain in the destination folder.", error)
                    }
                    throw error
                }
            }
        }
}
