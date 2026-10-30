package expo.modules.audioprocessormodule

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.linkedin.android.litr.MediaTransformer
import com.linkedin.android.litr.TransformationListener
import com.linkedin.android.litr.TransformationOptions
import com.linkedin.android.litr.analytics.TrackTransformationInfo
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

class MediaProcessor(private val context: Context) : Closeable {

    private val mediaTransformer = MediaTransformer(context.applicationContext)

    /**
     * LiTr owns a HandlerThread and MUST be released. Previously every native
     * call constructed a MediaProcessor (and therefore a transformer) that was
     * never released, leaking a thread per transcode (AUD-03).
     */
    override fun close() {
        try {
            mediaTransformer.release()
        } catch (e: Exception) {
            // Transformer already released / never started — nothing to do.
        }
    }

    private fun getSafeUri(path: String): Uri {
        return try {
            if (path.startsWith("content://")) {
                Uri.parse(path)
            } else if (path.startsWith("file:")) {
                // Uri.parse treats '#'/spaces as URI fragments and truncates
                // the path — build the URI from the raw file path instead so
                // filenames like "song #1.mp3" keep working.
                // Strip the scheme and any empty-authority prefix (//).
                // Handles file:///path, file://path, and file:/path variants.
                val withoutScheme = path.removePrefix("file:")
                val filePath = withoutScheme.removePrefix("//")
                Uri.fromFile(File(Uri.decode(filePath)))
            } else {
                Uri.fromFile(File(path))
            }
        } catch (e: Exception) {
            Uri.parse(path)
        }
    }

    private fun getSafePath(path: String): String {
        return try {
            val uri = getSafeUri(path)
            if (uri.scheme == "file") {
                uri.path ?: path
            } else {
                path
            }
        } catch (e: Exception) {
            path
        }
    }

    private fun setDataSource(extractor: MediaExtractor, path: String) {
        val uri = getSafeUri(path)
        if (uri.scheme == "content" || uri.scheme == "file") {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                extractor.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            }
                    ?: throw Exception("Failed to open data source for URI: $path")
        } else {
            val file = File(getSafePath(path))
            if (!file.exists()) throw Exception("File does not exist: ${file.absolutePath}")
            FileInputStream(file).use { fis -> extractor.setDataSource(fis.fd) }
        }
    }

    private fun setDataSource(retriever: MediaMetadataRetriever, path: String) {
        val uri = getSafeUri(path)
        if (uri.scheme == "content" || uri.scheme == "file") {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                retriever.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            }
                    ?: throw Exception("Failed to open data source for URI: $path")
        } else {
            val file = File(getSafePath(path))
            if (!file.exists()) throw Exception("File does not exist: ${file.absolutePath}")
            FileInputStream(file).use { fis -> retriever.setDataSource(fis.fd) }
        }
    }

    // (1) Audio Extraction & (3) Bitrate Re-encoding
    // Litr handles the demuxing and decoding/encoding pipeline internally.
    suspend fun transcodeAudio(
            inputPath: String,
            outputPath: String,
            targetBitrate: Int? = null
    ): String {
        val requestId = "transcode_${System.currentTimeMillis()}"
        val resumed = AtomicBoolean(false)

        val optionsBuilder =
                TransformationOptions.Builder().setGranularity(MediaTransformer.GRANULARITY_DEFAULT)

        // Get source sample rate to avoid pitch shift
        val extractor = MediaExtractor()
        var sourceSampleRate = 48000
        try {
            setDataSource(extractor, inputPath)
            val audioTrack = findTrackIndex(extractor, "audio/")
            if (audioTrack != -1) {
                val format = extractor.getTrackFormat(audioTrack)
                if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                    sourceSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                }
            }
        } catch (e: Exception) {
            // Fallback to 48000
        } finally {
            extractor.release()
        }

        return suspendCancellableCoroutine { continuation ->
            val listener =
                    object : TransformationListener {
                        override fun onStarted(id: String) {}
                        override fun onProgress(id: String, progress: Float) {}
                        override fun onCompleted(
                                id: String,
                                stats: List<TrackTransformationInfo>?
                        ) {
                            if (resumed.compareAndSet(false, true)) {
                                continuation.resume(outputPath)
                            }
                        }
                        override fun onCancelled(id: String, stats: List<TrackTransformationInfo>?) {
                            if (resumed.compareAndSet(false, true)) {
                                continuation.resumeWithException(Exception("Transformation cancelled"))
                            }
                        }
                        override fun onError(
                                id: String,
                                cause: Throwable?,
                                stats: List<TrackTransformationInfo>?
                        ) {
                            if (resumed.compareAndSet(false, true)) {
                                val message = cause?.message ?: "Unknown Litr Error"
                                continuation.resumeWithException(
                                        Exception("Transcode failed ($inputPath): $message", cause)
                                )
                            }
                        }
                    }

            // For extraction + re-encoding, we isolate the audio track
            // If targetBitrate is set, Litr will re-encode. Otherwise, it pass-throughs.
            mediaTransformer.transform(
                    requestId,
                    getSafeUri(inputPath),
                    getSafeUri(outputPath),
                    null, // Video format (null to drop video)
                    if (targetBitrate != null) createAudioFormat(targetBitrate, sourceSampleRate)
                    else null,
                    listener,
                    optionsBuilder.build()
            )

            continuation.invokeOnCancellation {
                if (resumed.compareAndSet(false, true)) {
                    mediaTransformer.cancel(requestId)
                }
            }
        }
    }

    // Copies a file from any readable URI (file:// or content://) to a
    // destination file:// path. Used to move picked/shared files out of the
    // evictable cache and into app documents before processing.
    suspend fun copyFile(sourcePath: String, destPath: String): String =
            withContext(Dispatchers.IO) {
                val srcUri = getSafeUri(sourcePath)
                val dstUri = getSafeUri(destPath)
                context.contentResolver.openInputStream(srcUri)?.use { input ->
                    context.contentResolver.openOutputStream(dstUri)?.use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var read: Int
                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                        }
                    } ?: throw Exception("Failed to open destination: $destPath")
                } ?: throw Exception("Failed to open source: $sourcePath")
                destPath
            }

    /**
     * Stream the source into private storage while hashing its entire contents.
     * This avoids loading large videos into JS memory and prevents two different
     * files with the same name and size from sharing an import/cache identity.
     */
    suspend fun copyFileWithSha256(sourcePath: String, destPath: String): String =
            withContext(Dispatchers.IO) {
                val srcUri = getSafeUri(sourcePath)
                val dstUri = getSafeUri(destPath)
                val digest = MessageDigest.getInstance("SHA-256")
                try {
                    context.contentResolver.openInputStream(srcUri)?.use { input ->
                        context.contentResolver.openOutputStream(dstUri)?.use { output ->
                            val buffer = ByteArray(64 * 1024)
                            var read: Int
                            while (input.read(buffer).also { read = it } != -1) {
                                if (read == 0) continue
                                digest.update(buffer, 0, read)
                                output.write(buffer, 0, read)
                            }
                        } ?: throw Exception("Failed to open destination: $destPath")
                    } ?: throw Exception("Failed to open source: $sourcePath")
                    digest.digest().joinToString("") { byte ->
                        "%02x".format(byte.toInt() and 0xff)
                    }
                } catch (error: Exception) {
                    if (dstUri.scheme == "file") {
                        try { File(dstUri.path ?: "").delete() } catch (_: Exception) {}
                    }
                    throw error
                }
            }

    /** Stream a file into SHA-256 without copying it or blocking the JS thread. */
    suspend fun fingerprintFile(sourcePath: String): Map<String, Any> =
            withContext(Dispatchers.IO) {
                val uri = getSafeUri(sourcePath)
                fun knownLength(): Long = context.contentResolver
                        .openAssetFileDescriptor(uri, "r")?.use { it.length }
                        ?: throw Exception("Could not open file for integrity verification")
                val before = knownLength()
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        if (read == 0) throw EOFException("No progress while verifying file integrity")
                        digest.update(buffer, 0, read)
                        total += read
                    }
                } ?: throw Exception("Could not read file for integrity verification")
                val after = knownLength()
                if ((before != AssetFileDescriptor.UNKNOWN_LENGTH && before != total) ||
                        (after != AssetFileDescriptor.UNKNOWN_LENGTH && after != total)) {
                    throw Exception("File size changed during integrity verification")
                }
                val hex = digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
                mapOf("sha256" to hex, "bytes" to total)
            }

    // Returns the byte size of any readable URI (file:// or content://), or -1
    // if the size cannot be determined. Used to detect "same file, re-imported"
    // so unchanged inputs can reuse their existing copy (and thus their cached
    // denoise result) instead of being re-processed from scratch.
    suspend fun getFileSize(path: String): Long =
            withContext(Dispatchers.IO) {
                val uri = getSafeUri(path)
                val size =
                        context.contentResolver
                                .openAssetFileDescriptor(uri, "r")
                                ?.use { afd -> afd.length } ?: -1L
                if (size != AssetFileDescriptor.UNKNOWN_LENGTH) {
                    size
                } else {
                    // Some providers report UNKNOWN_LENGTH — fall back to the
                    // plain file path when it is a real file.
                    val file = File(Uri.decode(uri.path ?: ""))
                    if (file.exists()) file.length() else -1L
                }
            }

    // (5) Audio-Video Muxing
    // Combines video from videoPath and audio from audioPath.
    // When `trim` is enabled, the video track is restricted to [startUs, endUs]
    // (the same window the audio was trimmed to) and its timestamps are rebased
    // to the audio timeline so the two tracks stay in sync.
    suspend fun muxAudioVideo(
            videoPath: String,
            audioPath: String,
            outputPath: String,
            trim: Map<String, Any?>? = null
    ): String =
            withContext(Dispatchers.IO) {
                val trimEnabled = (trim?.get("enabled") as? Boolean) ?: false
                val trimStartUs = (trim?.get("startUs") as? Number)?.toLong() ?: 0L
                val trimEndUs = (trim?.get("endUs") as? Number)?.toLong() ?: Long.MAX_VALUE
                var muxer: MediaMuxer? = null
                var videoExtractor: MediaExtractor? = null
                var audioExtractor: MediaExtractor? = null
                var isMuxerStarted = false
                var muxFinalizationError: Exception? = null
                var pfd: ParcelFileDescriptor? = null
                var transcodedTempPath: String? = null

                try {
                    // Setup muxer
                    val outputUri = getSafeUri(outputPath)
                    pfd = context.contentResolver.openFileDescriptor(outputUri, "rwt")
                            ?: throw Exception("Failed to open output file descriptor: $outputPath")
                    
                    muxer = MediaMuxer(pfd.fileDescriptor, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

                    // Setup video extractor
                    videoExtractor = MediaExtractor()
                    try {
                        setDataSource(videoExtractor, videoPath)
                    } catch (e: Exception) {
                        throw Exception("Failed to open video source: $videoPath. ${e.message}")
                    }
                    var videoTrack = findTrackIndex(videoExtractor, "video/")
                    if (videoTrack == -1) throw Exception("No video track found in $videoPath")
                    var videoFormat = videoExtractor.getTrackFormat(videoTrack)

                    // Some video codecs (VP8/VP9, MPEG-1/2, MJPEG, ...) cannot be muxed into an
                    // MP4 container. Re-encode such videos to H.264 first so the mux never fails.
                    if (!canMuxVideo(videoFormat)) {
                        val transcodePath = transcodeVideoToH264(videoPath, videoFormat)
                        transcodedTempPath = transcodePath
                        videoExtractor?.release()
                        videoExtractor = MediaExtractor()
                        try {
                            setDataSource(videoExtractor, transcodePath)
                        } catch (e: Exception) {
                            throw Exception(
                                    "Failed to open transcoded video source: $transcodePath. ${e.message}"
                            )
                        }
                        videoTrack = findTrackIndex(videoExtractor, "video/")
                        if (videoTrack == -1)
                                throw Exception("No video track found in transcoded $transcodePath")
                        videoFormat = videoExtractor.getTrackFormat(videoTrack)
                    }

                    // Preserve video rotation. Read it from the format that is actually
                    // being muxed (the transcoded file may have baked rotation into the
                    // pixels, or kept it as metadata — either way its own rotation is the
                    // ground truth, and the muxer only needs a single hint).
                    var rotation = 0
                    if (videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
                        rotation = videoFormat.getInteger(MediaFormat.KEY_ROTATION)
                    } else {
                        // Fallback to MediaMetadataRetriever
                        val rotationSourcePath = transcodedTempPath ?: videoPath
                        val retriever = MediaMetadataRetriever()
                        try {
                            setDataSource(retriever, rotationSourcePath)
                            val rotationStr =
                                    retriever.extractMetadata(
                                            MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION
                                    )
                            rotation = rotationStr?.toInt() ?: 0
                        } catch (e: Exception) {
                            // Ignore
                        } finally {
                            retriever.release()
                        }
                    }

                    val videoMuxerTrack =
                            try {
                                muxer.addTrack(videoFormat)
                            } catch (e: Exception) {
                                throw Exception(
                                        "Failed to add video track (${videoFormat.getString(MediaFormat.KEY_MIME)}): ${e.message}",
                                        e
                                )
                            }
                    muxer.setOrientationHint(rotation)

                    // Setup audio extractor
                    audioExtractor = MediaExtractor()
                    try {
                        setDataSource(audioExtractor, audioPath)
                    } catch (e: Exception) {
                        throw Exception(
                                "Failed to open audio source: $audioPath. ${e.message ?: e.toString()}"
                        )
                    }
                    val audioTrack = findTrackIndex(audioExtractor, "audio/")
                    if (audioTrack == -1) throw Exception("No audio track found in $audioPath")
                    val audioFormat = audioExtractor.getTrackFormat(audioTrack)
                    val audioMuxerTrack =
                            try {
                                muxer.addTrack(audioFormat)
                            } catch (e: Exception) {
                                throw Exception(
                                        "Failed to add audio track (${audioFormat.getString(MediaFormat.KEY_MIME)}): ${e.message}",
                                        e
                                )
                            }

                    muxer.start()
                    isMuxerStarted = true

                    // Determine max buffer size required by either track
                    val maxVideoSize =
                            if (videoFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                                videoFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                            } else {
                                1 * 1024 * 1024 // 1MB fallback
                            }
                    val maxAudioSize =
                            if (audioFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                                audioFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                            } else {
                                256 * 1024 // 256KB fallback
                            }
                    val bufferSize = Math.max(maxVideoSize, maxAudioSize)
                    val buffer = ByteBuffer.allocate(bufferSize)
                    val bufferInfo = MediaCodec.BufferInfo()

                    videoExtractor.selectTrack(videoTrack)
                    audioExtractor.selectTrack(audioTrack)

                    var videoEOS = false
                    var audioEOS = false
                    var muxIterations = 0
                    val maxMuxIterations = 1_000_000
                    // Once trimming, wait for the first keyframe inside the window
                    // before writing the video track (MediaMuxer + most decoders
                    // need the track to start on a keyframe).
                    var videoTrimStarted = !trimEnabled
                    var videoSamplesWritten = 0
                    var audioSamplesWritten = 0

                    while (!videoEOS || !audioEOS) {
                        if (++muxIterations > maxMuxIterations) {
                            throw Exception("muxAudioVideo exceeded max iterations ($maxMuxIterations)")
                        }
                        val writeVideo =
                                !videoEOS &&
                                        (audioEOS ||
                                                videoExtractor.sampleTime <=
                                                        audioExtractor.sampleTime)

                        if (writeVideo) {
                            val sampleSize = videoExtractor.readSampleData(buffer, 0)
                            if (sampleSize < 0) {
                                videoEOS = true
                            } else {
                                val sampleTimeUs = videoExtractor.sampleTime
                                if (trimEnabled) {
                                    if (sampleTimeUs < trimStartUs || sampleTimeUs > trimEndUs) {
                                        // Outside the trimmed window — drop.
                                        if (!videoExtractor.advance()) videoEOS = true
                                        continue
                                    }
                                    if (!videoTrimStarted) {
                                        val isKeyFrame =
                                                (videoExtractor.sampleFlags and
                                                        MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                                        if (!isKeyFrame) {
                                            // Mid-GOP: wait for the first keyframe.
                                            if (!videoExtractor.advance()) videoEOS = true
                                            continue
                                        }
                                        videoTrimStarted = true
                                    }
                                    bufferInfo.presentationTimeUs = sampleTimeUs - trimStartUs
                                } else {
                                    bufferInfo.presentationTimeUs = sampleTimeUs
                                }
                                bufferInfo.size = sampleSize
                                bufferInfo.offset = 0
                                bufferInfo.flags = videoExtractor.sampleFlags
                                muxer.writeSampleData(videoMuxerTrack, buffer, bufferInfo)
                                videoSamplesWritten++
                                if (!videoExtractor.advance()) videoEOS = true
                            }
                        } else if (!audioEOS) {
                            val sampleSize = audioExtractor.readSampleData(buffer, 0)
                            if (sampleSize < 0) {
                                audioEOS = true
                            } else {
                                bufferInfo.size = sampleSize
                                bufferInfo.offset = 0
                                bufferInfo.presentationTimeUs = audioExtractor.sampleTime
                                bufferInfo.flags = audioExtractor.sampleFlags
                                muxer.writeSampleData(audioMuxerTrack, buffer, bufferInfo)
                                audioSamplesWritten++
                                if (!audioExtractor.advance()) audioEOS = true
                            }
                        }
                    }

                    if (videoSamplesWritten == 0 || audioSamplesWritten == 0) {
                        throw Exception("Muxed file would have an empty video or audio track")
                    }
                } finally {
                    if (isMuxerStarted) {
                        try { muxer?.stop() } catch (e: Exception) { muxFinalizationError = e }
                    }
                    try { muxer?.release() } catch (e: Exception) {
                        if (muxFinalizationError == null) muxFinalizationError = e
                    }
                    videoExtractor?.release()
                    audioExtractor?.release()
                    transcodedTempPath?.let {
                        try {
                            File(it).delete()
                        } catch (e: Exception) {
                            // Ignore
                        }
                    }
                    try {
                        pfd?.close()
                    } catch (e: Exception) {
                        if (muxFinalizationError == null) muxFinalizationError = e
                    }
                }
                muxFinalizationError?.let { throw Exception("Failed to finalize MP4; no output was saved", it) }
                // Verify the finished container before the JS layer promotes it
                // into durable storage. A failure leaves only disposable scratch.
                val verify = MediaExtractor()
                try {
                    setDataSource(verify, outputPath)
                    if (findTrackIndex(verify, "video/") == -1 || findTrackIndex(verify, "audio/") == -1) {
                        throw Exception("Finalized MP4 is missing an audio or video track")
                    }
                } finally { verify.release() }
                outputPath
            }

    // (2) Audio Decoding to Raw PCM
    // Bypasses Litr. Drops down to MediaCodec to get raw byte buffers.
    suspend fun decodeToPCM(inputPath: String, outputPath: String): Map<String, Any> =
            withContext(Dispatchers.IO) {
                var extractor: MediaExtractor? = null
                var codec: MediaCodec? = null
                var outputStream: OutputStream? = null
                var isCodecStarted = false
                var sampleRate = 48000
                var primaryFailure: Throwable? = null

                try {
                    extractor = MediaExtractor()
                    try {
                        setDataSource(extractor, inputPath)
                    } catch (e: Exception) {
                        throw Exception("Failed to open data source ($inputPath): ${e.message}")
                    }

                    var audioTrackIndex = -1
                    var format: MediaFormat? = null

                    for (i in 0 until extractor.trackCount) {
                        val f = extractor.getTrackFormat(i)
                        val mime = f.getString(MediaFormat.KEY_MIME)
                        if (mime?.startsWith("audio/") == true) {
                            audioTrackIndex = i
                            format = f
                            break
                        }
                    }

                    if (audioTrackIndex == -1 || format == null)
                            throw Exception("No audio track found in $inputPath")

                    extractor.selectTrack(audioTrackIndex)
                    val mime = format.getString(MediaFormat.KEY_MIME)
                            ?: throw Exception("MIME type missing for audio track in $inputPath")
                    
                    var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    if (channels <= 0) channels = 1
                    if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    }

                    try {
                        codec = MediaCodec.createDecoderByType(mime)
                    } catch (e: Exception) {
                        throw Exception(
                                "No decoder found for MIME type $mime ($inputPath): ${e.message}"
                        )
                    }

                    val outputUri = getSafeUri(outputPath)
                    outputStream = context.contentResolver.openOutputStream(outputUri)
                            ?: throw Exception("Failed to open output stream: $outputPath")

                    codec.configure(format, null, null, 0)
                    codec.start()
                    isCodecStarted = true

                    val info = MediaCodec.BufferInfo()
                    var isEOS = false
                    var outputEOS = false
                    val timeoutUs = 10000L
                    var consecutiveEosWaits = 0
                    val maxConsecutiveEosWaits = 200 // 2 seconds with no output progress
                    var iterationCount = 0
                    val maxIterations = 1_000_000
                    while (!outputEOS) {
                        if (++iterationCount > maxIterations) {
                            throw Exception("decodeToPCM exceeded max iterations ($maxIterations)")
                        }
                        if (!isEOS) {
                            val inIndex = codec.dequeueInputBuffer(timeoutUs)
                            if (inIndex >= 0) {
                                val buffer = codec.getInputBuffer(inIndex)
                                    ?: throw Exception("Input buffer null for index $inIndex")
                                val sampleSize = extractor.readSampleData(buffer, 0)
                                if (sampleSize < 0) {
                                    codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    isEOS = true
                                } else {
                                    codec.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
                                    extractor.advance()
                                }
                            }
                        }

                        val outIndex = codec.dequeueOutputBuffer(info, timeoutUs)
                        when {
                            outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                                if (isEOS && ++consecutiveEosWaits >= maxConsecutiveEosWaits) {
                                    throw Exception("Decoder stalled before end of stream; incomplete audio was discarded")
                                }
                            }
                            outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                                consecutiveEosWaits = 0
                                val newFormat = codec.outputFormat
                                if (newFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                                    sampleRate = newFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                                }
                                if (newFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                                    channels = newFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                                    if (channels <= 0) channels = 1
                                }
                            }
                            outIndex >= 0 -> {
                                consecutiveEosWaits = 0
                                val outBuffer = codec.getOutputBuffer(outIndex)
                                    ?: throw Exception("Output buffer null for index $outIndex")
                                if (channels > 1 && info.size > 0) {
                                    writeDownmixedMono(outBuffer, info, channels, outputStream!!)
                                } else if (info.size > 0) {
                                    writeMonoChunk(outBuffer, info, outputStream!!)
                                }
                                val flags = info.flags
                                codec.releaseOutputBuffer(outIndex, false)
                                outputEOS = (flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            }
                        }
                    }
                    outputStream?.flush()
                    outputStream?.close()
                    outputStream = null
                } catch (failure: Throwable) {
                    primaryFailure = failure
                    throw failure
                } finally {
                    // A dead media service can make release fail. Still attempt
                    // all remaining releases and preserve the original decode
                    // failure rather than replacing it with a cleanup failure.
                    var cleanupFailure: Throwable? = null
                    fun rememberCleanupFailure(failure: Throwable) {
                        // Never create a self-suppression or cycle if a provider
                        // happens to rethrow the original exception instance.
                        if (failure === primaryFailure) return
                        val first = cleanupFailure
                        if (first == null) cleanupFailure = failure
                        else if (first !== failure) first.addSuppressed(failure)
                    }
                    if (isCodecStarted) {
                        try {
                            codec?.stop()
                        } catch (_: Exception) {
                            // A codec in an error state may already be stopped.
                        } catch (failure: Throwable) {
                            rememberCleanupFailure(failure)
                        }
                    }
                    try { codec?.release() } catch (failure: Throwable) { rememberCleanupFailure(failure) }
                    try { extractor?.release() } catch (failure: Throwable) { rememberCleanupFailure(failure) }
                    try { outputStream?.close() } catch (failure: Throwable) { rememberCleanupFailure(failure) }
                    cleanupFailure?.let { failure ->
                        val original = primaryFailure
                        if (original == null) throw failure
                        if (original !== failure) original.addSuppressed(failure)
                    }
                }
                mapOf("path" to outputPath, "sampleRate" to sampleRate)
            }

    // (4) PCM to WAV Conversion
    // Appends the 44-byte RIFF header to a raw PCM file.
    // When `silenceTrim` is provided (and enabled), silent pauses in the PCM are
    // detected and removed, shortening the audio. With `removeInternalPauses`
    // pauses in the middle are removed too (audio files); without it only
    // leading/trailing silence is removed (video files — internal cuts would
    // need a video re-encode to stay in sync). The returned map carries the
    // overall trim window (in microseconds, in the original PCM timeline) so
    // callers can apply the SAME window to a paired video track.
    suspend fun pcmToWav(
            pcmPath: String,
            wavPath: String,
            sampleRate: Int = 48000,
            channels: Int = 1,
            bitDepth: Int = 16,
            silenceTrim: Map<String, Any?>? = null
    ): Map<String, Any?> =
            withContext(Dispatchers.IO) {
                val pcmUri = getSafeUri(pcmPath)
                val wavUri = getSafeUri(wavPath)
                
                var pcmDataLength: Long = 0
                context.contentResolver.openAssetFileDescriptor(pcmUri, "r")?.use { afd ->
                    pcmDataLength = afd.length
                } ?: throw Exception("Failed to open PCM input file: $pcmPath")
                
                if (pcmDataLength == AssetFileDescriptor.UNKNOWN_LENGTH) {
                    // Fallback: manually calculate length if AFDs don't report it (rare for local files)
                    context.contentResolver.openInputStream(pcmUri)?.use { isStream ->
                        pcmDataLength = 0
                        val skipBuffer = ByteArray(8192)
                        var read: Int
                        while (isStream.read(skipBuffer).also { read = it } != -1) {
                            pcmDataLength += read
                        }
                    } ?: throw Exception("Failed to calculate PCM data length: $pcmPath")
                }

                // This implementation writes mono PCM16 only. Reject empty,
                // misaligned and >RIFF-limit inputs instead of wrapping lengths.
                if (channels != 1 || bitDepth != 16 || sampleRate <= 0 || sampleRate > Int.MAX_VALUE / 2) {
                    throw Exception("WAV conversion requires a valid sample rate and mono 16-bit PCM")
                }
                PcmIntegrity.validateMonoPcm16Length(pcmDataLength)

                // ---- Silence trim analysis (16-bit mono PCM only) ----
                // When enabled, silent runs of at least `minSilenceMs` are removed.
                // For audio files internal pauses (not just head/tail) are removed,
                // which shortens the audio. The analysis is a SINGLE read pass:
                // per-frame RMS values stay in memory, so the auto threshold and the
                // kept segments are computed without re-reading the file — the trim
                // runs only at finalization and adds one cheap pass over the PCM.
                var trimStartSample = 0L
                var trimEndSample = max(0L, pcmDataLength / 2 - 1)
                var trimmed = false
                var trimSegments: List<Pair<Long, Long>>? = null
                val frameSamples = max(1, sampleRate / 100) // 10 ms frames
                val trimEnabled = (silenceTrim?.get("enabled") as? Boolean) ?: false
                if (trimEnabled && bitDepth == 16 && channels == 1 && trimEndSample > 0) {
                    val mode = silenceTrim["mode"] as? String ?: "auto"
                    val manualThresholdDb =
                            (silenceTrim["thresholdDb"] as? Number)?.toDouble() ?: -40.0
                    val minSilenceMs =
                            ((silenceTrim["minSilenceMs"] as? Number)?.toInt() ?: 300)
                    val removeInternalPauses =
                            (silenceTrim["removeInternalPauses"] as? Boolean) ?: false
                    val totalSamples = trimEndSample + 1
                    val minSilenceSamples = minSilenceMs.toLong() * sampleRate / 1000

                    // One read pass: per-frame RMS + histogram (for the auto
                    // threshold). The histogram is cheap to keep alongside.
                    var frameDb = FloatArray(1024)
                    var frameCount = 0
                    val histogram = IntArray(241)
                    forEachFrameRms(pcmUri, pcmDataLength, frameSamples) { db ->
                        if (frameCount == frameDb.size) {
                            frameDb = frameDb.copyOf(frameDb.size * 2)
                        }
                        frameDb[frameCount++] = db.toFloat()
                        histogram[((db + 120.0).coerceIn(0.0, 120.0)).toInt()]++
                    }
                    val thresholdDb =
                            if (mode == "manual") {
                                manualThresholdDb
                            } else {
                                autoThresholdFromHistogram(histogram, frameCount.toLong())
                            }

                    val segments =
                            trimSegmentsFromFrames(
                                    frameDb,
                                    frameCount,
                                    frameSamples,
                                    thresholdDb,
                                    minSilenceSamples,
                                    removeInternalPauses
                            )
                    if (segments.isNotEmpty()) {
                        val segs =
                                segments.map {
                                    it.first * frameSamples to
                                            min(
                                                    it.second * frameSamples + frameSamples - 1,
                                                    totalSamples - 1
                                            )
                                }
                        trimSegments = segs
                        trimStartSample = segs.first().first
                        trimEndSample = segs.last().second
                        trimmed =
                                trimStartSample > 0 ||
                                        trimEndSample < totalSamples - 1 ||
                                        segs.size > 1
                    }
                    // All-silent file (no segments) → keep the whole recording.
                }
                if (trimStartSample > trimEndSample) {
                    // Safety: never produce an empty WAV.
                    trimStartSample = 0L
                    trimEndSample = max(0L, pcmDataLength / 2 - 1)
                    trimSegments = null
                    trimmed = false
                }

                val segmentBytes: Long =
                        trimSegments?.sumOf { (it.second - it.first + 1) * 2 } ?: 0L
                val trimmedDataLength =
                        if (trimSegments != null && trimSegments.size > 1) segmentBytes
                        else (trimEndSample - trimStartSample + 1) * 2
                val totalDataLength = trimmedDataLength + 36
                val byteRate = (sampleRate * channels * bitDepth) / 8

                context.contentResolver.openInputStream(pcmUri)?.use { inputStream ->
                    context.contentResolver.openOutputStream(wavUri)?.use { outputStream ->
                        writeWavHeader(
                                outputStream,
                                trimmedDataLength,
                                totalDataLength,
                                sampleRate,
                                channels,
                                byteRate,
                                bitDepth
                        )
                        if (trimmed && trimSegments != null) {
                            // Single and multiple segments both need cut-edge fades.
                            // Use the complete source length, not the last kept sample.
                            PcmIntegrity.copyTrimmedSegments(
                                    inputStream,
                                    outputStream,
                                    trimSegments.map { it.first }.toLongArray(),
                                    trimSegments.map { it.second }.toLongArray(),
                                    pcmDataLength / 2,
                                    sampleRate
                            )
                        } else {
                            PcmIntegrity.skipExactly(inputStream, trimStartSample * 2)
                            PcmIntegrity.copyExactly(inputStream, outputStream, trimmedDataLength)
                        }
                    } ?: throw Exception("Failed to open WAV output stream: $wavPath")
                } ?: throw Exception("Failed to open PCM input stream: $pcmPath")

                // An input can change between trim analysis and final copying.
                // Re-check known lengths before reporting the output as ready.
                context.contentResolver.openAssetFileDescriptor(pcmUri, "r")?.use { afd ->
                    if (afd.length != AssetFileDescriptor.UNKNOWN_LENGTH && afd.length != pcmDataLength) {
                        throw Exception("PCM file size changed during WAV conversion")
                    }
                } ?: throw Exception("PCM input disappeared during WAV conversion")
                context.contentResolver.openAssetFileDescriptor(wavUri, "r")?.use { afd ->
                    if (afd.length != AssetFileDescriptor.UNKNOWN_LENGTH && afd.length != trimmedDataLength + 44L) {
                        throw Exception("Incomplete WAV output; no file was saved")
                    }
                } ?: throw Exception("Could not verify WAV output")

                mapOf(
                        "path" to wavPath,
                        "trimStartUs" to trimStartSample * 1_000_000L / sampleRate,
                        "trimEndUs" to (trimEndSample + 1) * 1_000_000L / sampleRate,
                        "trimmed" to trimmed
                )
            }

    /**
     * Streams the 16-bit LE PCM and invokes [onFrameDb] with the RMS of every
     * frame in dBFS. A trailing partial frame is included.
     */
    private fun forEachFrameRms(
            uri: Uri,
            expectedBytes: Long,
            frameSamples: Int,
            onFrameDb: (Double) -> Unit
    ) {
        context.contentResolver.openInputStream(uri)?.use { input ->
            // The helper retains odd bytes across reads and rejects early EOF.
            PcmIntegrity.forEachFrameRms(input, expectedBytes, frameSamples) { db -> onFrameDb(db) }
        } ?: throw Exception("Failed to open PCM input stream for analysis: $uri")
    }

    /**
     * Auto threshold: 8 dB above the 25th percentile of the frame-RMS
     * distribution (a robust estimate of the quiet/noise floor), clamped into a
     * conservative window.
     *
     * The clamp limits the threshold to -45..-35 dBFS instead of using a
     * peak-relative cap, but it cannot guarantee that quiet speech or meaningful
     * pauses will be preserved. Silence trimming is optional; keep the original
     * and listen to the result.
     */
    private fun autoThresholdFromHistogram(histogram: IntArray, frameCount: Long): Double {
        if (frameCount <= 0) return -45.0
        val target = (frameCount * 25) / 100
        var cum = 0L
        var p25Bin = 120
        for (b in histogram.indices) {
            cum += histogram[b]
            if (cum >= target) {
                p25Bin = b
                break
            }
        }
        val p25 = p25Bin - 120 + 0.5
        return (p25 + 8.0).coerceIn(-45.0, -35.0)
    }

    /**
     * Walks the per-frame RMS values and returns the runs of non-silent frames
     * to KEEP as (startFrame, endFrame) pairs. Silent runs shorter than
     * [minSilenceSamples] are merged into the kept audio (normal speech rhythm is
     * preserved); longer silent runs are dropped entirely — the audio is shortened
     * by exactly those pauses. When [removeInternalPauses] is false only
     * leading/trailing silence is dropped (a video track cannot be cut in the
     * middle without re-encoding to stay in sync).
     */
    private fun trimSegmentsFromFrames(
            frameDb: FloatArray,
            frameCount: Int,
            frameSamples: Int,
            thresholdDb: Double,
            minSilenceSamples: Long,
            removeInternalPauses: Boolean
    ): List<Pair<Long, Long>> {
        val segments = mutableListOf<Pair<Long, Long>>()
        var runStart = -1L
        var i = 0
        while (i < frameCount) {
            if (frameDb[i] >= thresholdDb) {
                if (runStart == -1L) runStart = i.toLong()
                i++
            } else {
                var j = i
                while (j < frameCount && frameDb[j] < thresholdDb) j++
                val gapSamples = (j - i).toLong() * frameSamples
                val isLeading = runStart == -1L
                val isTrailing = j == frameCount
                val canSplit = removeInternalPauses || isLeading || isTrailing
                if (canSplit && gapSamples >= minSilenceSamples) {
                    if (!isLeading) segments.add(runStart to (i - 1).toLong())
                    runStart = -1L
                } else if (isLeading) {
                    // Short leading silence: keep the whole head, from frame 0.
                    runStart = 0L
                }
                i = j
            }
        }
        if (runStart != -1L) {
            segments.add(runStart to (frameCount - 1).toLong())
        }
        return segments
    }

    private fun writeWavHeader(
            os: OutputStream,
            pcmDataLength: Long,
            totalDataLength: Long,
            sampleRate: Int,
            channels: Int,
            byteRate: Int,
            bitDepth: Int
    ) {
        val header = ByteArray(44)
        header[0] = 'R'.code.toByte()
        header[1] = 'I'.code.toByte()
        header[2] = 'F'.code.toByte()
        header[3] = 'F'.code.toByte()
        header[4] = (totalDataLength and 0xffL).toByte()
        header[5] = ((totalDataLength shr 8) and 0xffL).toByte()
        header[6] = ((totalDataLength shr 16) and 0xffL).toByte()
        header[7] = ((totalDataLength shr 24) and 0xffL).toByte()
        header[8] = 'W'.code.toByte()
        header[9] = 'A'.code.toByte()
        header[10] = 'V'.code.toByte()
        header[11] = 'E'.code.toByte()
        header[12] = 'f'.code.toByte()
        header[13] = 'm'.code.toByte()
        header[14] = 't'.code.toByte()
        header[15] = ' '.code.toByte()
        header[16] = 16 // Subchunk1Size (16 for PCM)
        header[17] = 0
        header[18] = 0
        header[19] = 0
        header[20] = 1 // AudioFormat 1 = PCM
        header[21] = 0
        header[22] = channels.toByte()
        header[23] = 0
        header[24] = (sampleRate and 0xff).toByte()
        header[25] = ((sampleRate shr 8) and 0xff).toByte()
        header[26] = ((sampleRate shr 16) and 0xff).toByte()
        header[27] = ((sampleRate shr 24) and 0xff).toByte()
        header[28] = (byteRate and 0xff).toByte()
        header[29] = ((byteRate shr 8) and 0xff).toByte()
        header[30] = ((byteRate shr 16) and 0xff).toByte()
        header[31] = ((byteRate shr 24) and 0xff).toByte()
        header[32] = ((channels * bitDepth) / 8).toByte()
        header[33] = 0 // block align
        header[34] = bitDepth.toByte()
        header[35] = 0 // bits per sample
        header[36] = 'd'.code.toByte()
        header[37] = 'a'.code.toByte()
        header[38] = 't'.code.toByte()
        header[39] = 'a'.code.toByte()
        header[40] = (pcmDataLength and 0xffL).toByte()
        header[41] = ((pcmDataLength shr 8) and 0xffL).toByte()
        header[42] = ((pcmDataLength shr 16) and 0xffL).toByte()
        header[43] = ((pcmDataLength shr 24) and 0xffL).toByte()
        os.write(header, 0, 44)
    }

    private fun writeDownmixedMono(
            buffer: ByteBuffer,
            info: MediaCodec.BufferInfo,
            channels: Int,
            outputStream: OutputStream
    ) {
        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        val shortBuffer = buffer.asShortBuffer()
        val numFrames = shortBuffer.remaining() / channels
        if (numFrames > 0) {
            val monoBuffer = ByteBuffer.allocate(numFrames * 2)
            monoBuffer.order(java.nio.ByteOrder.LITTLE_ENDIAN)
            for (f in 0 until numFrames) {
                var sum = 0
                for (c in 0 until channels) {
                    if (shortBuffer.hasRemaining()) {
                        sum += shortBuffer.get()
                    }
                }
                monoBuffer.putShort((sum / channels).toShort())
            }
            outputStream.write(monoBuffer.array())
        }
    }

    private fun writeMonoChunk(
            buffer: ByteBuffer,
            info: MediaCodec.BufferInfo,
            outputStream: OutputStream
    ) {
        val chunk = ByteArray(info.size)
        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        buffer.get(chunk)
        outputStream.write(chunk)
    }

    private fun findTrackIndex(extractor: MediaExtractor, mimeTypePrefix: String): Int {
        for (i in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(i)
            if (format.getString(MediaFormat.KEY_MIME)?.startsWith(mimeTypePrefix) == true) {
                return i
            }
        }
        return -1
    }

    private fun createAudioFormat(bitrate: Int, sampleRate: Int = 48000): MediaFormat {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1)
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        return format
    }

    // Whether this video track can be muxed into an MP4 container as-is.
    // NOTE: VP8/VP9 are NOT muxable into MP4 (only WebM) — they must be
    // transcoded to H.264 first, otherwise MediaMuxer throws
    // "Failed to add the track to the muxer".
    private fun canMuxVideo(format: MediaFormat): Boolean {
        val mime = format.getString(MediaFormat.KEY_MIME) ?: return false
        val muxable =
                mime == MediaFormat.MIMETYPE_VIDEO_AVC ||
                        mime == MediaFormat.MIMETYPE_VIDEO_HEVC ||
                        mime == MediaFormat.MIMETYPE_VIDEO_MPEG4 ||
                        mime == MediaFormat.MIMETYPE_VIDEO_H263
        if (!muxable) return false
        // AVC/HEVC muxing requires codec-specific data (SPS/PPS) in the format
        if (mime == MediaFormat.MIMETYPE_VIDEO_AVC || mime == MediaFormat.MIMETYPE_VIDEO_HEVC) {
            if (format.getByteBuffer("csd-0") == null) return false
            if (mime == MediaFormat.MIMETYPE_VIDEO_AVC && format.getByteBuffer("csd-1") == null)
                    return false
        }
        return true
    }

    // Re-encodes an unsupported video track to H.264 MP4 so MediaMuxer can
    // accept it. Audio is re-encoded to AAC too (some sources carry codecs,
    // e.g. Opus, that also cannot be muxed into MP4).
    private suspend fun transcodeVideoToH264(
            inputPath: String,
            sourceFormat: MediaFormat
    ): String {
        val outputFile = File(context.cacheDir, "remux_${System.currentTimeMillis()}.mp4")
        val requestId = "remux_video_${System.currentTimeMillis()}"
        val resumed = AtomicBoolean(false)

        val width =
                if (sourceFormat.containsKey(MediaFormat.KEY_WIDTH)) {
                    sourceFormat.getInteger(MediaFormat.KEY_WIDTH)
                } else {
                    1920
                }
        val height =
                if (sourceFormat.containsKey(MediaFormat.KEY_HEIGHT)) {
                    sourceFormat.getInteger(MediaFormat.KEY_HEIGHT)
                } else {
                    1080
                }
        val bitrate =
                when {
                    height >= 1080 -> 8_000_000
                    height >= 720 -> 5_000_000
                    else -> 2_500_000
                }
        val videoFormat =
                MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
        videoFormat.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        videoFormat.setInteger(MediaFormat.KEY_FRAME_RATE, 30)
        videoFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)

        val audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 2)
        audioFormat.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)

        val optionsBuilder =
                TransformationOptions.Builder()
                        .setGranularity(MediaTransformer.GRANULARITY_DEFAULT)

        return try {
            suspendCancellableCoroutine { continuation ->
                val listener =
                        object : TransformationListener {
                            override fun onStarted(id: String) {}
                            override fun onProgress(id: String, progress: Float) {}
                            override fun onCompleted(
                                    id: String,
                                    stats: List<TrackTransformationInfo>?
                            ) {
                                if (resumed.compareAndSet(false, true)) {
                                    continuation.resume(outputFile.absolutePath)
                                }
                            }
                            override fun onCancelled(
                                    id: String,
                                    stats: List<TrackTransformationInfo>?
                            ) {
                                if (resumed.compareAndSet(false, true)) {
                                    continuation.resumeWithException(
                                            Exception("Video transcode cancelled")
                                    )
                                }
                            }
                            override fun onError(
                                    id: String,
                                    cause: Throwable?,
                                    stats: List<TrackTransformationInfo>?
                            ) {
                                if (resumed.compareAndSet(false, true)) {
                                    val message = cause?.message ?: "Unknown Litr Error"
                                    continuation.resumeWithException(
                                            Exception("Video transcode failed ($inputPath): $message", cause)
                                    )
                                }
                            }
                        }

                mediaTransformer.transform(
                        requestId,
                        getSafeUri(inputPath),
                        Uri.fromFile(outputFile),
                        videoFormat,
                        audioFormat,
                        listener,
                        optionsBuilder.build()
                )

                continuation.invokeOnCancellation {
                    // Cancellation already resumes the continuation — just stop
                    // the transform and let the guard swallow late callbacks.
                    if (resumed.compareAndSet(false, true)) {
                        mediaTransformer.cancel(requestId)
                    }
                }
            }
            outputFile.absolutePath
        } catch (e: Exception) {
            // Never leave a half-written remux temp file behind.
            try {
                outputFile.delete()
            } catch (ignore: Exception) {
            }
            throw e
        }
    }

    // (6) Direct WAV PCM extraction (bypassed MediaExtractor)
    // Reads a RIFF/WAVE file directly, extracts PCM, downmixes to mono 16-bit.
    suspend fun extractWavAudio(inputPath: String, outputPath: String): Map<String, Any> =
        withContext(Dispatchers.IO) {
            val inputUri = getSafeUri(inputPath)
            val outputUri = getSafeUri(outputPath)

            var sampleRate = 48000
            var channels = 1
            var bitDepth = 16
            var audioFormat = 1
            var foundFmt = false
            var foundData = false

            context.contentResolver.openInputStream(inputUri)?.use { rawStream ->
                BufferedInputStream(rawStream).use { stream ->

                    val riffHeader = ByteArray(12)
                    readFully(stream, riffHeader)
                    if (String(riffHeader, 0, 4, Charsets.US_ASCII) != "RIFF" ||
                        String(riffHeader, 8, 4, Charsets.US_ASCII) != "WAVE") {
                        throw Exception("Not a valid WAV file: $inputPath")
                    }

                    context.contentResolver.openOutputStream(outputUri)?.use { outputStream ->
                        val chunkId = ByteArray(4)
                        val chunkSizeBytes = ByteArray(4)

                        while (true) {
                            try {
                                readFully(stream, chunkId)
                                readFully(stream, chunkSizeBytes)
                            } catch (e: EOFException) {
                                break
                            }

                            val id = String(chunkId, 0, 4, Charsets.US_ASCII)
                            val size = readInt32LE(chunkSizeBytes, 0).toLong() and 0xFFFFFFFFL
                            val paddedSize = size + (size % 2L)

                            when (id) {
                                "fmt " -> {
                                    if (size < 16) throw Exception("Invalid WAV fmt chunk in $inputPath")
                                    val fmtData = ByteArray(16)
                                    readFully(stream, fmtData)
                                    audioFormat = readInt16LE(fmtData, 0)
                                    channels = readInt16LE(fmtData, 2)
                                    sampleRate = readInt32LE(fmtData, 4)
                                    bitDepth = readInt16LE(fmtData, 14)
                                    if (channels !in 1..32 || sampleRate <= 0 ||
                                            bitDepth !in listOf(8, 16, 24, 32) ||
                                            (audioFormat != 1 && !(audioFormat == 3 && bitDepth == 32))) {
                                        throw Exception("Unsupported WAV sample format in $inputPath")
                                    }
                                    foundFmt = true

                                    val skipBytes = paddedSize - 16L
                                    if (skipBytes > 0) skipExact(stream, skipBytes)
                                }
                                "data" -> {
                                    if (!foundFmt) {
                                        throw Exception("Invalid WAV: data before fmt in $inputPath")
                                    }
                                    foundData = true

                                    val bytesPerSample = bitDepth / 8
                                    val frameSize = channels * bytesPerSample
                                    if (size == 0L || size % frameSize != 0L) {
                                        throw Exception("Invalid or incomplete WAV data frames in $inputPath")
                                    }
                                    // Buffer and each request must end on a complete frame,
                                    // including for 24-bit and multichannel inputs.
                                    val buffer = ByteArray((8192 / frameSize) * frameSize)
                                    var remaining = size
                                    while (remaining > 0) {
                                        val toRead = minOf(buffer.size.toLong(), remaining).toInt()
                                        var totalRead = 0
                                        while (totalRead < toRead) {
                                            val n = stream.read(buffer, totalRead, toRead - totalRead)
                                            if (n <= 0) throw EOFException("Unexpected end of WAV data in $inputPath")
                                            totalRead += n
                                        }
                                        val frames = totalRead / frameSize
                                        processPcmFrames(
                                            buffer, frames, frameSize, channels, bytesPerSample,
                                            bitDepth, audioFormat, outputStream, inputPath
                                        )
                                        remaining -= totalRead.toLong()
                                    }

                                    if (size % 2L != 0L && stream.read() == -1) {
                                        throw EOFException("Missing WAV data padding in $inputPath")
                                    }
                                }
                                else -> {
                                    if (paddedSize > 0) skipExact(stream, paddedSize)
                                }
                            }
                        }

                        if (!foundData) throw Exception("No audio data chunk found in $inputPath")
                    } ?: throw Exception("Failed to open PCM output: $outputPath")
                }
            } ?: throw Exception("Failed to open WAV input: $inputPath")

            mapOf("path" to outputPath, "sampleRate" to sampleRate)
        }

    private fun processPcmFrames(
        buffer: ByteArray,
        frames: Int,
        frameSize: Int,
        channels: Int,
        bytesPerSample: Int,
        bitDepth: Int,
        audioFormat: Int,
        outputStream: OutputStream,
        inputPath: String
    ) {
        // The caller supplies at most one bounded input block. Write its mono
        // output together rather than making two file writes per audio sample.
        val monoBlock = ByteArray(frames * 2)
        for (f in 0 until frames) {
            val offset = f * frameSize
            var sum = 0L
            for (c in 0 until channels) {
                val sampleOffset = offset + c * bytesPerSample
                val sample = when {
                    bitDepth <= 8 -> ((buffer[sampleOffset].toInt() and 0xFF) - 128L) shl 8
                    // Header fields are unsigned, but PCM16 samples are signed.
                    bitDepth <= 16 -> readInt16LE(buffer, sampleOffset).toShort().toLong()
                    bitDepth <= 24 -> {
                        val v = (buffer[sampleOffset].toInt() and 0xFF) or
                                ((buffer[sampleOffset + 1].toInt() and 0xFF) shl 8) or
                                ((buffer[sampleOffset + 2].toInt() and 0xFF) shl 16)
                        (if (v and 0x800000 != 0) v or 0xFF000000.toInt() else v).toLong() shr 8
                    }
                    bitDepth == 32 && audioFormat == 3 -> {
                        val fv = ByteBuffer.wrap(buffer, sampleOffset, 4)
                            .order(ByteOrder.LITTLE_ENDIAN).getFloat()
                        (fv.coerceIn(-1f, 1f) * 32767f).toLong()
                    }
                    bitDepth >= 32 -> readInt32LE(buffer, sampleOffset).toLong() shr 16
                    else -> throw Exception("Unsupported bit depth: $bitDepth in $inputPath")
                }
                sum += sample
            }

            val mono = (sum / channels)
                .coerceIn(Short.MIN_VALUE.toLong(), Short.MAX_VALUE.toLong())
                .toShort()
            monoBlock[f * 2] = mono.toByte()
            monoBlock[f * 2 + 1] = (mono.toInt() shr 8).toByte()
        }
        outputStream.write(monoBlock)
    }

    private fun readFully(stream: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val read = stream.read(buffer, offset, buffer.size - offset)
            if (read <= 0) throw EOFException("Unexpected end of stream")
            offset += read
        }
    }

    private fun skipExact(stream: InputStream, count: Long) {
        PcmIntegrity.skipExactly(stream, count)
    }

    private fun readInt16LE(buffer: ByteArray, offset: Int): Int {
        return (buffer[offset].toInt() and 0xFF) or
                ((buffer[offset + 1].toInt() and 0xFF) shl 8)
    }

    private fun readInt32LE(buffer: ByteArray, offset: Int): Int {
        return (buffer[offset].toInt() and 0xFF) or
                ((buffer[offset + 1].toInt() and 0xFF) shl 8) or
                ((buffer[offset + 2].toInt() and 0xFF) shl 16) or
                ((buffer[offset + 3].toInt() and 0xFF) shl 24)
    }
}
