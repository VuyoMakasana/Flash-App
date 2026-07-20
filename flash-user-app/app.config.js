// flash-user-app/app.config.js
//
// D9 FIX: replaces the static app.json, which had the Google Maps API key
// hardcoded in plain text (and already rotated once in git history — the
// old key remains permanently recoverable there regardless of this fix).
// A static app.json cannot read environment variables at all, so there was
// no way to keep the key out of source control without this conversion.
//
// GOOGLE_MAPS_API_KEY must be provided at build time — for EAS builds, via
// `eas secret:create --name GOOGLE_MAPS_API_KEY --value <key> --type string`
// (do this after rotating the key in Google Cloud Console and restricting
// it to this app's bundle ID / package name / SHA-1 fingerprint). For a
// local `expo prebuild`, set it in your shell environment first.

module.exports = () => ({
  expo: {
    name: 'Flash',
    slug: 'flash-user-app',
    owner: 'vuyomakasana',
    version: '1.0.0',
    // Required for EAS Update — added by `eas update:configure`'s own
    // recommendation (it couldn't auto-write these into this dynamic
    // app.config.js). runtimeVersion "appVersion" ties update compatibility
    // to the `version` field above.
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/5caa686a-c2d2-491c-bc29-c2b23a12f6ce',
    },
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'co.za.flash.userapp',
      usesAppleSignIn: true,
      config: {
        googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
      infoPlist: {
        NSCameraUsageDescription: 'Flash needs camera access to take photos of your documents.',
        NSPhotoLibraryUsageDescription: 'Flash needs access to your photo library so you can upload a profile photo.',
        NSLocationWhenInUseUsageDescription: 'Flash uses your location to find nearby stores and track your delivery.',
        NSLocationAlwaysUsageDescription: 'Flash uses your location to track your delivery in real-time.',
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: 'co.za.flash.userapp',
      adaptiveIcon: {
        foregroundImage: './assets/icon.png',
        backgroundColor: '#0a0a0a',
      },
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
      ],
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY,
        },
      },
    },
    plugins: [
      'expo-location',
      'expo-notifications',
      'expo-apple-authentication',
      'expo-secure-store',
      // Required by @sentry/react-native on the SDK-54-downgraded
      // dependency set — the Expo CLI couldn't auto-add this to a
      // dynamic app.config.js (expo install --fix only writes into
      // static app.json).
      '@sentry/react-native',
      '@react-native-google-signin/google-signin',
      [
        'expo-build-properties',
        {
          android: {
            // Bumped from 35 -> 36: the EAS Android build failed at
            // :app:checkDebugAarMetadata because androidx.browser:1.9.0 and
            // androidx.core:1.17.0/core-ktx:1.17.0 (transitive deps pulled
            // in after upgrading expo-build-properties to the SDK 56
            // recommended patch version) require compileSdk >= 36.
            compileSdkVersion: 36,
            targetSdkVersion: 36,
          },
        },
      ],
      'expo-font',
    ],
    extra: {
      eas: {
        projectId: '5caa686a-c2d2-491c-bc29-c2b23a12f6ce',
      },
    },
  },
});
