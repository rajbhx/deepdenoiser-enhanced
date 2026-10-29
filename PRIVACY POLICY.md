# DeepDenoiser Enhanced privacy notice

This notice describes the `rajbhx/deepdenoiser-enhanced` Android fork, not other versions of DeepDenoiser.

## Media and processing

The app processes audio, video and microphone recordings on the device. It does not send media to a server for denoising and has no configured analytics or advertising SDK in this fork. Imported files, working data, settings and processed outputs can be stored in the app's private storage; temporary processing data may be stored in the Android cache. The app permits Android's default backup behavior: depending on the device and user settings, eligible private app files may be copied to cloud backup or a device-to-device transfer. Cache files are generally excluded and can also be removed by Android. The app does not disable existing backup or transfer behavior.

Clearing app data or uninstalling can delete private app copies. Copies you choose to save to your media library, share with another app, or include in a device backup are managed separately and may remain afterward.

## Permissions and sharing

The Android document picker is used to select media. Microphone permission is requested when you start a recording; media-library access is requested when you save. You can use other available functions if you decline a permission. If you choose Share, the selected receiving app handles the shared file under its own privacy practices. Opening external links leaves the app.

The app may write diagnostic messages to the device log, including error details or file paths. Logs may be visible through Android debugging tools or to someone you choose to share them with. The app does not automatically upload those logs.

## Contact

For questions about this fork, open an issue at [github.com/rajbhx/deepdenoiser-enhanced](https://github.com/rajbhx/deepdenoiser-enhanced/issues). Avoid posting private recordings or sensitive logs publicly.
