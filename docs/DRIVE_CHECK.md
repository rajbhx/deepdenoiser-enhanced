# DeepDenoiser Drive check — 27 Oct 2026

**Scope:** all `deepdenoiser-*` files in your Google Drive, plus the file you linked:
[deepdenoiser-1.6-max.tar.gz](https://drive.google.com/file/d/1nAjUkQA_6OxkYwFoYtkbkkSP72ipgpsY/view)

---

## Short answer

Nothing is broken. What's "going on" is a **single build session**: nine source snapshots of an
Android AI audio-denoising app were uploaded to your Drive root today between **09:53 and 10:51 IST**
(04:23–05:21 UTC). They are nine successive iterations of the same ~15.9 MB project, each one a few
hundred bytes different from the last. The file you linked is the **newest/final** one, `1.6-max`.

They are **source-code tarballs, not APKs** — there is no compiled app anywhere in Drive.

---

## Inventory (newest → oldest, times in IST)

| # | File | Uploaded | Size | MD5 (Drive = local) |
|---|------|----------|------|---------------------|
| 1 | [deepdenoiser-1.6-max.tar.gz](https://drive.google.com/file/d/1nAjUkQA_6OxkYwFoYtkbkkSP72ipgpsY/view) | 10:51:23 | 15,931,485 | `3b977ba5…` ✔ |
| 2 | [deepdenoiser-gpu-option.tar.gz](https://drive.google.com/file/d/1jWsF6ev_gvqr13qxu-CGhaBmYz9j4ky0/view) | 10:48:38 | 15,931,463 | `98e3aaf5…` ✔ |
| 3 | [deepdenoiser-live-ui.tar.gz](https://drive.google.com/file/d/1OZITNtITC_QdxEH6jmT5IAdvbV50USZO/view) | 10:44:41 | 15,931,316 | `466bf63e…` ✔ |
| 4 | [deepdenoiser-multi-runtime.tar.gz](https://drive.google.com/file/d/1pp59vkgyNr9FrDlg02FYg_lZ2lvhs87G/view) | 10:38:40 | 15,929,975 | `e2269a92…` ✔ |
| 5 | [deepdenoiser-oneplus7.tar.gz](https://drive.google.com/file/d/1-oDM9I_Rb12bsgw8qEL1Gj9brclhLLRq/view) | 10:36:35 | 15,929,653 | `75dfc985…` ✔ |
| 6 | [deepdenoiser-core-level.tar.gz](https://drive.google.com/file/d/19FUhHRN1NW1opcNcSWMp0Y0sguxL8wBl/view) | 10:25:06 | 15,929,629 | `c1c41b45…` ✔ |
| 7 | [deepdenoiser-cpu-only-adreno640.tar.gz](https://drive.google.com/file/d/15YGYJzZxYfwtGxmx0pOlgNM7vqLRzNtx/view) | 10:21:32 | 15,928,996 | `948e5c80…` ✔ |
| 8 | [deepdenoiser-enhanced-adreno640.tar.gz](https://drive.google.com/file/d/1TKK3RrEOIFL8RqFYwnR8xwiB3U6VrGdb/view) | 10:17:11 | 15,928,529 | `0a074d3f…` ✔ |
| 9 | [deepdenoiser-enhanced-v1.5.0.tar.gz](https://drive.google.com/file/d/1SdrXjFijoCCimSR_U5-BZH0vmITjhH5Y/view) | 09:53:28 | 15,929,191 | `9ff1e97c…` ✔ |

- **Total:** 143,370,337 bytes (~143 MB / 136.7 MiB) of near-duplicate source snapshots.
- All nine downloaded, passed `gzip -t`, and their **local MD5s match Drive's `md5Checksum`** — no corruption.
- All nine are **private** (only you as owner), have **no comments**, sit in Drive root, and there are no
  shared drives and nothing in the trash. No secrets/API keys/keystores found.

---

## What's inside the linked `1.6-max` archive

`deepdenoiser-full/` — 98 files, ~21 MB uncompressed, 136 tar entries.

- **App:** Expo 57 / React Native 0.86.2 / React 19.2.3, TypeScript, Android-only
  (`arm64-v8a`, minSdk 26, NDK r28b). Package `com.sayampy.deepdenoiser`.
- **AI:** bundled `assets/model/denoiser_model.ort` — a 13.0 MB **DeepFilterNet3** ONNX model
  (plus `model_metadata.json`); ONNX Runtime 1.24.3 with `patch-package` patches for 16 KB page sizes.
- **Features:** file + live-mic denoising, strength presets (Max/Strong/Med/Light), runtime selector
  (Auto / XNNPACK / GPU / NNAPI / CPU), 2/4/8-thread core selector, silence trim, loudness normalize,
  cache reuse, progress/ETA.
- **Privacy:** analytics is a no-op stub; no network calls except two "open GitHub in browser" links.
  Donation/update modals removed. `PRIVACY POLICY.md` present.
- **Build:** `bun install` → `bunx expo prebuild --platform android --clean` → Gradle `assembleRelease`;
  GitHub Actions workflow `.github/workflows/android.yml` builds debug / release APK / AAB without EAS.
- **Not included:** `node_modules/`, `android/`, `ios/`, lockfiles, keystore, `.env`, any APK/AAB.

---

## What actually changed during the session (real file-by-file diff)

| Step | Change |
|------|--------|
| v1.5.0 → enhanced-adreno640 | Removed 16 stray Gradle `build/` intermediates; rewrote `Denoiser.ts` (NNAPI/Adreno 640 path), README, patches |
| → cpu-only-adreno640 | CPU-only fallback + singleton session; settings runtime toggle |
| → core-level | Core/thread selector in `SettingsSidebar.tsx`, `settings.ts`, `denoiserSingleton.ts` |
| → oneplus7 | OnePlus 7 / SD855 tuning in recording screen + sidebar |
| → multi-runtime | Auto / XNNPACK / GPU / NNAPI / CPU runtime chain in `Denoiser.ts` + settings |
| → live-ui | Added `deviceCores.ts`; live recording UI + home screen + sidebar rewrite |
| → gpu-option | GPU/NNAPI best-effort execution provider in `Denoiser.ts` |
| → **1.6-max** | Version bumped to `1.6.0-enhanced`, new Max/Strong/Med/Light strength chips in `advanceSettings.tsx`, ONNX session pre-warmed at app start (`_layout.tsx`), saved `attenLimDb` restored on processing screen, README rewritten |

So the session was one continuous tuning effort aimed at **OnePlus 7 / Snapdragon 855 / Adreno 640**:
trying NNAPI/GPU acceleration, CPU fallback, thread counts, live-record UI, and finally strength presets.

---

## Things worth fixing in `1.6-max`

1. **Three conflicting version numbers.** `package.json` = `1.6.0-enhanced`, `app.json` = `1.5.0`, and
   `app.config.js` hard-overrides `version: '1.4.4'` — that last one wins at build time, so the APK will
   likely report **1.4.4**, not 1.6. `eas.json` also uses `appVersionSource: remote`.
2. **`ENHANCED.md` changelog stops at v1.5.0-enhanced** — nothing documents the 1.6 changes above.
3. **No lockfile** but CI runs `bun install --frozen-lockfile || bun install`; the `||` fallback silently
   defeats reproducibility. `.gitignore` explicitly ignores `*.lock` / `bun.lockb`.
4. **`scripts/reset-project.js` is referenced by the `reset-project` npm script but missing.**
5. **"GPU" is not real GPU.** It's a best-effort NNAPI path (`cpuDisabled: true`) that can fall back to
   XNNPACK; stock `onnxruntime-react-native` has no OpenCL/Vulkan EP. README does say this, but the
   settings label is misleading.
6. **Drive hygiene:** nine ~16 MB snapshots = ~143 MB, of which ~111 MB are superseded intermediates.
   Safe cleanup: keep `1.6-max` (and optionally `enhanced-v1.5.0` as the baseline) and trash the other 7.

I have **not** changed, shared, renamed, or deleted anything in Drive — this was read-only.

---

## Files in the workspace

- `google_drive/deepdenoiser-1.6-max.tar.gz` — the linked archive (16 MB)
- `deepdenoiser-1.6-max/deepdenoiser-full/` — extracted project, ready to browse/build
- `deepdenoiser-drive-check.md` — this report
