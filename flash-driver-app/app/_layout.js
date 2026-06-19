// flash-driver-app/app/_layout.js
//
// CHANGE: Import backgroundLocationTask at the TOP of this file so the
// TaskManager.defineTask() call runs at app cold-start before any
// navigation renders. This is required by expo-task-manager — tasks must
// be defined in the root JS module, not inside a component or effect.

import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, ErrorUtils } from 'react-native';
import { DriverProvider, useDriver } from '../context/DriverContext';

// ── BACKGROUND LOCATION TASK REGISTRATION ───────────────────────────────────
// This import MUST stay at module level and MUST appear before any component
// definition. The side-effect of importing this module is that
// TaskManager.defineTask() is called, which registers the native handler.
// Moving this import inside a component or useEffect will break background
// location on Android.
import '../tasks/backgroundLocationTask';
// ────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/react-native';
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN, environment: 'production' });
}

function RootLayoutNav() {
  const { isAuthenticated, loading, driver, handleSessionExpired } = useDriver();
  const router = useRouter();
  const segments = useSegments();

  // SESSION EXPIRY: Intercept SESSION_EXPIRED errors thrown by the driver api.js
  // 401 handler anywhere in the app and cleanly log the driver out.
  useEffect(() => {
    const originalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      if (error?.message === 'SESSION_EXPIRED') {
        handleSessionExpired();
        return;
      }
      originalHandler(error, isFatal);
    });
    return () => ErrorUtils.setGlobalHandler(originalHandler);
  }, [handleSessionExpired]);

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === 'auth';
    const inDriver = segments[0] === 'driver';

    if (!isAuthenticated && !inAuth) {
      router.replace('/auth/login');
    } else if (isAuthenticated) {
      const status = driver?.status;
      if (status === 'approved' && inAuth) {
        router.replace('/driver/dashboard');
      } else if (status !== 'approved' && inDriver) {
        router.replace('/auth/onboarding');
      }
    }
  }, [isAuthenticated, loading, segments, driver?.status, router]);

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