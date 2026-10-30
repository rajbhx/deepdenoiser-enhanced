import expo.modules.audioprocessormodule.NoReplaceFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public class NoReplaceFileTest {
    static void check(boolean x, String message) { if (!x) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("dd-noreplace-");
        ExecutorService pool = Executors.newFixedThreadPool(12);
        try {
            Path target = root.resolve("destination.wav");
            List<Path> sources = new ArrayList<>();
            List<Future<Boolean>> futures = new ArrayList<>();
            CountDownLatch start = new CountDownLatch(1);
            for (int i = 0; i < 32; i++) {
                Path src = root.resolve("pending-" + i);
                Files.write(src, ("content-" + i).getBytes(StandardCharsets.UTF_8));
                sources.add(src);
                futures.add(pool.submit(() -> { start.await(); return NoReplaceFile.link(src.toUri().toString(), target.toUri().toString()); }));
            }
            start.countDown();
            int wins = 0;
            for (Future<Boolean> future : futures) if (future.get()) wins++;
            check(wins == 1, "exactly one publisher must win");
            String winner = new String(Files.readAllBytes(target), StandardCharsets.UTF_8);
            check(winner.matches("content-\\d+"), "destination must contain a complete winner");
            for (Path src : sources) check(Files.exists(src), "promotion must retain every source");
            Path challenger = root.resolve("challenger");
            Files.write(challenger, "overwrite attempt".getBytes(StandardCharsets.UTF_8));
            check(!NoReplaceFile.link(challenger.toUri().toString(), target.toUri().toString()), "existing destination must reject");
            check(new String(Files.readAllBytes(target), StandardCharsets.UTF_8).equals(winner), "existing file overwritten");
            Path occupiedLink = root.resolve("occupied-link");
            Path absentLinkTarget = root.resolve("must-remain-absent");
            Files.createSymbolicLink(occupiedLink, absentLinkTarget);
            check(!NoReplaceFile.link(challenger.toUri().toString(), occupiedLink.toUri().toString()), "symlink destination must reject");
            check(Files.isSymbolicLink(occupiedLink) && !Files.exists(absentLinkTarget), "must not follow or overwrite a symlink name");
            Path sourceLink = root.resolve("source-link");Files.createSymbolicLink(sourceLink, challenger);
            try { NoReplaceFile.link(sourceLink.toUri().toString(), root.resolve("bad-link").toUri().toString()); throw new AssertionError("symlink source accepted"); }
            catch (java.io.IOException expected) {}
            Path other = Files.createDirectory(root.resolve("other")).resolve("source");
            Files.write(other, "outside".getBytes(StandardCharsets.UTF_8));
            try { NoReplaceFile.link(other.toUri().toString(), root.resolve("bad").toUri().toString()); throw new AssertionError("cross directory accepted"); }
            catch (java.io.IOException expected) {}
            check(Files.exists(other), "rejected source must remain");
            System.out.println("PASS actual Java atomic no-replace links preserve the winner and all competing files");
        } finally {
            pool.shutdownNow();
            try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
            }
        }
    }
}
