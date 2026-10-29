const IS_DEV = process.env.APP_VARIANT;
const { version } = require('./package.json');
const candidateCommit = process.env.DD_BUILD_COMMIT || process.env.GITHUB_SHA || '';
const buildCommit = /^[0-9a-f]{7,40}$/i.test(candidateCommit) ? candidateCommit.toLowerCase() : 'unknown';
module.exports = ({ config }) => {
  return {
    ...config,
    name: IS_DEV ? "DeepDenoiser (Dev)" : "DeepDenoiser",
    slug: "deepdenoiser",
    version,
    extra: { ...config.extra, diagnosticBuildCommit: buildCommit },
    android: {
      ...config.android,
      package: IS_DEV
        ? "com.sayampy.deepdenoiser.dev"
        : "com.sayampy.deepdenoiser",
    },
  };
};
