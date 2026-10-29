package expo.modules.audioprocessormodule

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
