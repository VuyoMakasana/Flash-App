// flash-driver-app/context/DriverContext.js
//
// CHANGES FROM ORIGINAL:
//   1. Import startBackgroundLocation / stopBackgroundLocation from the task file.
//   2. Call startBackgroundLocation() when driver goes online.
//   3. Call stopBackgroundLocation() when driver goes offline OR logs out.
//   4. Store active order ID in AsyncStorage so the background task can read
//      it without React state (which is unavailable in a background process).

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import driverApi from '../services/api';
import {
  startBackgroundLocation,
  stopBackgroundLocation,
} from '../tasks/backgroundLocationTask';

const DriverContext = createContext(null);

const STORAGE_KEYS = {
  token:        'FLASH_DRIVER_TOKEN',
  driver:       'FLASH_DRIVER',
  refreshToken: 'FLASH_DRIVER_REFRESH_TOKEN',
  activeOrder:  'FLASH_DRIVER_ACTIVE_ORDER_ID',
};

const registerPushToken = async (authToken) => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenData.data;

    await driverApi.notifications.registerToken(pushToken);
  } catch (e) {
    console.warn('Push token registration failed', e);
  }
};

export const DriverProvider = ({ children }) => {
  const [token, setToken]           = useState(null);
  const [driver, setDriver]         = useState(null);
  const [hydrated, setHydrated]     = useState(false);
  const [isOnline, setIsOnlineState] = useState(false);
  const [activeOrder, setActiveOrderState] = useState(null);

  // ── HYDRATION ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const hydrate = async () => {
      try {
        const [t, d] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.token),
          AsyncStorage.getItem(STORAGE_KEYS.driver),
        ]);
        if (t) setToken(t);
        if (d) setDriver(JSON.parse(d));
      } catch (e) {
        console.warn('Driver hydration failed', e);
      } finally {
        setHydrated(true);
      }
    };
    hydrate();
  }, []);

  // ── PUSH TOKEN ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (token && hydrated) {
      registerPushToken(token);
    }
  }, [token, hydrated]);

  const isAuthenticated = !!token && !!driver;

  // ── ACTIVE ORDER: keep AsyncStorage in sync ────────────────────────────────
  // The background location task cannot access React state. It reads the
  // active order ID directly from AsyncStorage so it can include orderId in
  // every location POST while the app is backgrounded.
  const setActiveOrder = useCallback(async (order) => {
    setActiveOrderState(order);
    if (order?.id) {
      await AsyncStorage.setItem(STORAGE_KEYS.activeOrder, String(order.id));
    } else {
      await AsyncStorage.removeItem(STORAGE_KEYS.activeOrder);
    }
  }, []);

  // ── AUTH ──────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const data = await driverApi.auth.login(email, password);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token,        data.token],
      [STORAGE_KEYS.driver,       JSON.stringify(data.driver)],
      [STORAGE_KEYS.refreshToken, data.refreshToken || ''],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    await registerPushToken(data.token);
    return data;
  }, []);

  const loginWithApple = useCallback(async (identityToken, fullName, email) => {
    const data = await driverApi.auth.appleSignIn(identityToken, fullName, email);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token,        data.token],
      [STORAGE_KEYS.driver,       JSON.stringify(data.driver)],
      [STORAGE_KEYS.refreshToken, data.refreshToken || ''],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    if (data.driver?.status === 'approved') await registerPushToken(data.token);
    return data;
  }, []);

  const loginWithGoogle = useCallback(async (idToken) => {
    const data = await driverApi.auth.googleSignIn(idToken);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token,        data.token],
      [STORAGE_KEYS.driver,       JSON.stringify(data.driver)],
      [STORAGE_KEYS.refreshToken, data.refreshToken || ''],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    if (data.driver?.status === 'approved') await registerPushToken(data.token);
    return data;
  }, []);

  const register = useCallback(async (formData) => {
    const data = await driverApi.auth.register(formData);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token,  data.token],
      [STORAGE_KEYS.driver, JSON.stringify(data.driver)],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    return data;
  }, []);

  const logout = useCallback(async () => {
    // Stop background location before clearing credentials so the final
    // stopLocationUpdatesAsync call can still find the task.
    await stopBackgroundLocation();
    await AsyncStorage.removeItem(STORAGE_KEYS.activeOrder);

    const refreshToken = await AsyncStorage.getItem(STORAGE_KEYS.refreshToken).catch(() => null);
    if (refreshToken) driverApi.auth.logout(refreshToken).catch(() => {});
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.token,
      STORAGE_KEYS.driver,
      STORAGE_KEYS.refreshToken,
    ]);
    setToken(null);
    setDriver(null);
    setActiveOrderState(null);
    setIsOnlineState(false);
  }, []);

  const handleSessionExpired = useCallback(async () => {
    await stopBackgroundLocation();
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.token,
      STORAGE_KEYS.driver,
      STORAGE_KEYS.activeOrder,
    ]);
    setToken(null);
    setDriver(null);
    setActiveOrderState(null);
    setIsOnlineState(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const data = await driverApi.profile.getMe();
      setDriver(data.driver);
      await AsyncStorage.setItem(STORAGE_KEYS.driver, JSON.stringify(data.driver));
      return data;
    } catch (e) {
      console.warn('Profile refresh failed', e);
    }
  }, []);

  // ── ONLINE TOGGLE ─────────────────────────────────────────────────────────
  // When driver goes ONLINE  → start background location updates.
  // When driver goes OFFLINE → stop  background location updates.
  const setOnline = useCallback(async (online) => {
    try {
      await driverApi.status.setOnline(online);
      setIsOnlineState(online);
      setDriver(prev => prev ? { ...prev, is_online: online } : prev);

      if (online) {
        // Non-blocking: location start may show a permissions dialog.
        // We don't block the online toggle on the result — if permission
        // is denied the driver is still online, just without BG location.
        startBackgroundLocation().catch((err) => {
          console.warn('[DriverContext] BG location start failed:', err.message);
        });
      } else {
        await stopBackgroundLocation();
      }
    } catch (e) {
      throw e;
    }
  }, []);

  const value = {
    loading: !hydrated,
    isAuthenticated,
    driver,
    token,
    isOnline,
    activeOrder,
    setActiveOrder,
    login,
    loginWithApple,
    loginWithGoogle,
    register,
    logout,
    refreshProfile,
    setOnline,
    handleSessionExpired,
  };

  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
};

export const useDriver = () => {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error('useDriver must be inside DriverProvider');
  return ctx;
};