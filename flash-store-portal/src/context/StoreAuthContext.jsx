import { createContext, useContext, useState, useCallback } from 'react';
import { storeApi } from '../services/api';

// One global context holding auth/session state — matching the existing
// mobile apps' own FlashContext.js/DriverContext.js convention (CLAUDE.md).
const StoreAuthContext = createContext(null);

export function StoreAuthProvider({ children }) {
  const [storeUser, setStoreUser] = useState(() => {
    const raw = localStorage.getItem('flash_store_user');
    return raw ? JSON.parse(raw) : null;
  });

  const login = useCallback(async (email, password) => {
    const { token, storeUser: user } = await storeApi.login(email, password);
    localStorage.setItem('flash_store_token', token);
    localStorage.setItem('flash_store_user', JSON.stringify(user));
    setStoreUser(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await storeApi.logout();
    } catch (_) {
      // Best-effort — the client-side session must clear either way, same
      // as every mobile-app logout in this codebase.
    }
    localStorage.removeItem('flash_store_token');
    localStorage.removeItem('flash_store_user');
    setStoreUser(null);
  }, []);

  return (
    <StoreAuthContext.Provider value={{ storeUser, login, logout }}>
      {children}
    </StoreAuthContext.Provider>
  );
}

export function useStoreAuth() {
  const ctx = useContext(StoreAuthContext);
  if (!ctx) throw new Error('useStoreAuth must be used within StoreAuthProvider');
  return ctx;
}
