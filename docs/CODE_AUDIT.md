# DeepDenoiser 1.6 — Source Code Audit

**Target:** `deepdenoiser-1.6-max.tar.gz` → `deepdenoiser-full/` (the file you linked from Drive)
**Date:** 27 Oct 2026
**Method:** full static read of all 98 files (~8,644 LOC of TS/TSX/JS/Kotlin), plus a real
`tsc --noEmit` pass using TypeScript 5.9 with stubbed external module types, plus targeted
API-contract checks against upstream docs.
**Limit:** static only. No `node_modules`, no Android device/emulator — so nothing here is a
runtime reproduction. Items marked *verify* need a device build to confirm.

---

## Upgrade 2.0 status (29 Oct 2026)

The 2.0 upgrade additionally addresses AUD-06/07/08/09/10/11/12/13/14/17/21/22/23/24/27/31 in code, and improves AUD-05 recording compensation (passthrough transitions still require device testing). See `UPGRADE_2.0.md` for exact behavior and limitations. The findings table and CSV below remain an **as-found historical audit**, not a live tracker. Automated tests are included, but none replace Android device tests.

## Fix status for this repository

This commit applies the **P0 remediation set** from the audit below. The audit text is kept
verbatim as the "as-found" record; the findings listed here are resolved in this tree:

| ID | Status | What changed |
|---|---|---|
| AUD-01 | ✅ fixed | `DeepFilterNet.createStream()` / `StreamState` — recurrent state is now owned per pipeline, not by the shared session. `beginRun`/`endRun` in `denoiserSingleton.ts` defer engine resets until no pipeline is active. Both screens updated. |
| AUD-02 | ✅ fixed | 5× `COLORS.textSecondary` → `COLORS.subtext`; tightened the `AttenPreset` preset cast; added `typecheck` script + CI `tsc --noEmit` step. |
| AUD-03 | ✅ fixed | `MediaProcessor : Closeable` calling `mediaTransformer.release()`; all 7 native entry points now wrap it in `.use { }`. |
| AUD-04 | ✅ fixed | `decodeToPCM` EOS fallback now drains every output buffer until `BUFFER_FLAG_END_OF_STREAM` (bounded retries), instead of breaking after one. |
| AUD-15 | ✅ fixed (bonus) | `processFrame` zeroes `inputFrameData` before copying a frame. |
| AUD-16 | ✅ fixed (bonus) | `setStreamAttenLimDb()` allows mid-stream strength changes. |
| AUD-37 | ✅ fixed (bonus) | `moduleScope` uses a `SupervisorJob`. |

**CI (separate from the audit):** the pushed workflow also replaces the broken
`setup-android@v3` action, adds a `bunx tsc --noEmit` gate, and raises the Gradle
heap from 2g to 4g so `:app:packageRelease` does not OOM on the ONNX model.

**Historical status immediately after the P0 patch:** AUD-05 … AUD-40 (except the above) were still open. Nothing in that P0 patch had been run on a device —
the Kotlin changes in particular need an Android build + smoke test before release.

## Post-audit runtime fix — document picker (28 Oct 2026)

**Reported symptom (release build, Android):**
`ExpoDocumentPicker.getDocumentAsync` rejects with
"Different document picking in progress. Await other document picking first."

**Root cause.** In `expo-document-picker@57.0.1`'s Android module,
`pendingPromise` is assigned *before* `startActivityForResult` and cleared
*only* from `OnActivityResult`. Two paths leave it set for the lifetime of the
process:

1. A second `getDocumentAsync()` while the picker is still open (fast double
   tap, or a second call site) throws `PickingInProgressException`.
2. A lost activity result — Android Back, an OEM file manager, or the host
   activity being recreated while the picker is up — never settles the promise.
   Every later pick then fails with the same error. This is a long-standing
   upstream issue (expo/expo#21578, #21064).

The app had a single unguarded call site in `src/app/(tabs)/index.tsx`, and the
Import button was not disabled while the picker was open.

**Fix (two layers).**

- `patches/expo-document-picker+57.0.3.patch` (applied by the existing
  `postinstall: patch-package`): clears `pendingPromise` if the launcher
  throws, always releases it via `finally` in `OnActivityResult`, and adds a
  zero-argument `cancelPendingPick()` escape hatch that settles a stale pick as
  a cancellation.
- `src/scripts/documentPicker.ts`: a serialised wrapper that (a) ignores
  concurrent taps, (b) watches `AppState` and recovers a lost result after an
  8s resume grace (3min hard ceiling), (c) on a surviving
  `PickingInProgress` error calls `cancelPendingPick()` and retries once, and
  (d) always releases its own JS-side lock. `index.tsx` now uses it with a
  `useRef` double-tap guard and a disabled Import card.

**Critical build detail.** Expo SDK 57 links `expo-document-picker` from a
**precompiled AAR** (`[📦]` in the autolinking log), so patching `node_modules`
Kotlin alone never reaches a release APK — verified by unpacking the built APK:
the DEX had `getDocumentAsync` but no `cancelPendingPick`. `package.json` now
sets `expo.autolinking.android.buildFromSource: ["expo-document-picker"]` and
pins the package to `57.0.3`, so Gradle compiles the patched source. CI also
greps the APK's DEX for `cancelPendingPick` and fails if it disappears.

**Verification.** Strict `tsc --noEmit` (TS 6.0.3) clean on the new module;
full-project check has 0 internal errors. `patch-package` applies the patch
cleanly and idempotently. A 17-check Node harness simulated normal picks,
double taps, lost activity results, an already-wedged module, and a resumed
pick followed by a fresh tap — all passed. **The later CI build compiled the patch and verified it in APK DEX; real Android
device testing is still required to confirm the runtime behavior.**

> This was found in the field after the static audit; the 40-row
> `CODE_AUDIT_FINDINGS.csv` tracker is unchanged.

## Executive summary

The project is competently structured and genuinely privacy-first: no secrets, no keys, no
telemetry endpoints, no network calls beyond two "open in browser" links, and the ONNX model is
bundled locally. The cache layering and the recording backlog/passthrough design are thoughtful.

But the audit found **6 confirmed build-breaking type errors** (5 of which also cause a real UI
bug), **3 crash/data-loss risks**, and a broad set of correctness and lifecycle issues — the most
important being that **one shared ONNX session with mutable streaming state is used by both the
file-denoise and live-record screens**, that the **native transcoder is never released**, and that
**the native PCM decoder can truncate the tail of decoded audio**.

| Severity | Count | Meaning |
|---|---|---|
| 🔴 Critical | 3 | Can corrupt audio, crash, or is a confirmed compile error |
| 🟠 High | 9 | Data loss, wrong output, race, or UX break |
| 🟡 Medium | 21 | Fragile / incorrect under specific conditions |
| 🔵 Low | 7 | Hygiene, dead code, docs, maintainability |

**40 findings total (AUD-01 … AUD-40).** See `deepdenoiser-audit-findings.csv` for a flat,
trackable list with file/line, impact and fix for each.

---

## What's actually good (verified)

- **No secrets.** Scanned for API keys, tokens, private keys, keystores, `.env`, `EXPO_TOKEN` — no hits.
- **No telemetry.** `analytics.ts` is a genuine no-op stub; only 3 `https://` strings exist
  (Expo docs comment, GitHub repo link, GitHub issue link). Offline inference is real.
- **No injection surface.** No `eval`, no dynamic SQL, no `WebView` with arbitrary content,
  no unvalidated deep-link execution.
- **Archive integrity.** All 9 Drive tarballs pass `gzip -t`; MD5s match Drive metadata.
- **Resource cleanup in the native decoder/muxer** (`MediaCodec`, `MediaExtractor`, `MediaMuxer`,
  `ParcelFileDescriptor`, streams) is consistently done in `finally` blocks.
- **Sensible DSP defaults** and a well-documented silence-trim algorithm with speech-safe
  threshold clamping.
- **No syntax errors.** TypeScript parses every file cleanly; all relative imports resolve.

---

## 🔴 Critical findings

### AUD-01 · Shared ONNX session + mutable stream state used by two screens
`src/scripts/denoiserSingleton.ts:21-57`, `src/scripts/Denoiser.ts:126-207`,
`src/app/processing/process.tsx:265`, `src/app/recording/index.tsx:251,319`,
`src/components/SettingsSidebar.tsx:136,178`

`getDenoiser()` returns one process-wide `DeepFilterNet`. Both screens call
`setupStreaming(attenLimDb)` on that same object; `processFrame()` reads/writes its single
`streamStates` (12 recurrent state buffers). Consequences:

- Starting a recording while a file denoise is running (or vice versa) **resets the other's
  recurrent state mid-stream** → corrupted/garbled output.
- `SettingsSidebar` calls `resetDenoiser()` → `session.release()` on runtime/core change with no
  guard; during inference this frees native memory under an in-flight `session.run()`.
- `_layout.tsx:46` preloads the 13 MB model at app start, so the singleton is live even before
  either screen is opened.

**Fix:** give each consumer its own session/state (or a per-consumer `StreamState` object passed
into `processFrame`), and gate `resetDenoiser()` behind an in-flight counter / `AbortController`.
At minimum add a mutex so only one denoise pipeline can own the engine at a time.

### AUD-02 · 6 real TypeScript errors — 5 produce `color: undefined` in shipped UI
`src/components/SettingsSidebar.tsx:261,284,321,326`; `src/app/recording/index.tsx:719`;
`src/app/recording/index.tsx:504`; `src/constants/theme.ts:3-15`

`theme.COLORS` defines `subtext` and `secondary` — **there is no `textSecondary`**. Five styles
(sidebar section titles, setting descriptions, footer version/note, recording "Strength" label)
reference it, so `StyleSheet.create` receives `color: undefined`. React Native then falls back to
the default text colour — effectively invisible/grey on the dark background. `tsc` reports:

```
TS2551: Property 'textSecondary' does not exist ... Did you mean 'secondary'?   (×5)
TS7053: Element implicitly has an 'any' type because expression of type
        'AttenPreset' can't be used to index
        Record<'light'|'medium'|'strong'|'max', number>.
        Property 'custom' does not exist ...                                     (×1)
```

The second error is the `[AttenPreset, string][]` cast at line 496 — it should be
`[Exclude<AttenPreset,"custom">, string][]`. Runtime is safe today (the array only holds the 4
presets), but it's a live type hole: if `"custom"` ever enters that array, `attenLimDb` becomes
`undefined` and the model gets `NaN`.

Note: Expo's Babel build strips types without checking, **so the app compiles and ships with these
bugs**. `bunx tsc --noEmit` would catch all six.

**Fix:** replace `textSecondary` → `subtext` (or add the alias to `COLORS`); tighten the cast; add
`tsc --noEmit` to CI *and* to the `lint` script.

### AUD-03 · Native `MediaTransformer` is never released (thread/resource leak)
`modules/.../AudioProcessor.kt:37,166,1226`; `AudioProcessorModule.kt:27,71,117,156`

Every `AsyncFunction` constructs a fresh `MediaProcessor`, which constructs a fresh LiTr
`MediaTransformer(context.applicationContext)`. LiTr's own docs: *"When you no longer need
MediaTransformer, please release it."* It owns a `HandlerThread`. There is **no `release()` call
anywhere** in the file. Each `toWav`/`mergeAudioVideo`/video-remux run leaks a transformer and its
thread → gradual thread exhaustion / OOM over repeated use, especially on the OnePlus 7 this
build targets.

**Fix:** make `MediaProcessor` `Closeable`, call `mediaTransformer.release()` in a `finally`
around each transform, or hold one application-scoped transformer in the module and release it in
`OnDestroy`. Also make `requestId` a UUID rather than `System.currentTimeMillis()`
(lines 108, 1154) to avoid collisions on back-to-back calls.

---

## 🟠 High findings

| ID | File / line | Issue | Impact / fix |
|---|---|---|---|
| AUD-04 | `AudioProcessor.kt:570-595` | `decodeToPCM` EOS drain: the `INFO_TRY_AGAIN_LATER && isEOS` fallback processes **one** output buffer then `break`s (line 591) and never checks `BUFFER_FLAG_END_OF_STREAM`. | Can truncate the last decoded PCM chunk on some codecs. Drain in a loop until the EOS flag or N consecutive `TRY_AGAIN_LATER`. |
| AUD-05 | `process.tsx:269-306` vs `recording/index.tsx:233-268,358-372` | File denoising compensates model delay by seeding `inputBuffer` with `fftSize` zeros and skipping the first `fftSize` output samples. **Recording does neither.** | Denoised recording is offset ~960 samples (20 ms @48k) vs the original and contains the cold-start transient; same audio denoised via the two paths differs. Apply identical priming/skip in the recording path. |
| AUD-06 | `process.tsx:145-417` | `handleDenoise` has no cancellation. The ONNX loop (100k+ frames) keeps running after the user navigates away / screen unmounts; `setProgress`/`setError` fire on an unmounted component; partially written `stage_dn_*.pcm` is never cleaned up. | Add an `abortedRef`/`AbortSignal`, check it inside the hot loop, and clean staged files in `finally`. |
| AUD-07 | `src/components/videoPlayer.tsx:24-39` | Calls `player.release()` in `useFocusEffect` cleanup (i.e. on **blur**), but `useVideoPlayer` owns the player's lifetime and releases it on unmount. | Frees native resources while the hook still holds the object → black video / crash on return. Only `pause()` on blur; never `release()`. |
| AUD-08 | `src/scripts/settings.ts:78-142` | `updateSettings` catches write errors and still returns `updatedSettings` as if saved; `incrementDenoiseCount` is a non-atomic read-modify-write; `getSettings()` returns the shared `DEFAULT_SETTINGS` object **by reference** on error/first run. | Silent settings loss, lost increments, possible global default corruption. Write atomically (temp + rename), surface failures, return a frozen/cloned default. |
| AUD-09 | `src/scripts/denoiserSingleton.ts:21-57` | If runtime/cores change **while `loadPromise` is in flight**, `instance` is still null so the key-change branch is skipped and the old-settings load is returned. `resetDenoiser()` also sets `loadPromise = null` while `current.release()` is still pending. | Settings changes during the first load are silently ignored; a new session can be created before the old one is freed. Await release before clearing state; key the promise. |
| AUD-10 | `denoiseCache.ts:72-118,198-227,301-326` | Import reuse is decided by **filename + size only**; cache keys use name + size + `modificationTime`, never a content hash. `modificationTime` can be `undefined` → key collapses to `"undefined"`. | Re-importing a *different* file with the same name and size silently reuses the old bytes; cache can serve a stale/wrong result. Hash the first N bytes (or whole file) into `buildInputIdentity`. |
| AUD-11 | `src/components/advanceSettings.tsx:83-95,168-176`; `process.tsx:76,102-111,473-481` | Strength presets / attenuation slider on the process screen change **local state only** — never `updateSettings()`. The recording screen does persist. | The two screens disagree, the Settings sidebar is out of sync, and the choice is forgotten. Persist via `updateSettings({ attenPreset / attenLimDb })` like the recording screen does. |
| AUD-12 | `denoiseCache.ts:136-158,186-192,244-259,333-377` | Index writes are un-awaited `new File(...).write(...)` inside `try/catch`; read-modify-write with no lock; `writeJsonIndex` swallows errors and returns success. Also `File.write()` is synchronous on Expo 57 but **became async in SDK 58** — this will silently break on upgrade. | Concurrent runs clobber each other's indexes → cache misses or wrong entries. `await file.write(...)`, serialise index mutation with a module-level promise queue, write via temp file + rename. |

---

## 🟡 Medium findings

**Audio / DSP**

- **AUD-13** `process.tsx:263-264` hardcodes `hopSize=512`, `fftSize=960` even though
  `assets/model/model_metadata.json` is the source of truth used by `Denoiser.ts`. Swapping the
  model silently desynchronises framing. Export/read the constants from metadata.
- **AUD-14** `formatHandler.ts:128-164,207-242` — `readPCMChunks` calls `resample()` on each
  5-second chunk independently: no fractional-phase carry across boundaries, last sample uses
  `s2 = s1`, and linear interpolation has no anti-alias filter. At 44.1→48 kHz expect boundary
  clicks/aliasing. Also `onChunk`'s `inputSamples` is the raw count, not the resampled count.
- **AUD-15** `Denoiser.ts:139-191` — `inputFrameData.set(frame)` never zeroes the tail; if a
  caller ever passes a frame shorter than `hopSize`, the previous frame's leftover samples are
  replayed. Callers currently always pad, but this is a silent trap. `inputFrameData.fill(0)` first.
- **AUD-16** `Denoiser.ts:126-137,155-157` — `attenLimDb` is baked into a Tensor at
  `setupStreaming()`. Changing strength mid-stream (or after the preload) has no effect.
- **AUD-17** `Denoiser.ts:173-181` — state write-back assumes `outputNames[j+1]` order exactly
  matches `stateInputNames[j]`. `model_metadata.json` provides an explicit `state_input_names`
  array that is **ignored**. A reordered export corrupts all recurrent state with no error.
- **AUD-18** `Denoiser.ts:58-69` — `lastEngine` records the *attempted* provider label, not the
  actually loaded one. ORT silently falls back to CPU inside `create()` for unsupported nodes, so
  the UI can claim `nnapi-gpu-prefer x4` while running CPU. Provider option objects are also cast
  with `as string[]`, defeating type checking. Verify with `session.getProviders()` where available.
- **AUD-19** `deviceCores.ts:8-25` — `suggestCoreLevel()` can only return 2 or 4; the "8" option
  in `AppSettings` is unreachable in Auto. It also mixes `Constants.expoConfig?.name` (the **app
  name**, not the device) into the device hint, so that regex is meaningless.
- **AUD-20** `formatHandler.ts:263-295` — `ArraytoPCM` still builds a binary string and calls
  `btoa()` (Hermes on RN 0.86 has it, but it's ~10× slower than the direct `Uint8Array` write used
  in `writePCMChunk`). It is also dead code — see AUD-34.

**Lifecycle / storage**

- **AUD-21** `denoiseCache.ts:328-331,384-393` — staged `stage_dec_*.pcm` / `stage_dn_*.pcm` are
  deliberately excluded from `cleanupTempCache()`. Any failed/aborted run (see AUD-06) leaves them
  forever. `orig_*.pcm` / `den_*.pcm` from recordings persist until the home screen happens to remount.
- **AUD-22** `recording/index.tsx:380-396`, `formatHandler.ts:94-97` — recording result WAVs live
  in **`Paths.cache`** (OS-evictable), unlike file-denoise results which use `placeOutput()` into
  `Paths.document`. `cleanupTempCache()` patterns include `denoised_*.wav`, so a home-screen
  remount can delete a result the user is still viewing/sharing. Move results to documents.
- **AUD-23** `src/app/(tabs)/index.tsx:52-95` **and** `src/app/share-handler.tsx:18-75` — two
  independent `useIncomingShare()` subscribers with separate async copy+clear flows. The
  `clearSharedPayloads()` calls are not ordered, so a fast payload can be processed twice and push
  two processing screens. Centralise in one hook/provider.

**Native contract**

- **AUD-24** `AudioProcessorModule.types.ts:22-27` vs `silenceTrim.ts:50-70` vs
  `AudioProcessor.kt:698-699` — the module-facing `SilenceTrimNativeConfig` type omits
  `removeInternalPauses`, while the Kotlin code reads it with **default `false`**. Today
  `trimToNativeConfig()` adds it, so it works — but any caller typed against the module type
  silently loses internal-pause removal. Unify the type.
- **AUD-25** `process.tsx:150-152` forcibly disables silence trim for video, so
  `wavResult.trimmed` is always false and `mergeAudioVideo`'s trim branch
  (`formatHandler.ts:333-335`, Kotlin `muxAudioVideo` trim logic, `VideoTrimConfig`) is **dead
  code** — ~120 lines of native trim-window logic never execute.
- **AUD-26** `AudioProcessor.kt:399-413` — when trimming, video timestamps are rebased by the
  requested `trimStartUs`, but writing only starts at the *next keyframe*. Actual first frame may
  be up to one GOP later while its timestamp says 0 → A/V desync. (Latent until AUD-25 is enabled.)

**Build / config**

- **AUD-27** Version conflict: `package.json:4` = `1.6.0-enhanced`, `app.json:109` = `1.5.0`,
  `app.config.js:9` hard-overrides **`version: '1.4.4'`** — the last one wins, so
  `Constants.expoConfig?.version` in the sidebar likely shows 1.4.4. `ENHANCED.md` changelog stops
  at 1.5.0.
- **AUD-28** `plugins/DisableDependencyInfo.js:8-20` — replaces the first `android {` in
  `app/build.gradle` with a block that opens an unclosed `android {` and relies on the original
  closing brace; duplicates `buildTypes`; not idempotent; regex can match inside comments. Use
  `withAppBuildGradle` with a proper `dependenciesInfo` merge or `expo-build-properties`.
- **AUD-29** `modules/AudioProcessorModule/expo-module.config.json:2` declares `apple` and `web`
  platforms, but there is no iOS Expo module (only two SwiftUI stub views) and **no
  `AudioProcessorModule.web.ts`** — despite `index.ts:1` claiming web resolution. Any non-Android
  build fails at `requireNativeModule`. Declare `android` only.
- **AUD-30** `modules/AudioProcessorModule/android/build.gradle:35` pins
  `kotlinx-coroutines-android:1.3.9` (2019) while Expo/RN 0.86 brings a modern version;
  `compileSdkVersion 36` (Android 16) is requested but CI's `setup-android@v3` doesn't explicitly
  install it. Also `useCoreDependencies()` probably already supplies coroutines.
- **AUD-31** CI (`.github/workflows/android.yml:59`) runs `bun install --frozen-lockfile || bun install`
  with **no lockfile committed** (`.gitignore:9-12` ignores `*.lock`, `bun.lockb`, etc.), plus
  `bun-version: latest`. Combined with patch files keyed to exact versions
  (`expo-modules-core+57.0.11.patch`, `onnxruntime-react-native+1.24.3.patch`) while
  `package.json` uses `^` ranges → non-reproducible builds or a failing `postinstall`. Commit a
  lockfile and pin Bun.
- **AUD-32** `package.json:9` — `reset-project` script points at `./scripts/reset-project.js`,
  which **does not exist**. Confirmed by static resolution check.
- **AUD-33** `app.json:56-63` requests `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` —
  no-ops on API 30+ (targetSdk 36) and a Play policy smell. Package/bundle ID is still the
  upstream `com.sayampy.deepdenoiser`. `experiments.reactCompiler: true` is enabled with no
  explicit `babel-plugin-react-compiler` dependency (*verify* whether Expo 57 bundles it).

---

## 🔵 Low findings / hygiene

- **AUD-34 Dead code (~300 LOC):** `Denoiser.denoise()` + `runDenoiseLoop()` (lines 241-373,
  132 lines, only reachable from each other), `resetStates()`,
  `formatHandler.toWav()` / `PCMtoArray()` / `ArraytoPCM()` / `renameFile()`,
  `AudioProcess.normalizeAudio()`, `patches/patch-ort.js` (duplicates the patch-package patch but
  is never invoked and its header comment says it lives in `android/`), the
  `checkForUpdates` + `denoiseCount` settings, and `trackAppEvent/stub` at 17 call sites.
- **AUD-35** `src/components/customSlider.tsx:47-56,76-79` — with `steps`, `steps.indexOf(value)`
  returns `-1` for any custom value → thumb jumps to 0 while the label shows another number;
  `stepCount = steps.length - 1` divides by zero for a single-step array.
- **AUD-36** `SaveButton.tsx:37` and `share-handler.tsx:69` — `setTimeout` state updates without
  cleanup on unmount.
- **AUD-37** `AudioProcessorModule.kt:11` — `CoroutineScope(Dispatchers.IO)` has no
  `SupervisorJob`, and `OnDestroy` cancels the scope without rejecting in-flight promises (they
  hang forever). Use `SupervisorJob()` and settle promises on cancellation.
- **AUD-38** `ErrorModal.tsx:46` says "without any ascii symbols" (should be *non*-ASCII);
  `ErrorModal.tsx:96` "Report on GitHub" and `.github/FUNDING.yml` still point to upstream
  `sayampy`, while `README.md` claims donations were removed.
- **AUD-39** `PRIVACY POLICY.md` is untouched upstream boilerplate: it names "Sayam Goswami",
  their email, and claims third parties collect Log Data / IP addresses — directly contradicting
  the README's "no analytics, on-device only". Needs a rewrite before any store release.
- **AUD-40** `formatHandler.ts:301` / `recording/index.tsx:623` — album name
  `"DeepDenoiser/Recordings"` contains a `/`, which is not a valid MediaStore album name.
  `README.md` also labels a best-effort NNAPI path as "GPU" (the code itself admits there is no
  OpenCL/Vulkan EP in `onnxruntime-react-native`).

---

## Recommended remediation order

**P0 (before any release)**
1. AUD-02 — fix the 6 type errors, add `tsc --noEmit` to CI.
2. AUD-01 — isolate per-consumer streaming state; guard engine reset.
3. AUD-03 — `mediaTransformer.release()` in `finally`.
4. AUD-04 — drain decoder to EOS correctly.

**P1 (this week)**
5. AUD-05 / AUD-13 / AUD-17 — align delay compensation, derive hop/fft from metadata, use
   `state_input_names`.
6. AUD-06 / AUD-07 — cancellation + player lifecycle.
7. AUD-10 / AUD-12 / AUD-22 — content-hash cache keys, awaited/locked index writes, move
   recording outputs to documents.
8. AUD-08 / AUD-09 / AUD-11 — settings persistence and singleton races.

**P2 (hardening)**
9. AUD-27…AUD-33 — version, config plugins, lockfile, CI, permissions, module platforms.
10. AUD-34…AUD-40 — dead code, docs/legal, polish.

---

## Appendix A — `tsc --noEmit` result

Ran TypeScript 5.9 with `strict: true`, `moduleResolution: bundler`, `jsx: react-jsx`, project
`paths` mapping (`@/*`), and `types: []` because `node_modules` is absent.

- 176 compiler diagnostics (177 output lines, one is an elaboration): **117 TS2307**
  (missing external modules), **20 TS2875** (missing `react/jsx-runtime`),
  **16 TS7006 + 14 TS7031** (implicit `any` from untyped imports), **3 TS2591** (missing
  `require` types) — all expected consequences of no `node_modules`.
- **6 genuine internal errors: 5× TS2551 + 1× TS7053** (see AUD-02).
- **0 syntax errors (TS1xxx).**
- All relative imports resolve; the only broken path reference is `scripts/reset-project.js`
  (AUD-32).

## Appendix B — Upstream API facts checked

- Expo `expo-file-system` SDK 57: `File.write(content, { encoding, append })` is **synchronous**;
  the `append` option arrived in SDK 55 and `write()` became **async in SDK 58**
  (`writeSync()` keeps sync behaviour). AUD-12 is a future-upgrade hazard, not an SDK-57 bug.
  Sources: [Expo FileSystem docs](https://docs.expo.dev/versions/latest/sdk/filesystem/),
  [Expo SDK 58 beta changelog](https://expo.dev/changelog/sdk-58-beta),
  [expo-file-system CHANGELOG](https://github.com/expo/expo/blob/main/packages/expo-file-system/CHANGELOG.md).
- LiTr: `MediaTransformer` "must be released" when no longer needed
  ([LiTr README](https://github.com/linkedin/LiTr)) — AUD-03.
- ONNX Runtime JS `SessionOptions.executionProviders` accepts `(string | ProviderOptions)[]`, so
  the NNAPI option objects are legal; `NNAPI_FLAG_CPU_DISABLED` is API 29+ and often makes model
  creation fail, which is why the "GPU" attempt usually falls through to XNNPACK/CPU
  ([ORT NNAPI EP docs](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html)).
  `lastEngine` does not verify the actual provider — AUD-18.
- Hermes on recent React Native does provide `btoa`/`atob`, so AUD-20 is a performance/dead-code
  note, not a crash.

## Appendix C — Files reviewed

`src/scripts/` (9 files, 1,206 LOC), `src/app/` (10 files, 2,835 LOC), `src/components/`
(11 files, 2,182 LOC), `src/constants/theme.ts`, `modules/AudioProcessorModule/` (TS bridge +
`AudioProcessor.kt` 1,437 LOC + `AudioProcessorModule.kt` 167 LOC + build.gradle),
`plugins/` (4 config plugins), `patches/` (3 patch-package files + `patch-ort.js`),
`app.json`, `app.config.js`, `eas.json`, `package.json`, `tsconfig.json`, `metro.config.js`,
`react-native.config.js`, `eslint.config.js`, `.github/workflows/android.yml`, `.gitignore`,
`README.md`, `ENHANCED.md`, `PRIVACY POLICY.md`, `CONTRIBUTING.md`, `LICENSE`,
`assets/model/model_metadata.json`.
