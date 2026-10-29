# DeepDenoiser Enhanced — Changelog & Technical Notes

## v2.0.0 (2026-10-29)

- Sequential batch processing for up to 20 audio/video files, cooperative stop, per-file retry and persistent results.
- Synchronized original/cleaned audio comparison for untrimmed audio and recordings; video/trimmed audio retain separate players.
- Full-content SHA-256 import identity; non-overwriting outputs; serialized, replacement-written cache/settings indexes.
- Chunk-continuous anti-aliased resampling, metadata-based framing/state names, recording delay compensation, safer media/model lifecycle, deferred permission prompts.
- Pinned Bun and lockfile; regression suite; CI verifies native picker recovery and hashing symbols in APK/AAB DEX.
- Queue is foreground-only; a real-device smoke test is required before release. See `docs/UPGRADE_2.0.md`.


## v1.5.0-enhanced (2026-10-27)

### Hardware Acceleration
- Primary EP: **NNAPI** (Android Neural Networks API)
- Fallback chain: `nnapi` → `xnnpack` → `cpu`
- Automatic hard fallback to pure CPU if advanced providers fail at load time
- Console logging of active providers

### Platform
- minSdkVersion: **26** (Android 8.0)
- ABI: **arm64-v8a only**
- NDK: r28b
- largeHeap enabled
- 16 KB page-size patches retained

### Declutter / Privacy
- Removed: DonationModal, DonationReminderModal, RoastToast, UpdateModal
- Removed Aptabase / analytics completely
- Settings reduced to essential toggles only
- No network calls for telemetry

### CI / Build
- New GitHub Actions workflow (`.github/workflows/android.yml`)
  - Pure Gradle after `expo prebuild`
  - No EAS token required for APK/AAB
  - Caching for Bun + Gradle
  - Artifacts uploaded with 14-day retention
  - Supports debug / release-apk / release-aab via workflow_dispatch

### Stability
- ONNX session is process-lifetime singleton
- Tensor reuse + bounded queues
- Robust model load with double fallback

## How to Build via GitHub Actions

1. Create repo `deepdenoiser-enhanced` under your account
2. Push this tree
3. Go to Actions → "Android Build (Arm64 + NNAPI)" → Run workflow
4. Download the artifact

