package expo.modules.audioprocessormodule

import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class AudioProcessorModule : Module() {
    // A SupervisorJob keeps one failed transformation from cancelling its
    // siblings (AUD-37). Each promise is still settled in the catch below.
    private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun definition() = ModuleDefinition {
        Name("AudioProcessorModule")

        /**
         * MediaProcessor implements Closeable: it owns a LiTr MediaTransformer
         * (and its HandlerThread). Every call MUST use `.use { }` so the
         * transformer is released even when the transformation fails (AUD-03).
         */
        fun newProcessor() = MediaProcessor(
            appContext.reactContext ?: throw Exception("React Context is null")
        )

        OnDestroy {
            moduleScope.cancel()
        }

        // The diagnostics store is opt-in and accepts only a bounded allowlist
        // of structured events. It never receives or stores media or paths.
        AsyncFunction("getDiagnosticsInfo") { promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    promise.resolve(DiagnosticsNative.getInfo(context))
                } catch (e: Exception) {
                    promise.reject("ERR_DIAGNOSTICS_INFO", "Could not read device information", e)
                }
            }
        }
        AsyncFunction("readDiagnosticHistory") { promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    promise.resolve(DiagnosticsNative.readHistory(context))
                } catch (e: Exception) {
                    promise.reject("ERR_DIAGNOSTICS_READ", "Could not read diagnostic history", e)
                }
            }
        }
        AsyncFunction("writeDiagnosticHistory") { json: String, promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    DiagnosticsNative.writeHistory(context, json)
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_DIAGNOSTICS_WRITE", "Could not save diagnostic history", e)
                }
            }
        }
        AsyncFunction("deleteDiagnosticHistory") { promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    DiagnosticsNative.deleteHistory(context)
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_DIAGNOSTICS_DELETE", "Could not delete diagnostic history", e)
                }
            }
        }

        AsyncFunction("extractAndTranscodeAudio") {
                input: String,
                output: String,
                bitrate: Int?,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.transcodeAudio(input, output, bitrate) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_TRANSCODE", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("decodeToPCM") {
                input: String,
                output: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.decodeToPCM(input, output) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_DECODE", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("pcmToWav") {
                pcmInput: String,
                wavOutput: String,
                sampleRate: Int,
                channels: Int,
                bitDepth: Int,
                silenceTrim: Map<String, Any?>?,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use {
                        it.pcmToWav(
                            pcmInput,
                            wavOutput,
                            sampleRate,
                            channels,
                            bitDepth,
                            silenceTrim
                        )
                    }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_WAV_CONV", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("extractWavAudio") {
                input: String,
                output: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.extractWavAudio(input, output) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_WAV_EXTRACT", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("copyFile") {
                sourceUri: String,
                destUri: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.copyFile(sourceUri, destUri) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_COPY_FILE", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("copyFileWithSha256") {
                sourceUri: String,
                destUri: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val digest = newProcessor().use { it.copyFileWithSha256(sourceUri, destUri) }
                    promise.resolve(digest)
                } catch (e: Exception) {
                    promise.reject("ERR_COPY_HASH", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("fingerprintFile") { sourceUri: String, promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.fingerprintFile(sourceUri) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_FILE_INTEGRITY", e.message ?: e.toString(), e)
                }
            }
        }

        // Query a provider's display name without copying into a shared cache path.
        // The caller treats a missing or inaccessible name as optional metadata.
        AsyncFunction("getContentDisplayName") { sourceUri: String, promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    val uri = Uri.parse(sourceUri)
                    val name = if (uri.scheme == "content") {
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
                        }
                    } else if (uri.scheme == "file") uri.lastPathSegment else null
                    promise.resolve(name ?: "")
                } catch (e: Exception) {
                    promise.resolve("")
                }
            }
        }

        AsyncFunction("exportMediaFile") {
                sourceUri: String,
                filename: String,
                album: String,
                video: Boolean,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val context = appContext.reactContext ?: throw Exception("React Context is null")
                    promise.resolve(MediaExporter(context).export(sourceUri, filename, album, video))
                } catch (e: Exception) {
                    promise.reject("ERR_MEDIA_EXPORT", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("atomicReplaceFile") {
                sourceUri: String,
                targetUri: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    promise.resolve(AtomicFileWriter.replace(sourceUri, targetUri))
                } catch (e: Exception) {
                    promise.reject("ERR_ATOMIC_REPLACE", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("getFileSize") {
                path: String,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use { it.getFileSize(path) }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_GET_FILE_SIZE", e.message ?: e.toString(), e)
                }
            }
        }

        AsyncFunction("mixAudioVideo") {
                videoPath: String,
                audioPath: String,
                outputPath: String,
                trim: Map<String, Any?>?,
                promise: Promise ->
            moduleScope.launch {
                try {
                    val result = newProcessor().use {
                        it.muxAudioVideo(videoPath, audioPath, outputPath, trim)
                    }
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_MUX_AUDIO_VIDEO", e.message ?: e.toString(), e)
                }
            }
        }
    }
}
