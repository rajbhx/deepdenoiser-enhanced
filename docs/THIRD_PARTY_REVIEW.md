# Third-party notices and release review

**Status: incomplete — do not distribute a production build yet.** The generated in-app list is a reproducible inventory of installed npm dependencies reachable from the application's dependency graph. It is deliberately broader than the code that necessarily ships: it includes some build tools and platform-specific or optional packages. Conversely, it is not a complete inventory of the Android/Gradle dependency graph, native binaries, fonts, images, or model weights. License labels are package metadata, not a legal determination.

## Regenerate and inspect

On Linux after `bun install --frozen-lockfile --backend=copyfile`:

```sh
node scripts/generate-notices.cjs
node scripts/generate-notices.cjs --check
```

The generator includes locally packaged `LICENSE`, `LICENCE`, `COPYING`, and `NOTICE` files when present. For certain Expo workspace packages that omit the file, it labels the Expo repository license as a **shared fallback requiring review**. It includes the ONNX Runtime 1.24.3 upstream license and ThirdPartyNotices from the files under `docs/third-party/onnxruntime/`; verify that these match the exact Android artifact and all its shipped components. An empty notice list means no suitable local text was found, **not** that no notice is required. At the time of generation, 85 of the 590 app/model/npm records lacked locally included notice text; some are build-only. Recheck the generated list after every dependency change.

ONNX Runtime files were obtained from the upstream v1.24.3 tag:

- `https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/LICENSE` — SHA-256 `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c`.
- `https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/ThirdPartyNotices.txt` — SHA-256 `0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2`.

These upstream files are provided as a starting point, not proof that the exact packaged binary has no additional requirements.

## Model identity — unresolved release blocker

`assets/model/denoiser_model.ort` currently has SHA-256 `ec5ec24059035741763006dfaa6d463cfbbacf496caed5b5599ebe3477f2dd5b`. On 2026-10-29 we downloaded the model from the original app's [first model commit `f369aaaa`](https://github.com/sayampy/deepdenoiser/commit/f369aaaa3e27d1335d98c41cdb2bab2ff0b5c166) and confirmed it is **byte-for-byte identical** to this file (the same SHA-256 and Git blob `921f145607d34cccc44a440848df4275db4efdad`). That establishes the immediate app-repository source, not the upstream training-weight source or redistribution terms. The original repository describes the model as DeepFilterNet3 and is GPL-3.0, but the supplied metadata does not establish the exact weight origin, version, applicable model license, author notices, conversion steps or modifications. Obtain authoritative provenance and terms for this exact hash, retain required attribution/source and other notices, and consult a qualified reviewer. Do not infer that the app's GPL license automatically establishes permission to distribute the weights.

## Before any production distribution

1. Generate a dependency report/SBOM for the **release** Gradle runtime classpaths, inspect merged APK/AAB contents and native `.so` libraries, and map all shipped components, fonts and assets to exact versions, sources and licenses. Account for transitive third-party notices in ONNX Runtime and other AARs.
2. Resolve missing notices and verify all fallback license texts and copyright statements. Include required complete texts and source offers both in the app and the distributed package, as applicable.
3. Verify model weights and conversion provenance as above; review compatibility and obligations, including GPL source availability, with a qualified reviewer.
4. Complete device, privacy, backup/transfer and signing/upgrade checks, including the recording foreground-service behavior. Increment the Android version code for a new release. A prior debug-signed APK cannot be upgraded in place with a different signing key; export private recordings before any uninstall.
5. Re-run the npm and native security reviews, including the unresolved or backported advisories in `SECURITY_REVIEW.md`.
6. Only after the owner confirms the above, set the GitHub Actions repository variable `ANDROID_RELEASE_REVIEWED` to `true` to enable **production signing**. This is an explicit human attestation, not an automated legal or quality certification. Debug-signed testing builds remain available without it. See `RELEASE_SIGNING.md`.
