const { AndroidConfig, withAndroidManifest, withPlugins } = require("expo/config-plugins");

const SPEECH_SERVICE_PACKAGE = "com.google.android.googlequicksearchbox";

// expo-speech-recognition's own plugin also writes NSSpeechRecognitionUsageDescription
// into the iOS Info.plist. iOS dictation uses Apple's on-device transcriber, so this
// plugin applies only the Android half: the microphone permission and package
// visibility for the system recognition service (Android 11+).
function withSpeechServiceQuery(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults.manifest;
    manifest.queries ??= [];
    const declared = manifest.queries.some(
      (query) => query.package?.[0]?.$?.["android:name"] === SPEECH_SERVICE_PACKAGE,
    );
    if (!declared) {
      manifest.queries.push({
        package: [{ $: { "android:name": SPEECH_SERVICE_PACKAGE } }],
        intent: [{ action: [{ $: { "android:name": "android.speech.RecognitionService" } }] }],
      });
    }
    return nextConfig;
  });
}

module.exports = function withAndroidSpeechRecognition(config) {
  return withPlugins(config, [
    [AndroidConfig.Permissions.withPermissions, ["android.permission.RECORD_AUDIO"]],
    withSpeechServiceQuery,
  ]);
};
