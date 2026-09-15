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
    const { token, storeUser: user, forcePasswordReset } = await storeApi.login(email, password);
    // Admin Platform Phase 3 — carried on the client-side user object so
    // ProtectedRoute can proactively redirect to /account, but this is a UX
    // nicety only: requireStorePasswordCurrent (backend) is the real
    // enforcement, the same "server is the boundary, client hides UI"
    // discipline used everywhere else in this codebase.
    const merged = { ...user, forcePasswordReset: !!forcePasswordReset };
    localStorage.setItem('flash_store_token', token);
    localStorage.setItem('flash_store_user', JSON.stringify(merged));
    setStoreUser(merged);
    return merged;
  }, []);

  // Called after a successful change-password so the forced-reset redirect
  // stops firing immediately, without requiring a full re-login.
  const clearForcePasswordReset = useCallback((newToken) => {
    if (newToken) localStorage.setItem('flash_store_token', newToken);
    setStoreUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, forcePasswordReset: false };
      localStorage.setItem('flash_store_user', JSON.stringify(updated));
      return updated;
    });
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
    <StoreAuthContext.Provider value={{ storeUser, login, logout, clearForcePasswordReset }}>
      {children}
    </StoreAuthContext.Provider>
  );
}

export function useStoreAuth() {
  const ctx = useContext(StoreAuthContext);
  if (!ctx) throw new Error('useStoreAuth must be used within StoreAuthProvider');
  return ctx;
}
