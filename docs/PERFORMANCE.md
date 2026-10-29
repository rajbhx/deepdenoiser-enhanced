# Product optimization and device validation

## Scope and status

The 2.0.3 artifact is an **arm64 debug-signed test build**, not a production release. The intended target is OnePlus 7-class Android hardware (Snapdragon 855), but no physical phone or Android emulator was available for this work. The model, output format, audio delay, user settings, recording recovery, backup behavior, and execution-provider defaults have not intentionally changed. Do not interpret host results as OnePlus speed, battery, thermal, or sound-quality measurements.

## Streaming changes

- A stream keeps its own input tensor map, one pending frame and one frame-output scratch buffer. Full frames are read directly from an unchanged input chunk until `push()` resolves; the live recording queue already owns a copy of its input. The old implementation copied each entire input chunk into a joined array. Remaining samples and the delay/tail are still handled across boundaries.
- File processing reads two seconds of source samples at a time rather than five. At 48 kHz, a mono float input chunk is 384,000 bytes instead of 960,000 bytes. This is a **chunk-buffer** comparison, not a measurement of total peak memory. Smaller chunks also allow progress to be updated more often, but require more file writes; wall-clock update intervals depend on processing speed and I/O.
- The bundled model returns 13 float tensors totaling 186,592 bytes per 512-sample frame. Each stream can preallocate its own outputs. Before enabling reuse, it runs the first input both ways and requires every value to match bit-for-bit and the runtime to return the supplied tensors. It uses the ordinary result for that first frame. If the probe fails, the runtime ignores reuse, or a later reusable-output run fails, it falls back to ordinary results; the failed run's output buffers are separate from recurrent inputs, and the frame is retried once. The native React Native ORT binding can return the supplied tensors without its normal output-array allocation and copy. At 48 kHz this avoids *up to* 186,592 bytes of output-array creation/copy for each subsequent frame when reuse is actually supported; it is not a measurement of overall heap, native memory, or speed. ONNX and other buffers still allocate and recurrent states are still copied into their input buffers.
- In **Settings → Diagnostics & self-check**, the synthetic model check reports `verified reuse` or `standard fallback`. It is a per-run compatibility observation, not proof of sustained correctness, acceleration, or which processor executed the model. The check includes the extra initial probe in its short timing.

The optimized frame path preserves the conventional output in tests. A reference-stream property regression exercises zero-length and short inputs, varied frame sizes/delays, random chunk seams and tails; mock provider tests cover independent streams, ignored buffers, mismatches and failures. The real bundled model was tested in a CPU-host adapter that verifies Node ORT actually filled supplied output tensors before emulating the React Native binding's return convention: 952 reusable frames at three strength settings and silence matched the ordinary CPU path bit-for-bit, including recurrent states. An additional real-model test checks 33 seconds of silence and sample alignment. These tests do not replace device/provider validation.

## Host comparison (not a device benchmark)

On 2026-10-29, Node 20.20.2 / Linux x64, a shared two-vCPU Intel Xeon host, ONNX Runtime Node 1.24.3 CPU provider, four ORT threads, warm-up plus three runs of 10 seconds of deterministic synthetic audio:

| Source | Elapsed milliseconds, three runs | Output SHA-256 |
| --- | --- | --- |
| Baseline `64d0c9a` | 2513, 3074, 3145 | `24ba8f8a22853a4a616a9553e16906987b9acf17e5bf55040f1a5f78c3201f2e` |
| Optimized working tree | 3228, 2831, 2618 | same |

The machine was shared and the spread is substantial; **no meaningful speedup or regression can be concluded**. Node's binding returns different output tensor objects, so the optimized code falls back to the ordinary output path in this benchmark. This does not measure the Android reusable-output path, true peak memory or energy use. Reproduce against any saved source revision with `scripts/benchmark-model.cjs`; its header lists the command and dependencies.

## OnePlus 7 test protocol before release

1. Back up/export important app-private recordings and results. Confirm the installed test certificate matches before updating; if Android refuses an update, do not uninstall or clear data without a verified backup. A new production key normally cannot update the existing debug-signed app.
2. In a cool, representative state with sufficient free space, run the idle synthetic self-check, record the attempted provider and the reported output-buffer mode. Test Auto/XNNPACK and CPU; NNAPI is best-effort and may fall back. Never assume a provider label proves GPU/DSP use.
3. Using disposable, non-sensitive audio/video copies, run representative short, one-minute and longer files at multiple rates, including silence and difficult/noisy speech. Compare output duration, first and last samples, A/B alignment, audible quality and video sync with the previous build. Check cancellation at multiple stages and that incomplete output is not published. Verify batch, external share, malformed links and the resampling path.
4. Time the same file with the same settings on both builds; report audio duration divided by elapsed processing time, provider, thread count, device temperature/battery state and repeated trials. Measure peak app memory with Android Studio or `adb shell dumpsys meminfo com.sayampy.deepdenoiser` at documented intervals. Check long-run heat, throttling, storage use and battery separately; the brief diagnostic speed is not sufficient.
5. Exercise recording for long enough to detect backlog, stop/reconcile and recover after an interruption; repeat with screen off, notification permission denied, and relevant OnePlus battery policies. Test backup/transfer and upgrade behavior with disposable data, never irreplaceable media. Retain the current defaults unless comparative device evidence supports changing them.

Release signing, native/Gradle notices, the exact model-weight origin/terms and physical-device validation remain open; see `THIRD_PARTY_REVIEW.md` and `RELEASE_SIGNING.md`.
