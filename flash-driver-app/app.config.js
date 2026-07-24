// flash-driver-app/app.config.js
//
// D9 FIX: replaces the static app.json. The iOS key was hardcoded in plain
// text (and already rotated once in git history — the old key remains
// permanently recoverable there regardless of this fix); the Android key
// was already written as the literal string "$GOOGLE_MAPS_API_KEY", which
// looked like an env-var reference but a static app.json cannot read
// environment variables at all — that string was being sent to Google's
// native Maps SDK as the API key itself, which would never have worked.
//
// GOOGLE_MAPS_API_KEY must be provided at build time — for EAS builds, via
// `eas secret:create --name GOOGLE_MAPS_API_KEY --value <key> --type string`
// (do this after rotating the key in Google Cloud Console and restricting
// it to this app's bundle ID / package name / SHA-1 fingerprint). For a
// local `expo prebuild`, set it in your shell environment first.

module.exports = () => ({
  expo: {
    name: 'Flash Driver',
    slug: 'flash-driver-app',
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
      url: 'https://u.expo.dev/461d43ca-086d-4104-9a07-81897f2d7962',
    },
    orientation: 'portrait',
    icon: './assets/flash-logo.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/flash-logo.png',
      resizeMode: 'contain',
      backgroundColor: '#0a0a0a',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'co.za.flash.driverapp',
      usesAppleSignIn: true,
      // DIAGNOSTIC — testing period only, revert once resolved. Every
      // published EAS Update (Hermes bytecode) blank-screens in Expo Go on
      // a real iPhone 11 — no error, no crash, confirmed reproducible on
      // every publish tonight — while the exact same source served as
      // plain JS through a live Metro tunnel works correctly every time.
      // Per Expo's own docs/changelog: Hermes-bytecode-over-EAS-Update
      // support requires "the latest version of Expo Go," and an
      // incompatible Hermes VM version between the bytecode and the
      // installed Expo Go binary causes exactly this failure mode (native
      // bytecode-format mismatch, below the JS layer — nothing for our
      // ErrorBoundary or Sentry to ever catch). Expo Go's SDK 55 build has
      // been stuck in Apple App Store review since at least May 2026
      // (confirmed via Expo's changelog), so the installed client is
      // plausibly not current. Forcing jsc (JavaScriptCore, not Hermes)
      // for iOS makes this publish plain JS instead of Hermes bytecode —
      // sidesteps the failure class entirely if this diagnosis is right.
      // Not yet confirmed on-device — this is the test.
      jsEngine: 'jsc',
      config: {
        googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
      infoPlist: {
        NSCameraUsageDescription: 'Flash Driver needs camera access to photograph documents for account verification, and to take pickup/drop-off proof photos for each delivery.',
        NSPhotoLibraryUsageDescription: 'Flash Driver needs photo library access to upload profile and document photos.',
        NSLocationWhenInUseUsageDescription: 'Flash Driver uses your location so customers can track their deliveries.',
        NSLocationAlwaysAndWhenInUseUsageDescription: 'Flash Driver uses your location in the background to update your delivery position while on a job.',
        UIBackgroundModes: ['location', 'fetch'],
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: 'co.za.flash.driverapp',
      adaptiveIcon: {
        foregroundImage: './assets/flash-logo.png',
        backgroundColor: '#0a0a0a',
      },
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
        'CAMERA',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
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
      'expo-document-picker',
      'expo-image-picker',
      'expo-apple-authentication',
      'expo-task-manager',
      'expo-secure-store',
      // Config plugins required by expo-splash-screen@~56.0.12 and
      // expo-web-browser@~56.0.5 (both upgraded from long-stale major
      // versions incompatible with the current expo-modules-core) — the
      // Expo CLI couldn't auto-add these to a dynamic app.config.js.
      'expo-splash-screen',
      'expo-web-browser',
      // Required by expo-font and expo-router on the SDK-54-downgraded
      // dependency set — same dynamic-config limitation as above.
      'expo-font',
      'expo-router',
      '@react-native-google-signin/google-signin',
      [
        'expo-build-properties',
        {
          android: {
            // Bumped from 35 -> 36: the sibling user app's EAS Android build
            // failed at :app:checkDebugAarMetadata because androidx.browser:1.9.0
            // and androidx.core:1.17.0/core-ktx:1.17.0 (transitive deps pulled
            // in after upgrading expo-build-properties to the SDK 56
            // recommended patch version) require compileSdk >= 36. Applied here
            // proactively since this app shares the same dependency tree.
            compileSdkVersion: 36,
            targetSdkVersion: 36,
          },
          ios: {},
        },
      ],
    ],
    extra: {
      privacyPolicyUrl: 'https://flash-website.netlify.app/privacy',
      eas: {
        projectId: '461d43ca-086d-4104-9a07-81897f2d7962',
      },
    },
  },
});
