package expo.modules.audioprocessormodule;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

/** Replace a private JSON file without Expo's delete-before-move behavior. */
public final class AtomicFileWriter {
    private AtomicFileWriter() {}

    private static Path localPath(String value) throws IOException {
        try {
            URI uri = URI.create(value);
            if (!"file".equalsIgnoreCase(uri.getScheme())) throw new IOException("Only local file URIs can be replaced");
            return new File(uri).getCanonicalFile().toPath();
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid local file URI", error);
        }
    }

    public static String replace(String sourceUri, String targetUri) throws IOException {
        Path source = localPath(sourceUri);
        Path target = localPath(targetUri);
        if (source.equals(target) || source.getParent() == null || !source.getParent().equals(target.getParent())) {
            throw new IOException("Atomic replacement requires distinct files in the same directory");
        }
        // The temp is complete and closed before promotion. If sync or rename
        // fails, the previous target remains untouched; do not delete it first.
        try (FileChannel file = FileChannel.open(source, StandardOpenOption.WRITE)) {
            file.force(true);
        }
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        // Best-effort directory fsync for crash durability. Some filesystems do
        // not permit opening directories; the atomic rename has already won.
        try (FileChannel dir = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
            dir.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // Never turn a successful rename into a reported failure.
        }
        return target.toUri().toString();
    }
}
