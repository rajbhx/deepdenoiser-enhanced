# DeepDenoiser Enhanced privacy notice

This notice describes the `rajbhx/deepdenoiser-enhanced` Android fork, not other versions of DeepDenoiser.

## Media and processing

The app processes audio, video and microphone recordings on the device. It does not send media to a server for denoising and has no configured analytics or advertising SDK in this fork. Imported files, working data, settings and processed outputs can be stored in the app's private storage; temporary processing data may be stored in the Android cache. The app permits Android's default backup behavior: depending on the device and user settings, eligible private app files may be copied to cloud backup or a device-to-device transfer. Cache files are generally excluded and can also be removed by Android. The app does not disable existing backup or transfer behavior.

Clearing app data or uninstalling can delete private app copies. Copies you choose to save to your media library, share with another app, or include in a device backup are managed separately and may remain afterward.

## Permissions and sharing

The Android document picker is used to select media. Microphone permission is requested when you start a recording; media-library access is requested when you save. You can use other available functions if you decline a permission. If you choose Share, the selected receiving app handles the shared file under its own privacy practices. Opening external links leaves the app.

## Diagnostics

The Diagnostics screen maintains up to 50 structured, allowlisted event categories and timings in app memory. It does not store media, filenames, paths, URIs, media hashes, raw exception messages or stacks in that event history. You can opt in to save this bounded history across restarts in app-specific no-backup storage; turn it off or clear it in Diagnostics. No diagnostic history is automatically uploaded. Sudden crashes may still lose recent events.

You can preview, copy or share a structured report. It can include your phone model, Android version, memory, battery and permissions only if you select that option. The report may still be identifying: review it and the receiving app before sharing. The self-check uses a generated tone and app-created temporary files, without requesting microphone access or opening your media. GitHub issues are public.

Separately, the app or Android may write messages and raw error details, including file paths, to the system device log or error dialog. Logs may be visible through Android debugging tools or to someone you choose to share them with. The app does not automatically upload those logs. Diagnostics do not change the existing backup or background-recording policy.

## Contact

For questions about this fork, open an issue at [github.com/rajbhx/deepdenoiser-enhanced](https://github.com/rajbhx/deepdenoiser-enhanced/issues). Avoid posting private recordings or sensitive logs publicly.
