# DeepDenoiser Enhanced 2.0.1

Offline AI audio and video denoising for Android using **DeepFilterNet3** and **ONNX Runtime**. This is a privacy-focused fork of [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser).

## Fixes in 2.0.1

- Correct DeepFilterNet normalization initialization, delay compensation and tail flushing; strength now adjusts an aligned dry/wet mix. Cached audio from older pipelines is not reused.
- Native recordings are retained as the source of truth; live work is bounded and reconciled with the complete original. Open **Your files** from Home to recover recordings, reopen results and manage private copies.
- Android exports use separate Music and Movies destinations. Settings and indexes use same-directory atomic replacement; failed native decoding/muxing is reported rather than published as complete.
- Releases are unsigned unless a user-owned key is configured. CI's debug-signed artifacts are explicitly labeled **testing only**. See [release signing](docs/RELEASE_SIGNING.md).

## What's new in 2.0

- **Batch queue:** select up to 20 audio/video files and process them sequentially. Stop safely or retry failed items without losing completed results.
- **A/B audio comparison:** switch between original and cleaned audio at the same playback position, for file processing and voice recordings. When silence trimming changes the timeline, separate players are shown instead.
- **Safer storage:** full-file SHA-256 verified imports, non-overwriting outputs, serialized cache indexes, and persistent recordings. Save or share finished files when you want to keep copies outside the app.
- **Audio and stability:** chunk-independent resampling with anti-alias filtering when downsampling; recording delay compensation; safer model-session and video-player lifecycle; remembered strength settings.
- **Privacy:** processing is on-device. Microphone and media-library permissions are requested only when needed; the app has no configured analytics.
- **Target:** Android 8+ (API 26), arm64-v8a.

**Batch processing runs while the app is open.** It is not a background service and does not resume automatically after the app is killed. Pressing Stop waits for any current Android decode/export step to return. Private app files can be removed by clearing app data or uninstalling; save the results to your device first.

Existing features include DeepFilterNet3, live microphone recording, strength presets, loudness normalization, optional silence trimming for audio, video audio replacement, runtime/core controls, progress and ETA. Video results use separate players, and silence trim is disabled for video or mixed batches.

## Build and test

Requires Bun **1.3.6**, Java 17 and Android SDK 36 / NDK r28b. The lockfile and exact native patches are committed.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bunx expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease
```

The workflow runs mock regressions, an actual bundled-model CPU test, and a Java atomic-write test; it also verifies native symbols and the signing certificate in the artifact. Without release secrets, the arm64 APK is named `testing-debug-signed` and is **not for production**. Local release builds without a key are unsigned; see [release signing](docs/RELEASE_SIGNING.md). Physical-device testing is still required before release; see [the 2.0 upgrade guide](docs/UPGRADE_2.0.md).

To run the real-model regression separately on a compatible desktop:

```bash
npm install --prefix /tmp/dd-ort --ignore-scripts --no-save --no-package-lock onnxruntime-node@1.24.3
NODE_PATH=/tmp/dd-ort/node_modules node tests/real-model.test.cjs
```

## Hardware notes

For OnePlus 7 / Snapdragon 855, try **Auto or XNNPACK**, **Auto/4 cores**, and **Max or Strong**. The GPU option is a best-effort NNAPI path, not an OpenCL/Vulkan provider; the displayed provider is the attempted configuration, not a guarantee of actual hardware execution.

## Credits and license

Original app: [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser); model: DeepFilterNet3. This fork retains the repository's GPL-3.0 license.
