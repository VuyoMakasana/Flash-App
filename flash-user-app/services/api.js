/**
 * flash-user-app/services/api.js
 *
 * HIGH-4 FIX: Auth tokens (FLASH_TOKEN, FLASH_REFRESH_TOKEN) are now stored
 *   in expo-secure-store instead of AsyncStorage.
 *
 *   - On Android: encrypted using the Android Keystore system
 *   - On iOS: stored in the Keychain
 *   - AsyncStorage remains for non-sensitive data (cart, preferences)
 *
 *   SecureStore has a value size limit of ~2KB. JWTs are well under this.
 */

import * as SecureStore from 'expo-secure-store';

const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000';

// ── Token helpers (SecureStore — encrypted on device) ──────────────────────
const getToken        = async () => SecureStore.getItemAsync('FLASH_TOKEN');
const getRefreshToken = async () => SecureStore.getItemAsync('FLASH_REFRESH_TOKEN');

const saveTokens = async (token, refreshToken) => {
  await SecureStore.setItemAsync('FLASH_TOKEN', token);
  if (refreshToken) await SecureStore.setItemAsync('FLASH_REFRESH_TOKEN', refreshToken);
};

const clearTokens = async () => {
  await SecureStore.deleteItemAsync('FLASH_TOKEN').catch(() => {});
  await SecureStore.deleteItemAsync('FLASH_REFRESH_TOKEN').catch(() => {});
};

// ── Shared fetch wrapper ────────────────────────────────────────────────────
async function request(path, options = {}) {
  const token = await getToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  // Token expired — try to refresh once
  if (res.status === 401) {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${BASE_URL}/auth/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refreshToken }),
        });

        if (refreshRes.ok) {
          const data = await refreshRes.json();
          await saveTokens(data.token, data.refreshToken);

          // Retry the original request with the new token
          const retryRes = await fetch(`${BASE_URL}${path}`, {
            ...options,
            headers: {
              ...headers,
              Authorization: `Bearer ${data.token}`,
            },
          });

          if (!retryRes.ok) {
            const err = await retryRes.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error || 'Request failed');
          }
          return retryRes.json();
        }
      } catch (_refreshErr) {
        // Refresh failed — clear tokens and signal session expiry
      }
    }

    await clearTokens();
    throw new Error('SESSION_EXPIRED');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }

  // Some endpoints return 204 No Content
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Auth ──────────────────────────────────────────────────────────────────
const auth = {
  login: async (email, password) => {
    const data = await request('/auth/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
    });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  register: async (payload) => {
    const data = await request('/auth/register', {
      method: 'POST',
      body:   JSON.stringify(payload),
    });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  logout: async () => {
    try {
      const refreshToken = await getRefreshToken();
      if (refreshToken) {
        await request('/auth/logout', {
          method: 'POST',
          body:   JSON.stringify({ refreshToken }),
        }).catch(() => {});
      }
    } finally {
      await clearTokens();
    }
  },

  googleSignIn: (idToken) =>
    request('/auth/google/user', { method: 'POST', body: JSON.stringify({ idToken }) }),

  appleSignIn: (payload) =>
    request('/auth/apple/user', { method: 'POST', body: JSON.stringify(payload) }),

  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (token, newPassword) =>
    request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
};

// ── Products / Stores ─────────────────────────────────────────────────────
const products = {
  getAll:       (params = '') => request(`/products${params}`),
  getById:      (id)          => request(`/products/${id}`),
  getStores:    ()            => request('/stores'),
  getByStore:   (storeId)     => request(`/products?storeId=${storeId}`),
};

// ── Orders ────────────────────────────────────────────────────────────────
const orders = {
  create:    (body) => request('/orders',          { method: 'POST', body: JSON.stringify(body) }),
  getAll:    ()     => request('/orders'),
  getById:   (id)   => request(`/orders/${id}`),
  cancel:    (id)   => request(`/orders/${id}/cancel`, { method: 'POST' }),
  return:    (id, body) => request(`/orders/${id}/return`, { method: 'POST', body: JSON.stringify(body) }),
};

// ── Payments ──────────────────────────────────────────────────────────────
const payments = {
  initialize:    (orderId)         => request('/payments/initialize', { method: 'POST', body: JSON.stringify({ orderId }) }),
  verify:        (reference)       => request(`/payments/verify/${reference}`),
  cashOnDelivery:(orderId)         => request('/payments/cash-on-delivery', { method: 'POST', body: JSON.stringify({ orderId }) }),
  getStatus:     (orderId)         => request(`/payments/status/${orderId}`),
  getSavedCards: ()                => request('/payments/cards'),
  removeCard:    (cardId)          => request(`/payments/cards/${cardId}`, { method: 'DELETE' }),
  setDefaultCard:(cardId)          => request(`/payments/cards/${cardId}/default`, { method: 'PATCH' }),
  chargeSavedCard:(orderId, cardId)=> request('/payments/charge-saved-card', { method: 'POST', body: JSON.stringify({ orderId, cardId }) }),
};

// ── User profile ──────────────────────────────────────────────────────────
const user = {
  getProfile:    ()      => request('/users/profile'),
  updateProfile: (body)  => request('/users/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  uploadPhoto:   (formData) => request('/users/profile/photo', {
    method:  'POST',
    headers: {}, // Let fetch set Content-Type for multipart
    body:    formData,
  }),
  getAddresses:    ()     => request('/users/addresses'),
  addAddress:      (body) => request('/users/addresses', { method: 'POST', body: JSON.stringify(body) }),
  updateAddress:   (id, body) => request(`/users/addresses/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAddress:   (id)  => request(`/users/addresses/${id}`, { method: 'DELETE' }),
  deleteAccount:   ()    => request('/users/account', { method: 'DELETE' }),
};

// ── Trusted Drivers ───────────────────────────────────────────────────────
const trustedDrivers = {
  getAll:         ()          => request('/trusted-drivers'),
  getPending:     ()          => request('/trusted-drivers/pending'),
  sendRequest:    (driverId)  => request(`/trusted-drivers/${driverId}/request`, { method: 'POST' }),
  remove:         (driverId)  => request(`/trusted-drivers/${driverId}`, { method: 'DELETE' }),
  checkStatus:    (driverId)  => request(`/trusted-drivers/${driverId}/status`),
};

// ── Notifications ─────────────────────────────────────────────────────────
const notifications = {
  getAll:   () => request('/notifications'),
  markRead: (id) => request(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => request('/notifications/read-all', { method: 'POST' }),
};

// ── Feed ──────────────────────────────────────────────────────────────────
const feed = {
  getPosts: ()     => request('/feed'),
  getById:  (id)   => request(`/feed/${id}`),
};

export { BASE_URL, getToken, saveTokens, clearTokens };

export default {
  auth,
  products,
  orders,
  payments,
  user,
  trustedDrivers,
  notifications,
  feed,
};
