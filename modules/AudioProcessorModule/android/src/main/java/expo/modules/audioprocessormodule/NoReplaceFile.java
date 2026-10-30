package expo.modules.audioprocessormodule;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.channels.FileChannel;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** Publish a closed private file atomically without replacing an existing name. */
public final class NoReplaceFile {
    private NoReplaceFile() {}

    private static Path localPath(String value) throws IOException {
        try {
            URI uri = URI.create(value);
            if (!"file".equalsIgnoreCase(uri.getScheme())) throw new IOException("Only local files can be promoted");
            File file = new File(uri).getAbsoluteFile();
            File parent = file.getParentFile();
            if (parent == null) throw new IOException("Missing parent directory");
            // Canonicalize the directory, but never resolve a final symlink:
            // any occupied destination name must reject instead of being followed.
            return parent.getCanonicalFile().toPath().resolve(file.getName());
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid local file URI", error);
        }
    }

    /**
     * The source remains until the caller removes it. A successful hard link
     * publishes the complete bytes in one operation and never overwrites a
     * competing file. Both paths must be in the same private directory.
     */
    public static boolean link(String sourceUri, String targetUri) throws IOException {
        Path source = localPath(sourceUri);
        Path target = localPath(targetUri);
        if (source.equals(target) || source.getParent() == null || !source.getParent().equals(target.getParent())) {
            throw new IOException("Promotion requires distinct files in the same directory");
        }
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Promotion source must be a regular private file");
        }
        try (FileChannel file = FileChannel.open(source, StandardOpenOption.WRITE)) {
            file.force(true);
        }
        try {
            Files.createLink(target, source);
        } catch (FileAlreadyExistsException occupied) {
            return false;
        }
        try (FileChannel dir = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
            dir.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // The complete target already exists; never report it as a failure.
        }
        return true;
    }
}
