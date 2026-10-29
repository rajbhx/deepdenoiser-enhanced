# Android release signing

A production release requires a signing key owned and backed up by the app owner. The repository does **not** contain that key. Never paste keystores or passwords into chat, source control, build logs, or issue comments.

## GitHub Actions

In the repository's **Settings → Secrets and variables → Actions**, add all five repository secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded contents of your release keystore (one continuous line) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Alias of the signing key |
| `ANDROID_KEY_PASSWORD` | Key password |
| `ANDROID_CERT_SHA256` | Expected signing certificate SHA-256 fingerprint, with or without colons |

The workflow decodes the keystore only into the runner's temporary directory, signs the release, then checks the artifact's certificate against the expected fingerprint and rejects Android's debug certificate. Missing *some* of the secrets fails the build. When **none** are configured, CI explicitly creates a **testing-debug-signed** artifact; its name and summary say testing only. It is not a production release.

Production signing additionally requires the repository Actions variable `ANDROID_RELEASE_REVIEWED=true`. Set it only after completing [the third-party/model, device, privacy, backup and upgrade review](THIRD_PARTY_REVIEW.md); the gate is a human attestation, not proof of compliance. The bundled model provenance and complete native notices are currently unresolved, so do not set it yet. Local and EAS signing do not enforce this GitHub-only gate: the same review remains mandatory.

You can create a new keystore locally using Android's official `keytool` instructions, or use your existing app-signing/upload key if you already have one. Record the key alias and keep multiple secure, offline backups of the keystore and passwords. Losing the signing key can prevent updates to installed versions. To view the certificate fingerprint locally:

```sh
keytool -list -v -keystore /secure/path/deepdenoiser-release.jks -alias YOUR_ALIAS
```

Enter the password at the prompt; do not put it on a command line. Encode the keystore locally using `base64` (on GNU/Linux, `base64 -w 0 /secure/path/deepdenoiser-release.jks`) and enter the value as the GitHub secret. Delete temporary copies after uploading. Restrict repository administrator access and GitHub Actions permissions.

## Local / EAS builds

The Expo plugin configures Gradle to use `DD_RELEASE_KEYSTORE`, `DD_RELEASE_STORE_PASSWORD`, `DD_RELEASE_KEY_ALIAS`, and `DD_RELEASE_KEY_PASSWORD` when supplied via a secure environment. Without those variables, a release build is **unsigned** by default. Setting `DD_ALLOW_DEBUG_SIGNING=true` opts into a debug-signed **test** artifact only. For EAS, configure and verify the appropriate secure signing environment rather than assuming a build is production-signed. Verify the final APK with `apksigner verify --verbose --print-certs` (or the AAB with `keytool -printcert -jarfile`).

The previous 2.0 test APK was debug-signed. An APK signed with a different production key cannot update that installation in place. **Export any app-private recordings/results first**: uninstalling or clearing app data deletes private copies. Test installation, upgrade, rollback and backup on a real device before distribution.
