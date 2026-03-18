import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import driverApi from '../services/api';

const DriverContext = createContext(null);

const STORAGE_KEYS = {
  token: 'FLASH_DRIVER_TOKEN',
  driver: 'FLASH_DRIVER',
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

  const isAuthenticated = !!token && !!driver;

  const login = useCallback(async (email, password) => {
    const data = await driverApi.auth.login(email, password);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token, data.token],
      [STORAGE_KEYS.driver, JSON.stringify(data.driver)],
    ]);
    setToken(data.token);
    setDriver(data.driver);
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
    register,
    logout,
    refreshProfile,
    setOnline,
  };

  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
};

export const useDriver = () => {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error('useDriver must be inside DriverProvider');
  return ctx;
};
