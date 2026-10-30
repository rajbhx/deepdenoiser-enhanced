package expo.modules.audioprocessormodule;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Exact, bounded PCM I/O shared by Android WAV finalization and JVM tests. */
public final class PcmIntegrity {
    private PcmIntegrity() {}

    // RIFF's 32-bit chunk-size field contains the data length plus 36 bytes.
    public static final long MAX_PCM_WAV_BYTES = 0xffffffffL - 36L;

    public static void validateMonoPcm16Length(long size) throws IOException {
        if (size <= 0 || (size & 1L) != 0L) {
            throw new IOException("Invalid or empty 16-bit PCM byte length");
        }
        if (size > MAX_PCM_WAV_BYTES) {
            throw new IOException("Audio is too large for a standard WAV file; split it before converting");
        }
    }

    public static void copyExactly(InputStream input, OutputStream output, long bytes) throws IOException {
        if (bytes < 0) throw new IOException("Invalid PCM copy length");
        byte[] buffer = new byte[64 * 1024];
        long remaining = bytes;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read <= 0) throw new EOFException("Incomplete file read while copying media");
            output.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static MessageDigest sha256() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IOException("SHA-256 is unavailable", error); }
    }

    /** Copy exactly the expected bytes while fingerprinting the bytes actually copied. */
    public static byte[] copyAndHashExactly(InputStream input, OutputStream output, long bytes) throws IOException {
        MessageDigest digest = sha256();
        copyExactly(new DigestInputStream(input, digest), output, bytes);
        return digest.digest();
    }

    /** Re-read a source and detect both content changes and unexpected trailing bytes. */
    public static byte[] hashExactly(InputStream input, long bytes) throws IOException {
        MessageDigest digest = sha256();
        DigestInputStream hashing = new DigestInputStream(input, digest);
        copyExactly(hashing, new OutputStream() {
            @Override public void write(int ignored) {}
            @Override public void write(byte[] buffer, int offset, int length) {}
        }, bytes);
        if (hashing.read() != -1) throw new IOException("File grew during integrity verification");
        return digest.digest();
    }

    public static void skipExactly(InputStream input, long bytes) throws IOException {
        if (bytes < 0) throw new IOException("Invalid PCM skip length");
        byte[] buffer = new byte[8192];
        long remaining = bytes;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read <= 0) throw new EOFException("Incomplete PCM read while skipping audio");
            remaining -= read;
        }
    }

    public static int readInt16(InputStream input) throws IOException {
        int lo = input.read();
        int hi = input.read();
        if (lo < 0 || hi < 0) throw new EOFException("Incomplete PCM read in audio sample");
        return (short) (lo | (hi << 8));
    }

    /**
     * Copy inclusive kept segments, fading only real cut boundaries. Overlapping
     * short fades use the smaller gain, so both ends still reach zero. Original
     * samples and total output length otherwise remain unchanged.
     */
    public static void copyTrimmedSegments(InputStream input, OutputStream output,
            long[] starts, long[] ends, long totalSamples, int sampleRate) throws IOException {
        if (starts == null || ends == null || starts.length == 0 || starts.length != ends.length ||
                totalSamples <= 0 || sampleRate <= 0) throw new IOException("Invalid trim ranges");
        long previousEnd = -1;
        for (int i = 0; i < starts.length; i++) {
            if (starts[i] <= previousEnd || ends[i] < starts[i] || ends[i] >= totalSamples) {
                throw new IOException("Invalid or overlapping trim ranges");
            }
            previousEnd = ends[i];
        }
        int fadeSamples = Math.min(240, Math.max(1, sampleRate / 200));
        int denominator = Math.max(1, fadeSamples - 1);
        previousEnd = -1;
        for (int index = 0; index < starts.length; index++) {
            long start = starts[index], end = ends[index], length = end - start + 1;
            skipExactly(input, (start - previousEnd - 1) * 2);
            boolean fadeIn = start > previousEnd + 1;
            boolean fadeOut = index + 1 < starts.length ? starts[index + 1] > end + 1 : end < totalSamples - 1;
            long head = fadeIn ? Math.min(length, (long) fadeSamples) : 0;
            long tailStart = fadeOut ? Math.max(0, length - fadeSamples) : length;
            long sampleIndex = 0;
            while (sampleIndex < length) {
                if (sampleIndex >= head && sampleIndex < tailStart) {
                    long count = tailStart - sampleIndex;
                    copyExactly(input, output, count * 2);
                    sampleIndex += count;
                    continue;
                }
                int gain = denominator;
                if (fadeIn) gain = (int) Math.min(gain, sampleIndex);
                if (fadeOut) gain = (int) Math.min(gain, length - 1 - sampleIndex);
                int value = readInt16(input) * gain / denominator;
                output.write(value & 0xff);
                output.write((value >> 8) & 0xff);
                sampleIndex++;
            }
            previousEnd = end;
        }
    }

    public interface FrameConsumer { void accept(double rmsDb); }

    /**
     * Scan exactly expectedBytes of PCM16, preserving a byte split across reads.
     * Emits each full frame and, if present, its trailing partial frame.
     */
    public static void forEachFrameRms(InputStream input, long expectedBytes, int frameSamples,
                                       FrameConsumer consumer) throws IOException {
        validateMonoPcm16Length(expectedBytes);
        if (frameSamples <= 0) throw new IOException("Invalid PCM analysis frame size");
        byte[] buffer = new byte[64 * 1024];
        long remaining = expectedBytes;
        int lowByte = -1;
        int samples = 0;
        double sumSquares = 0;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read <= 0) throw new EOFException("Incomplete PCM read during silence analysis");
            remaining -= read;
            for (int i = 0; i < read; i++) {
                int value = buffer[i] & 0xff;
                if (lowByte < 0) {
                    lowByte = value;
                    continue;
                }
                int sample = (short) (lowByte | (value << 8));
                lowByte = -1;
                sumSquares += (double) sample * sample;
                samples++;
                if (samples == frameSamples) {
                    consumer.accept(20.0 * Math.log10(Math.sqrt(sumSquares / samples) / 32768.0));
                    samples = 0;
                    sumSquares = 0;
                }
            }
        }
        if (lowByte >= 0) throw new EOFException("Incomplete PCM sample during silence analysis");
        if (samples > 0) {
            consumer.accept(20.0 * Math.log10(Math.sqrt(sumSquares / samples) / 32768.0));
        }
    }
}
