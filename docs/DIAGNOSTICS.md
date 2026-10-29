# Diagnostics and safe device testing

## Access and safety

Open **Settings → Diagnostics & self-check**. Status readings are snapshots, not guarantees. The attempted ONNX execution-provider label does not prove which hardware executed the model. The app-storage free-space value may not describe a separate Android content provider or export destination. Media-read permission can be absent while Android's document picker still works.

The normal self-check runs only after the native recording writer is confirmed idle and the shared processing guard is reserved. It creates unique app-owned synthetic PCM/WAV files, verifies exact bytes and short-read behavior, fingerprints the bundled model and performs a short generated-tone model run. It does not request the microphone or open user media. It deletes only files it created; a cleanup failure is shown. Synthetic output checks do not establish denoising quality or video sync. Android still needs device testing.

Optional individual CPU/XNNPACK/NNAPI comparisons use an isolated session, one provider at a time, after releasing the cached model. They do not change saved settings; the normal model loads again later. A provider can fall back to another provider. Short timings are indicative only, can use power and memory, and are not reliable benchmarks of other files/devices. Do not interrupt a real recording to run them.

A prior process-exit reason is displayed on Android 11/API 30+ where the OS supplies it. A user force-stop, OS kill, update or other exit is not necessarily a crash. React error boundaries cover render errors, and the JavaScript handler delegates to the existing React Native handler; neither captures every asynchronous or native failure. A sudden process death may prevent recent events from being saved. Recording recovery remains fail-closed: do not delete originals, clear app data or uninstall casually.

## Privacy

A bounded history of at most 50 structured events exists in memory by default. Events consist only of allowlisted operation/stage/category/severity, timestamps and bounded durations; raw error messages, stacks, user-media filenames, URIs, paths, audio and media hashes are not accepted by the event-history serializer. If you explicitly enable saved history, the structured history is written atomically in app-specific `noBackupFilesDir`. Turn it off or clear it from the screen. That setting does not change the app's existing backup policy; verify vendor/device transfer behavior separately. A crash can occur before a queued save finishes.

The report is previewed before copying or using Android's share chooser. Device model, OS, memory and permission details are included only when selected. Although structured fields avoid raw exceptions, any report can reveal contextual information; review it before sharing. The existing error dialog can display/copy raw exception details, and Android logs or bug reports can contain paths, filenames or data from other apps. GitHub issues are public. The app does not automatically transmit diagnostic events, audio or reports.

## Device checklist

1. Back up/export important app-private recordings and results before updating the APK. Confirm the new APK's signing certificate matches the installed test build; if Android rejects the update, **do not uninstall or clear data** to work around it.
2. In Diagnostics, refresh status and run the synthetic self-check while idle. Check the model hash, file read/write, WAV conversion and short model run. Compare providers only if desired.
3. With disposable copies, test audio/video import, share-in from multiple apps, batch errors, playback, output export and reopen, and video synchronization. A file-size check alone does not certify quality.
4. Test recording start/stop, interruptions, notification, screen-off/background behavior, writer-uncertain recovery and Android backup/transfer with safe test media on representative Android versions.
5. Test low storage, denied permissions, process death and provider errors without risking irreplaceable media. Event storage/clear failures must never break media handling.

## Android logs and symbols

If a native crash cannot be explained in the app, an authorized computer can collect `adb logcat`. For example, after reproducing the issue:

```sh
adb logcat -d -v time AndroidRuntime:E ReactNativeJS:V '*:S' > deepdenoiser-log.txt
```

This is not exhaustive and can include unrelated or private information. Review/redact it before sharing; do not commit it to the repository. Other native components may need different log filters, and process IDs can change after a crash.

Release-mode GitHub builds produce a separate 14-day Actions artifact with the JS source map, R8 mapping, build identity and checksums. Artifact access follows the repository and Actions access settings; for a public repository do not treat artifacts as secret storage. Native debug symbols are included only if the Android build generated them; prebuilt vendor binaries may not include symbols. Use the exact matching build/commit and retain maps in an appropriately controlled location if a longer retention period is needed.

These tools and a successful CI build do not establish production release readiness. `THIRD_PARTY_REVIEW.md` and `RELEASE_SIGNING.md` still apply.
