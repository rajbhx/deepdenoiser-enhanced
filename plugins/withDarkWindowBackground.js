const { withAndroidStyles } = require("@expo/config-plugins");

/** Match the Android activity window to the dark React Native navigation surface. */
function applyDarkWindow(resources) {
  const styles = resources?.resources?.style;
  const appTheme = Array.isArray(styles) && styles.find(style => style.$?.name === "AppTheme");
  if (!appTheme) throw new Error("Cannot find AppTheme to configure the activity window background");
  if (!Array.isArray(appTheme.item)) appTheme.item = [];
  const existing = appTheme.item.find(item => item.$?.name === "android:windowBackground");
  if (existing) existing._ = "#0F172A";
  else appTheme.item.push({ $: { name: "android:windowBackground" }, _: "#0F172A" });
  return resources;
}

module.exports = function withDarkWindowBackground(config) {
  return withAndroidStyles(config, config => {
    config.modResults = applyDarkWindow(config.modResults);
    return config;
  });
};
module.exports.applyDarkWindow = applyDarkWindow;
