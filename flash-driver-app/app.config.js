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
      // PR E (#104): the founder's 1024x1024 App Store icon (opaque RGB, no
      // alpha). iOS only; Android and the splash keep ./assets/flash-logo.png.
      icon: './assets/icon-ios-1024.png',
      // PR E (#104): Apple's required-reason APIs, copied from the libraries'
      // own PrivacyInfo.xcprivacy files in node_modules (scanned 2026-11-27,
      // expo 54.0.37, react-native 0.81.5). Re-scan when dependencies change.
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            // react-native, async-storage, expo-application, react-native-maps (C617.1);
            // expo-file-system (0A2A.1, 3B52.1)
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
          },
          {
            // react-native, expo-constants, expo-localization, expo-notifications,
            // expo-system-ui, expo-task-manager (CA92.1); Google Maps SDK in react-native-maps (1C8F.1)
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'],
          },
          {
            // react-native (boost), expo-device, react-native-maps
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
          {
            // expo-file-system (E174.1, 85F4.1), react-native-maps (85F4.1)
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
            NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
          },
        ],
      },

      // PR E (#104): the Expo Go "DIAGNOSTIC" jsEngine: 'jsc' override is
      // removed. Real builds use Hermes, Expo SDK 54's default engine, and
      // Expo Go is no longer used (the store's Expo Go is SDK 58).
      config: {
        googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
      infoPlist: {
        NSCameraUsageDescription: 'Flash Driver needs camera access to photograph documents for account verification, and to take pickup/drop-off proof photos for each delivery.',
        NSPhotoLibraryUsageDescription: 'Flash Driver needs photo library access to upload profile and document photos.',
        // PR E (#104): honest texts. Background tracking runs whenever the
        // driver is online and stops on going offline or logging out
        // (context/DriverContext.js setOnline / logout). The app itself only
        // needs 'location'; 'fetch' stays because expo-task-manager's own
        // config plugin always adds it (the location task runs on that
        // library), and changing a library's requirement untested is riskier
        // than an unused background mode.
        NSLocationWhenInUseUsageDescription: 'Flash Driver uses your location while you are online to offer you nearby deliveries and show customers where their delivery is.',
        NSLocationAlwaysAndWhenInUseUsageDescription: 'Flash Driver uses your location in the background while you are online, so we can offer you nearby deliveries and customers can follow the delivery you are on. It stops when you go offline.',
        NSLocationAlwaysUsageDescription: 'Flash Driver uses your location in the background while you are online, so we can offer you nearby deliveries and customers can follow the delivery you are on. It stops when you go offline.',
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
      [
        'expo-location',
        {
          // Same texts as infoPlist above, so the plugin never falls back to
          // its generic "Allow $(PRODUCT_NAME) to access your location".
          locationWhenInUsePermission: 'Flash Driver uses your location while you are online to offer you nearby deliveries and show customers where their delivery is.',
          locationAlwaysAndWhenInUsePermission: 'Flash Driver uses your location in the background while you are online, so we can offer you nearby deliveries and customers can follow the delivery you are on. It stops when you go offline.',
          locationAlwaysPermission: 'Flash Driver uses your location in the background while you are online, so we can offer you nearby deliveries and customers can follow the delivery you are on. It stops when you go offline.',
          isIosBackgroundLocationEnabled: true,
        },
      ],
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
      // Required by posthog-react-native's Expo peer-dependency set (device
      // locale is included in PostHog's default app-properties payload) —
      // the installer couldn't auto-write this into a dynamic app.config.js
      // either, same limitation as the entries above.
      'expo-localization',
    ],
    extra: {
      privacyPolicyUrl: 'https://flashdelivery.co.za/privacy',
      eas: {
        projectId: '461d43ca-086d-4104-9a07-81897f2d7962',
      },
    },
  },
});
