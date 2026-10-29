import expo.modules.audioprocessormodule.PcmIntegrity;
import java.io.*;
import java.util.*;

public final class PcmIntegrityTest {
    interface Checked { void run() throws Exception; }
    private static void expectFailure(Checked run, String reason) throws Exception {
        try { run.run(); throw new AssertionError("Expected failure: " + reason); }
        catch (IOException expected) { /* expected */ }
    }
    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }
    private static InputStream shortReads(byte[] data, int max) {
        return new ByteArrayInputStream(data) {
            @Override public synchronized int read(byte[] b, int off, int len) {
                return super.read(b, off, Math.min(len, max));
            }
        };
    }
    public static void main(String[] args) throws Exception {
        byte[] data = { 0, 0, 1, 0, -1, 127, 0, -128, 42, 0 };
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        PcmIntegrity.copyExactly(shortReads(data, 1), out, data.length);
        check(Arrays.equals(data, out.toByteArray()), "short reads must be reassembled exactly");
        ByteArrayOutputStream media = new ByteArrayOutputStream();
        byte[] copiedDigest = PcmIntegrity.copyAndHashExactly(shortReads(data, 3), media, data.length);
        check(Arrays.equals(copiedDigest, PcmIntegrity.hashExactly(shortReads(data, 2), data.length)), "unchanged source verifies");
        byte[] modified = data.clone(); modified[0] ^= 1;
        check(!Arrays.equals(copiedDigest, PcmIntegrity.hashExactly(new ByteArrayInputStream(modified), modified.length)), "same-length mutation changes fingerprint");
        expectFailure(() -> PcmIntegrity.hashExactly(new ByteArrayInputStream(data), data.length - 1), "unexpected trailing bytes");
        expectFailure(() -> PcmIntegrity.hashExactly(new ByteArrayInputStream(data), data.length + 1), "truncated source");
        expectFailure(() -> PcmIntegrity.copyExactly(shortReads(data, 3), new ByteArrayOutputStream(), data.length + 1), "early EOF in copy");
        expectFailure(() -> PcmIntegrity.skipExactly(shortReads(data, 3), data.length + 1), "early EOF in skip");
        expectFailure(() -> PcmIntegrity.readInt16(new ByteArrayInputStream(new byte[]{1})), "early EOF in fade sample");
        PcmIntegrity.skipExactly(shortReads(data, 3), data.length);
        check(PcmIntegrity.readInt16(new ByteArrayInputStream(new byte[]{0, (byte) 128})) == -32768, "signed little-endian sample");
        InputStream stalled = new InputStream() {
            @Override public int read() { return 0; }
            @Override public int read(byte[] b, int o, int l) { return 0; }
        };
        expectFailure(() -> PcmIntegrity.copyExactly(stalled, new ByteArrayOutputStream(), 2), "zero progress");
        expectFailure(() -> PcmIntegrity.validateMonoPcm16Length(0), "empty");
        expectFailure(() -> PcmIntegrity.validateMonoPcm16Length(3), "odd PCM");
        PcmIntegrity.validateMonoPcm16Length(PcmIntegrity.MAX_PCM_WAV_BYTES - 1);
        expectFailure(() -> PcmIntegrity.validateMonoPcm16Length(PcmIntegrity.MAX_PCM_WAV_BYTES + 1), "32-bit WAV overflow");

        List<Double> normal = new ArrayList<>(), oddReads = new ArrayList<>();
        PcmIntegrity.forEachFrameRms(new ByteArrayInputStream(data), data.length, 2, normal::add);
        PcmIntegrity.forEachFrameRms(shortReads(data, 3), data.length, 2, oddReads::add);
        check(normal.equals(oddReads) && normal.size() == 3, "odd read boundaries must not change RMS frames");
        expectFailure(() -> PcmIntegrity.forEachFrameRms(shortReads(data, 3), data.length + 2, 2, value -> {}), "EOF during analysis");
        OutputStream failedOutput = new OutputStream() {
            @Override public void write(int b) throws IOException { throw new IOException("disk full"); }
            @Override public void write(byte[] b, int o, int l) throws IOException { throw new IOException("disk full"); }
        };
        expectFailure(() -> PcmIntegrity.copyExactly(new ByteArrayInputStream(data), failedOutput, data.length), "disk full");
        System.out.println("PASS JVM exact copy, SHA-256 recheck, short/odd reads, analysis, overflow and disk-full regressions");
    }
}
