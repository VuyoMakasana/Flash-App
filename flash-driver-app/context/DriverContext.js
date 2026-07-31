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
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import driverApi, { saveTokens, clearTokens } from '../services/api';
import {
  BACKGROUND_LOCATION_TASK,
  startBackgroundLocation,
  stopBackgroundLocation,
  isExpoGoRuntime,
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

        // Reconcile isOnline against reality instead of trusting a cached
        // guess: a driver who force-quit mid-shift (or reinstalled) can
        // leave the OS background-location task and the server's is_online
        // flag out of sync with each other, and neither is trustworthy on
        // its own. Whichever direction they disagree, resolve down to
        // "not online" — stop any orphaned OS task, and correct a stale
        // server-side is_online=true — rather than defaulting the UI to
        // false while a background task may still be silently running.
        if (t) {
          // CRITICAL FIX: Location.hasStartedLocationUpdatesAsync() hits the
          // exact same native-bridge-level failure under Expo Go that
          // startLocationUpdatesAsync() did (see backgroundLocationTask.js's
          // own fix) -- but this call runs unconditionally on every cold
          // start for any driver with a persisted session, not just when
          // tapping "Go Online". Found live: blank-screened on every open
          // once a real login had been completed once before, with no error
          // screen -- the .catch() below never runs because the failure
          // isn't a normal JS rejection. Background location never actually
          // runs under Expo Go regardless (backgroundLocationTask.js's own
          // header), so treating the OS task as never-running there is
          // correct, not a workaround -- the profile fetch alongside it is
          // pure network logic and carries no native-module risk.
          const [osTaskRunning, profile] = await Promise.all([
            isExpoGoRuntime()
              ? Promise.resolve(false)
              : Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false),
            driverApi.driver.getProfile().catch(() => null),
          ]);
          const serverOnline = profile?.driver?.is_online ?? false;
          if (profile?.driver) {
            setDriver(profile.driver);
            await AsyncStorage.setItem(AS_KEYS.driver, JSON.stringify(profile.driver));
          }

          if (osTaskRunning && serverOnline) {
            setIsOnlineState(true);
          } else {
            setIsOnlineState(false);
            if (osTaskRunning) await stopBackgroundLocation().catch(() => {});
            if (serverOnline) {
              await driverApi.driver.setOnline(false).catch(() => {});
              setDriver(prev => (prev ? { ...prev, is_online: false } : prev));
            }
          }
        }
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
    // driverApi.auth.logout() revokes the refresh token server-side (POST
    // /auth/logout) before clearing local tokens — previously this called
    // clearTokens() directly, leaving the refresh_tokens row live
    // server-side until it expired naturally or the periodic purge job ran.
    await driverApi.auth.logout();
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

  const acceptTerms = useCallback(async () => {
    await driverApi.auth.acceptTerms();
    setDriver(prev => {
      const next = prev ? { ...prev, terms_accepted: true } : prev;
      if (next) AsyncStorage.setItem(AS_KEYS.driver, JSON.stringify(next)).catch(() => {});
      return next;
    });
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
    let lat, lng;

    // Flash only operates within Nelson Mandela Bay — the backend rejects
    // going online from outside the service area, but it needs a fresh
    // device position to check against, not a possibly-stale/absent one.
    if (online) {
      const { status: existingStatus } = await Location.getForegroundPermissionsAsync();
      let finalStatus = existingStatus;
      if (finalStatus !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync();
        finalStatus = req.status;
      }
      if (finalStatus !== 'granted') {
        throw new Error('Location permission is required to go online.');
      }
      const position = await Location.getCurrentPositionAsync({});
      lat = position.coords.latitude;
      lng = position.coords.longitude;
    }

    await driverApi.driver.setOnline(online, lat, lng);
    setIsOnlineState(online);
    setDriver(prev => (prev ? { ...prev, is_online: online } : prev));

    if (online) {
      startBackgroundLocation().catch((err) => {
        console.warn('[DriverContext] BG location start failed:', err.message);
      });
    } else {
      await stopBackgroundLocation();
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
    acceptTerms,
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
