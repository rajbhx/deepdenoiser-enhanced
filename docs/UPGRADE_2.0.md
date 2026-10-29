# DeepDenoiser Enhanced 2.0 — upgrade guide

> **2.0.1 update:** Open **Your files** on Home to recover recordings and manage private copies. A bounded live recording queue finishes any missing audio from the complete native WAV after Stop. Saving now uses separate Music and Movies collections. See [release signing](RELEASE_SIGNING.md) before distributing a build.

## Use the upgraded app

1. Open **Import media**. In Android's picker, select one file or long-press to select several (up to 20), then continue.
2. Choose the strength and other audio settings, then start. The queue processes one file at a time and continues past an individual failure. Tap any row to inspect its result; retry restarts only unfinished/failed items.
3. For audio with silence trim disabled, use **Original / Cleaned** to switch at the same playback position. This also works for recordings. Video and silence-trimmed audio use separate players because their timelines may not match.
4. Use **Save to device** or Share for each result. Private copies survive normal cache eviction but clearing app data/uninstalling can remove them.

A batch is foreground-only. It does not persist or resume after process death, and background notifications/automatic resume are not implemented. **Stop processing** is cooperative: an already-running native decode, transcode, or mux operation may finish before it stops. Completed results are retained. Silence trim is unavailable for video and mixed batches to avoid video desynchronization.

## Implementation

- Import streams bytes to a temporary private file and computes SHA-256 in Kotlin before promotion. Equal name/size with different contents cannot be mistaken for the same import. Cache-key versions invalidate old identities and the prior resampler. Completed outputs get non-overwriting names and are not deleted by index pruning.
- Cache and settings read-modify-write operations are serialized; writes use temporary files and atomic same-directory replacement. Scratch cleanup is restricted to old, known, unindexed files and does not sweep picker copies or finished media.
- The streaming resampler carries fractional position/filter state across chunks and low-pass filters downsampling. Frame sizes and state mappings come from model metadata. Recording uses the same initial compensation as file processing.
- Processing checks a cancellation token during inference; partial owned intermediates are cleaned without deleting cached or completed media. On screen unmount the queue is cancelled. The singleton serializes load/release and defers resets while pipelines are active.
- Android back from a video screen pauses, rather than releasing a hook-owned player. Duplicate share-intent handlers share an in-process claim. Permission requests are deferred to recording and saving.
- `expo-document-picker` is pinned and compiled from source so its native pending-promise recovery patch is in the APK. CI checks for both `cancelPendingPick` and `copyFileWithSha256` in DEX, and the lockfile/Bun version are pinned.

## Verification and limitations

The project includes automated checks for picker recovery, streaming resampling and anti-alias rejection, queue ordering/failure/cancellation, synchronized playback switching, content-identity and cache races, settings writes, model lifecycle, named state mapping, and cancellation cleanup. The Android CI builds the real native code.

These tests do **not** replace an Android device test. Before release, install the new APK on representative devices and check: picker/back/double-tap; batch selection and one failed input; cancellation during inference and during native decode; original/cleaned switching (including seek); live record/stop; trimmed audio and video; permissions denied then granted; save/share; app background/foreground; and long files/storage pressure. Listen for clicks, timing, overload recovery and A/V sync. Provider support, codec availability and performance vary by device.
