const { withAppBuildGradle } = require("@expo/config-plugins");

/**
 * Release artifacts are unsigned unless a user-owned key is supplied. CI may
 * explicitly opt into debug signing for TEST artifacts; it is never a default.
 */
function configure(contents) {
  const marker = "// DeepDenoiser release signing (injected)";
  if (contents.includes(marker)) return contents;
  const signing = "    signingConfigs {";
  if (!contents.includes(signing)) throw new Error("Cannot find Android signingConfigs block");
  contents = contents.replace(signing, `${signing}
        ${marker}
        if (System.getenv("DD_RELEASE_KEYSTORE")) {
            release {
                storeFile file(System.getenv("DD_RELEASE_KEYSTORE"))
                storePassword System.getenv("DD_RELEASE_STORE_PASSWORD")
                keyAlias System.getenv("DD_RELEASE_KEY_ALIAS")
                keyPassword System.getenv("DD_RELEASE_KEY_PASSWORD")
            }
        }`);
  const release = /(release\s*\{\s*\/\/ Caution![\s\S]*?\n\s*)signingConfig signingConfigs\.debug/;
  if (!release.test(contents)) throw new Error("Cannot locate default release signing configuration");
  return contents.replace(release, `$1if (System.getenv("DD_RELEASE_KEYSTORE")) {
                if (!System.getenv("DD_RELEASE_STORE_PASSWORD") || !System.getenv("DD_RELEASE_KEY_ALIAS") || !System.getenv("DD_RELEASE_KEY_PASSWORD")) {
                    throw new GradleException("Release keystore credentials are incomplete")
                }
                signingConfig signingConfigs.release
            } else if (System.getenv("DD_ALLOW_DEBUG_SIGNING") == "true") {
                signingConfig signingConfigs.debug // explicitly marked TEST builds only
            } else {
                signingConfig null // unsigned; never silently use the debug key for production
            }`);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, config => {
    if (config.modResults.language !== "groovy") throw new Error("Unsupported Android Gradle language");
    config.modResults.contents = configure(config.modResults.contents);
    return config;
  });
};
module.exports.configure = configure;
