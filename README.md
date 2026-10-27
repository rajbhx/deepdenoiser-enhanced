# DeepDenoiser Enhanced 1.6

Offline AI audio/video denoiser for Android — **DeepFilterNet3** + **ONNX Runtime**.

Fork of [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser) focused on privacy, OnePlus 7 / arm64 performance, and a cleaner UX.

## Features

| Area | What’s included |
|------|-----------------|
| **Denoise** | DeepFilterNet3 (`.ort`), file + live mic |
| **Strength** | Max / Strong / Med / Light presets + fine dB slider |
| **Runtime** | Auto · XNNPACK · GPU (NNAPI try) · NNAPI · CPU |
| **Cores** | Auto (device hint) or 2 / 4 / 8 threads |
| **Live record** | 40 ms chunks, parallel PCM write, backlog passthrough safety |
| **Process** | Cache reuse, silence trim, loudness normalize, progress + ETA |
| **Privacy** | No analytics, no donation prompts, on-device only |
| **Target** | arm64-v8a · Android 8+ (API 26) |

## OnePlus 7 (SD855 / Adreno 640)

Recommended: **Runtime Auto or XNNPACK**, **Core Auto/4**, **Strength Max or Strong**.

- No OpenCL/Vulkan EP in stock `onnxruntime-react-native`.
- **GPU** option = best-effort Android NNAPI (may still fall back to XNNPACK).
- Logcat lines: `[DeepFilterNet] LOADED engine=...`

## Build

```bash
bun install
bunx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

APK: `android/app/build/outputs/apk/release/`

## Credits

Original app: [sayampy/deepdenoiser](https://github.com/sayampy/deepdenoiser).  
Model: DeepFilterNet3 (Rikorose et al.).
