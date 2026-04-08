import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { DriverProvider, useDriver } from '../context/DriverContext';

function RootLayoutNav() {
  const { isAuthenticated, loading, driver } = useDriver();
  const router = useRouter();
  const segments = useSegments();

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
