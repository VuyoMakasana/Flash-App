/**
 * flash-driver-app/context/DriverContext.js
 *
 * HIGH-4 FIX: Auth tokens (FLASH_DRIVER_TOKEN, FLASH_DRIVER_REFRESH_TOKEN)
 *   stored in expo-secure-store instead of AsyncStorage.
 *
 *   Non-sensitive data (driver profile snapshot, active order ID for the
 *   background task) remains in AsyncStorage for simplicity. The background
 *   task (tasks/backgroundLocationTask.js) DOES read the token from
 *   SecureStore directly — a prior version of this comment claimed it
 *   couldn't, which left the task reading a key that only ever existed in
 *   AsyncStorage, silently disabling every background location ping.
 */

import React, {
  createContext, useContext, useState, useEffect, useCallback,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import driverApi, { saveTokens, clearTokens } from '../services/api';
import {
  startBackgroundLocation,
  stopBackgroundLocation,
} from '../tasks/backgroundLocationTask';

const DriverContext = createContext(null);

// Sensitive tokens → SecureStore
// Non-sensitive snapshot data → AsyncStorage (accessible to background task)
const AS_KEYS = {
  driver:      'FLASH_DRIVER',
  activeOrder: 'FLASH_DRIVER_ACTIVE_ORDER_ID',
};

const registerPushToken = async () => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;

    // getExpoPushTokenAsync() needs an explicit projectId — without it, this
    // previously threw and was swallowed by the catch below, silently
    // registering nothing on every launch.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const pushToken = tokenData.data;
    await driverApi.driver.savePushToken(pushToken).catch(() => {});
  } catch (e) {
    console.warn('Push token registration failed', e);
  }
};

export const DriverProvider = ({ children }) => {
  const [token, setToken]                   = useState(null);
  const [driver, setDriver]                 = useState(null);
  const [hydrated, setHydrated]             = useState(false);
  const [isOnline, setIsOnlineState]        = useState(false);
  const [activeOrder, setActiveOrderState]  = useState(null);

  // ── Hydration ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const hydrate = async () => {
      try {
        // Token from SecureStore (encrypted)
        const t = await SecureStore.getItemAsync('FLASH_DRIVER_TOKEN');
        // Driver profile snapshot from AsyncStorage (non-sensitive)
        const d = await AsyncStorage.getItem(AS_KEYS.driver);

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

  // Push token registration
  useEffect(() => {
    if (token && hydrated) registerPushToken();
  }, [token, hydrated]);

  const isAuthenticated = !!token && !!driver;

  // ── Active order (background task uses AsyncStorage directly) ─────────────
  const setActiveOrder = useCallback(async (order) => {
    setActiveOrderState(order);
    if (order?.id) {
      await AsyncStorage.setItem(AS_KEYS.activeOrder, String(order.id));
    } else {
      await AsyncStorage.removeItem(AS_KEYS.activeOrder);
    }
  }, []);

  // ── Shared post-login helper ──────────────────────────────────────────────
  const _postLogin = useCallback(async (data) => {
    // Auth tokens → SecureStore (encrypted)
    await saveTokens(data.token, data.refreshToken);
    // Driver snapshot → AsyncStorage (for background task access)
    await AsyncStorage.setItem(AS_KEYS.driver, JSON.stringify(data.driver));

    setToken(data.token);
    setDriver(data.driver);
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const data = await driverApi.auth.login(email, password);
    await _postLogin(data);
    await registerPushToken();
    return data;
  }, [_postLogin]);

  const loginWithApple = useCallback(async (identityToken, fullName, email) => {
    const data = await driverApi.auth.appleSignIn({ identityToken, fullName, email });
    await _postLogin(data);
    if (data.driver?.status === 'approved') await registerPushToken();
    return data;
  }, [_postLogin]);

  const loginWithGoogle = useCallback(async (idToken) => {
    const data = await driverApi.auth.googleSignIn(idToken);
    await _postLogin(data);
    if (data.driver?.status === 'approved') await registerPushToken();
    return data;
  }, [_postLogin]);

  const register = useCallback(async (formData) => {
    const data = await driverApi.auth.register(formData);
    await _postLogin(data);
    return data;
  }, [_postLogin]);

  const logout = useCallback(async () => {
    await stopBackgroundLocation();
    await AsyncStorage.removeItem(AS_KEYS.activeOrder);
    // Clear tokens from SecureStore
    await clearTokens();
    // Clear non-sensitive data
    await AsyncStorage.removeItem(AS_KEYS.driver).catch(() => {});

    setToken(null);
    setDriver(null);
    setIsOnlineState(false);
    setActiveOrderState(null);
  }, []);

  const handleSessionExpired = useCallback(async () => {
    await stopBackgroundLocation().catch(() => {});
    await clearTokens();
    await AsyncStorage.removeItem(AS_KEYS.driver).catch(() => {});
    setToken(null);
    setDriver(null);
    setIsOnlineState(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const data = await driverApi.driver.getProfile();
      setDriver(data.driver);
      await AsyncStorage.setItem(AS_KEYS.driver, JSON.stringify(data.driver));
      return data;
    } catch (e) {
      console.warn('Profile refresh failed', e);
    }
  }, []);

  // ── Online toggle ─────────────────────────────────────────────────────────
  const setOnline = useCallback(async (online) => {
    try {
      await driverApi.driver.setOnline(online);
      setIsOnlineState(online);
      setDriver(prev => (prev ? { ...prev, is_online: online } : prev));

      if (online) {
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
