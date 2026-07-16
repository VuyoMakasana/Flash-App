// flash-driver-app/app/_layout.js
//
// CHANGE: Import backgroundLocationTask at the TOP of this file so the
// TaskManager.defineTask() call runs at app cold-start before any
// navigation renders. This is required by expo-task-manager — tasks must
// be defined in the root JS module, not inside a component or effect.

import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { DriverProvider, useDriver } from '../context/DriverContext';
import { setSessionExpiredHandler } from '../services/api';

// ── BACKGROUND LOCATION TASK REGISTRATION ───────────────────────────────────
// This import MUST stay at module level and MUST appear before any component
// definition. The side-effect of importing this module is that
// TaskManager.defineTask() is called, which registers the native handler.
// Moving this import inside a component or useEffect will break background
// location on Android.
import '../tasks/backgroundLocationTask';
// ────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/react-native';
// CRITICAL FIX: Sentry.init() ran unguarded at module top-level — before any
// component ever renders. Same risk class as the Google Sign-In crash found
// earlier this engagement (a native module not present under Expo Go's
// fixed module set throwing via TurboModuleRegistry): if Sentry's native
// binding isn't available in whatever runtime loads this bundle, this throws
// synchronously and takes the entire app down to a blank screen before
// anything renders, with no dev-mode red-screen to explain why (that
// overlay is a local-dev-server feature, not present when loading a
// published update). Guarded defensively; Sentry simply won't report
// errors in an environment where init fails, same tradeoff as everywhere
// else in this app that wraps a native module in try/catch.
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      environment: 'production',
      sendDefaultPii: false,
      // Defensive backstop — no known live leak today, but nothing previously
      // stopped a future captureException(err, { extra: { token } }) mistake
      // from actually reaching Sentry. Recursive, not just top-level of each
      // object — a single-level scrub misses a sensitive key nested one level
      // deeper (e.g. contexts.session.cookie), silently letting it through.
      beforeSend(event) {
        const SENSITIVE_KEY = /token|password|authorization|cookie|secret/i;
        const scrub = (obj, seen = new WeakSet()) => {
          if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
          seen.add(obj);
          for (const key of Object.keys(obj)) {
            if (SENSITIVE_KEY.test(key)) {
              delete obj[key];
            } else if (obj[key] && typeof obj[key] === 'object') {
              scrub(obj[key], seen);
            }
          }
        };
        scrub(event.extra);
        scrub(event.contexts);
        scrub(event.request);
        return event;
      },
    });
  } catch (_) {}
}

function RootLayoutNav() {
  const { isAuthenticated, loading, driver, handleSessionExpired } = useDriver();
  const router = useRouter();
  const segments = useSegments();

  // H11 FIX: session-expiry recovery now runs via a direct callback that
  // api.js's request() invokes the instant it detects an expired/revoked
  // token — unconditionally, before it even throws. Previously this only
  // ran through ErrorUtils.setGlobalHandler, which catches *uncaught*
  // exceptions only; nearly every screen wraps its driverApi calls in a
  // local try/catch (the dominant pattern in this app), which silently
  // swallowed the SESSION_EXPIRED error before it ever reached ErrorUtils —
  // a driver whose token expired just saw a raw "SESSION_EXPIRED" alert and
  // stayed stuck on the current screen. The ErrorUtils hook stays as a
  // defensive fallback for the rare call site with no local catch.
  useEffect(() => {
    setSessionExpiredHandler(handleSessionExpired);
    // CRITICAL FIX: `import { ErrorUtils } from 'react-native'` never
    // actually works — ErrorUtils is a React Native global
    // (global.ErrorUtils), not a named export of the react-native
    // package, on any RN version. The old import silently resolved to
    // undefined, so this useEffect crashed the app on every real mount
    // with "Cannot read property 'getGlobalHandler' of undefined" —
    // found via real on-device testing (flash-user-app hit the
    // identical bug), never caught by unit tests or bundle export
    // checks since neither actually executes a component render pass.
    // Guarded defensively even though global.ErrorUtils is provably
    // always set by React Native's own core (see
    // node_modules/react-native/Libraries/vendor/core/ErrorUtils.js —
    // `export default global.ErrorUtils`, established before any user
    // module loads).
    if (!global.ErrorUtils) return;
    const originalHandler = global.ErrorUtils.getGlobalHandler();
    global.ErrorUtils.setGlobalHandler((error, isFatal) => {
      if (error?.message === 'SESSION_EXPIRED') {
        handleSessionExpired();
        return;
      }
      originalHandler(error, isFatal);
    });
    return () => global.ErrorUtils.setGlobalHandler(originalHandler);
  }, [handleSessionExpired]);

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === 'auth';
    const inDriver = segments[0] === 'driver';
    const inTerms = segments[0] === 'auth' && segments[1] === 'terms';

    if (!isAuthenticated && !inAuth) {
      router.replace('/auth/login');
    } else if (isAuthenticated && driver && driver.terms_accepted !== true && !inTerms) {
      // The driver app previously had no terms-acceptance mechanism at all —
      // a driver could register and start earning without ever seeing any
      // Terms & Conditions. Gated the same way the user app already gates
      // on FlashContext's terms_accepted, ahead of the approval/onboarding
      // check below so it applies regardless of document-review status.
      router.replace('/auth/terms');
    } else if (isAuthenticated && driver && driver.terms_accepted === true) {
      const status = driver?.status;
      if (status === 'approved' && inAuth) {
        router.replace('/driver/dashboard');
      } else if (status !== 'approved' && inDriver) {
        router.replace('/auth/onboarding');
      }
    }
  }, [isAuthenticated, loading, segments, driver?.status, driver?.terms_accepted, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#f59e0b" size="large" />
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="auth/login" />
        <Stack.Screen name="auth/register" />
        <Stack.Screen name="auth/terms" />
        <Stack.Screen name="auth/onboarding" />
        <Stack.Screen name="driver/dashboard" />
        <Stack.Screen name="driver/earnings" />
        <Stack.Screen name="driver/profile" />
        <Stack.Screen name="driver/subscription" />
        <Stack.Screen name="driver/bank" />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}

export default function RootLayout() {
  return (
    <DriverProvider>
      <RootLayoutNav />
    </DriverProvider>
  );
}