import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import driverApi from '../services/api';

const DriverContext = createContext(null);

const STORAGE_KEYS = {
  token:        'FLASH_DRIVER_TOKEN',
  driver:       'FLASH_DRIVER',
  refreshToken: 'FLASH_DRIVER_REFRESH_TOKEN',
};

// FIX 6: Added push notification registration — drivers were missing new orders when the app was backgrounded because the system relied solely on sockets which disconnect in the background
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
  const [token, setToken] = useState(null);
  const [driver, setDriver] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [isOnline, setIsOnlineState] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);

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

  // FIX 6: Register push token after hydration so backend can reach this device when app is backgrounded
  useEffect(() => {
    if (token && hydrated) {
      registerPushToken(token);
    }
  }, [token, hydrated]);

  const isAuthenticated = !!token && !!driver;

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

  // Apple Sign In for drivers on iPhone.
  // New drivers land on document upload. Returning approved drivers go to dashboard.
  const loginWithApple = useCallback(async (identityToken, fullName, email) => {
    const data = await driverApi.auth.appleSignIn(identityToken, fullName, email);
    // Store token regardless — the calling screen reads nextStep to route correctly
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token,        data.token],
      [STORAGE_KEYS.driver,       JSON.stringify(data.driver)],
      [STORAGE_KEYS.refreshToken, data.refreshToken || ''],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    if (data.driver?.status === 'approved') await registerPushToken(data.token);
    return data; // Caller checks data.nextStep for routing
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
      [STORAGE_KEYS.token, data.token],
      [STORAGE_KEYS.driver, JSON.stringify(data.driver)],
    ]);
    setToken(data.token);
    setDriver(data.driver);
    return data;
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = await AsyncStorage.getItem(STORAGE_KEYS.refreshToken).catch(() => null);
    if (refreshToken) driverApi.auth.logout(refreshToken).catch(() => {});
    await AsyncStorage.multiRemove([STORAGE_KEYS.token, STORAGE_KEYS.driver, STORAGE_KEYS.refreshToken]);
    setToken(null);
    setDriver(null);
    setActiveOrder(null);
  }, []);

  // SESSION EXPIRY HANDLER: called when any driver API call returns 401
  // WHY: Centralises the logout-on-expiry logic. The _layout.js global error
  // handler catches SESSION_EXPIRED errors from any screen and calls this.
  const handleSessionExpired = useCallback(async () => {
    await AsyncStorage.multiRemove([STORAGE_KEYS.token, STORAGE_KEYS.driver]);
    setToken(null);
    setDriver(null);
    setActiveOrder(null);
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

  const setOnline = useCallback(async (online) => {
    try {
      await driverApi.status.setOnline(online);
      setIsOnlineState(online);
      setDriver(prev => prev ? { ...prev, is_online: online } : prev);
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
