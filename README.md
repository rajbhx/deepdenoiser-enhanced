# DeepDenoiser Enhanced 2.0.2

Offline AI audio and video denoising for Android using **DeepFilterNet3** and **ONNX Runtime**. This is a privacy-focused fork of [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser).

## Fixes in 2.0.1

- Correct DeepFilterNet normalization initialization, delay compensation and tail flushing; strength now adjusts an aligned dry/wet mix. Cached audio from older pipelines is not reused.
- Native recordings are retained as the source of truth; live work is bounded and reconciled with the complete original. Open **Your files** from Home to recover recordings, reopen results and manage private copies.
- Android exports use separate Music and Movies destinations. Settings and indexes use same-directory atomic replacement; failed native decoding/muxing is reported rather than published as complete.
- Releases are unsigned unless a user-owned key is configured. CI's debug-signed artifacts are explicitly labeled **testing only**. See [release signing](docs/RELEASE_SIGNING.md).

## Diagnostics (2.0.2 testing build)

Open **Settings → Diagnostics & self-check**. The screen reports device/app status, an attempted model provider, permissions and a previous Android exit reason when available. A manual self-check uses synthetic data and uniquely created private temporary files; it is blocked while the recorder is active or its writer state is uncertain. Optional short runtime comparisons unload/reload the model but do not change saved settings. These checks do not certify audio quality, real background behavior or which hardware actually ran inference.

Up to 50 structured events stay in memory by default. You can opt in to bounded history in app-specific no-backup storage, clear it, and preview a report before copying or sharing. The structured history excludes media, filenames, paths, URIs, media hashes and raw exception text. Other Android/system logs and the existing error dialog may still contain sensitive details. There is no automatic diagnostic upload. Native crashes, process death and the most recent events may not be captured.

GitHub Actions saves the release JS source map and R8 mapping as a separate, time-limited diagnostic artifact alongside the APK. Artifact access follows the GitHub repository's visibility; it is not a private secret vault. Vendor native symbols may be unavailable. See `docs/DIAGNOSTICS.md` for the device checklist, privacy limits and symbolication guidance.

## What's new in 2.0

- **Batch queue:** select up to 20 audio/video files and process them sequentially. Stop safely or retry failed items without losing completed results.
- **A/B audio comparison:** switch between original and cleaned audio at the same playback position, for file processing and voice recordings. When silence trimming changes the timeline, separate players are shown instead.
- **Safer storage:** full-file SHA-256 verified imports, non-overwriting outputs, serialized cache indexes, and persistent recordings. Save or share finished files when you want to keep copies outside the app.
- **Audio and stability:** chunk-independent resampling with anti-alias filtering when downsampling; recording delay compensation; safer model-session and video-player lifecycle; remembered strength settings.
- **Privacy:** processing is on-device. Microphone and media-library permissions are requested only when needed; the app has no configured analytics.
- **Target:** Android 8+ (API 26), arm64-v8a.

**Batch processing runs while the app is open.** It is not a background service and does not resume automatically after the app is killed. Pressing Stop waits for any current Android decode/export step to return. The incoming-share queue is bounded and held in memory; an app process death can lose queued shares, so share them again if necessary. Private app files can be removed by clearing app data or uninstalling; save the results to your device first.

**Recording:** the existing background-recording configuration is retained. The recorder attempts an Android microphone foreground service with a recording notification and a wake lock. OS restrictions, notification permission/settings, service startup failures, battery policies and process death can affect behavior; continuous background recording is not guaranteed. Test the actual notification, interruptions and recovery on target devices.

**Privacy and backup:** media is processed on-device rather than sent to a denoising server. Android Auto Backup or device-to-device transfer may include eligible private app files depending on device and user settings; cache files are generally excluded. Saving or sharing intentionally sends a copy outside the app. This change does not silently disable or alter existing backup policy.

Existing features include DeepFilterNet3, microphone recording with processing during capture, strength presets, pre-denoise gain, optional silence trimming for audio, video audio replacement, runtime/core controls, progress and ETA. Video results use separate players, and silence trim is disabled for video or mixed batches.

Output audio is 48 kHz mono, including downmixed multichannel inputs. Video output contains one video track and the cleaned audio; subtitles, additional tracks and some metadata may be omitted, and unsupported video may be re-encoded at 30 fps. Keep the originals and inspect results. Silence trimming can remove quiet speech or meaningful pauses. For the bundled model, strength mixes aligned cleaned/original signals rather than guaranteeing a measured dB of noise removal: 0 dB is 100% cleaned, 20 dB approximately 10%, and 40 dB approximately 1%.

Working audio can require substantial free space: one mono 48 kHz PCM16 stream is about 330 MiB per hour, so decoded and denoised stages together can need about 659 MiB per hour before the source and outputs. Rebuildable PCM is pruned when idle; originals and finished media are not. Standard WAV's 32-bit data limit is about 12 hours 25 minutes for mono 48 kHz PCM16. These are estimates, not guarantees of available space.

## Recovery and file management

- If recording stops with an uncertain native-writer status, use **Check recorder status**. The app only permits recovery after confirming the writer is idle. If it cannot confirm this, force-stop and reopen the app, then inspect **Your files**. Do not uninstall or clear app data before saving any recording you need.
- Older imported files may need an explicit **Audio** or **Video** choice in **Your files → Imports**. The type can be corrected later; new imports remember it. Reusable decoded/denoised PCM is shown separately in **Your files** and can be cleared without deleting imports, recordings, partial backups or finished results. Android can independently evict cache files, including partial backups, so recover them promptly.
- A share or picker batch accepts up to 20 unique files. Android may offer the app for mixed multiple shares, but non-audio/video items are rejected rather than silently discarded. Saved WAV and MP4 files go to the corresponding **Music** or **Movies** DeepDenoiser folder.

## Build and test

Requires Bun **1.3.6**, Java 17 and Android SDK 36 / NDK r28b. The lockfile and exact native patches are committed.

```bash
bun install --frozen-lockfile --backend=copyfile  # avoid mutating Bun's cache when patch-package runs
bun run typecheck
bun run test
bunx expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease
```

If a previous hard-linked Bun cache causes a patch to fail, remove `node_modules` and reinstall using `--backend=copyfile --cache-dir` pointing to a new, empty directory.

The workflow runs mock regressions, an actual bundled-model CPU test, Java atomic-write/PCM/share-queue tests, and a reproducible npm notice-inventory check; it also verifies native symbols and the signing certificate in the artifact. Without release secrets, the arm64 APK is named `testing-debug-signed` and is **not for production**. Local release builds without a key are unsigned; see [release signing](docs/RELEASE_SIGNING.md). Physical-device testing is still required before release; see [the 2.0 upgrade guide](docs/UPGRADE_2.0.md).

To run the real-model regression separately on a compatible desktop:

```bash
npm install --prefix /tmp/dd-ort --ignore-scripts --no-save --no-package-lock onnxruntime-node@1.24.3
NODE_PATH=/tmp/dd-ort/node_modules node tests/real-model.test.cjs
```

## Hardware notes

For OnePlus 7 / Snapdragon 855, try **Auto or XNNPACK**, **Auto/4 cores**, and **Max or Strong**. The GPU option is a best-effort NNAPI path, not an OpenCL/Vulkan provider; the displayed provider is the attempted configuration, not a guarantee of actual hardware execution.

## Credits and license

Original app: [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser). This fork retains the repository's GPL-3.0 license. The installed npm dependency graph and available notice texts are shown in the app; regenerate with `node scripts/generate-notices.cjs` after a clean locked install. It is **not** a complete native/model license audit. The exact origin and license of the bundled model weights remain unverified, and native/Gradle notices require review before distribution. See [third-party release review](docs/THIRD_PARTY_REVIEW.md).
