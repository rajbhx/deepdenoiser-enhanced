import expo.modules.audioprocessormodule.AtomicFileWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;

public class AtomicFileWriterTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("dd-atomic-");
        try {
            Path old = root.resolve("settings.json"), temp = root.resolve("settings.tmp");
            Files.write(old, "old".getBytes(StandardCharsets.UTF_8));
            Files.write(temp, "new".getBytes(StandardCharsets.UTF_8));
            AtomicFileWriter.replace(temp.toUri().toString(), old.toUri().toString());
            check(new String(Files.readAllBytes(old), StandardCharsets.UTF_8).equals("new"), "new value not committed");
            check(!Files.exists(temp), "temporary file not consumed");
            try {
                AtomicFileWriter.replace(temp.toUri().toString(), old.toUri().toString());
                throw new AssertionError("missing source should fail");
            } catch (java.io.IOException expected) {}
            check(new String(Files.readAllBytes(old), StandardCharsets.UTF_8).equals("new"), "failed write destroyed old value");
            Path other = Files.createDirectory(root.resolve("other")).resolve("temp");
            Files.write(other, "other".getBytes(StandardCharsets.UTF_8));
            try {
                AtomicFileWriter.replace(other.toUri().toString(), old.toUri().toString());
                throw new AssertionError("cross-directory replacement should fail");
            } catch (java.io.IOException expected) {}
            check(new String(Files.readAllBytes(old), StandardCharsets.UTF_8).equals("new"), "old value changed");
            check(Files.exists(other), "rejected source should survive");
            Path locked = Files.createDirectory(root.resolve("locked"));
            Path lockedOld = locked.resolve("settings.json"), lockedNew = locked.resolve("settings.tmp");
            Files.write(lockedOld, "before".getBytes(StandardCharsets.UTF_8));
            Files.write(lockedNew, "after".getBytes(StandardCharsets.UTF_8));
            java.util.Set<java.nio.file.attribute.PosixFilePermission> permissions = Files.getPosixFilePermissions(locked);
            try {
                Files.setPosixFilePermissions(locked, java.util.EnumSet.of(
                    java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                    java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE));
                if (!Files.isWritable(locked)) {
                    try {
                        AtomicFileWriter.replace(lockedNew.toUri().toString(), lockedOld.toUri().toString());
                        throw new AssertionError("read-only directory should reject rename");
                    } catch (java.io.IOException expected) {}
                    check(new String(Files.readAllBytes(lockedOld), StandardCharsets.UTF_8).equals("before"), "rename failure destroyed old target");
                    check(Files.exists(lockedNew), "rename failure destroyed new temp");
                }
            } finally { Files.setPosixFilePermissions(locked, permissions); }
            System.out.println("PASS actual Java atomic rename preserves the target on failure");
        } finally {
            try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
            }
        }
    }
}
