/**
 * flash-driver-app/services/api.js
 *
 * HIGH-4 FIX: Auth tokens stored in expo-secure-store (encrypted Keychain/Keystore)
 *   instead of AsyncStorage (plaintext on Android).
 */

import * as SecureStore from 'expo-secure-store';

export const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000';

// ── Token helpers (SecureStore — encrypted on device) ──────────────────────
export const getToken        = async () => SecureStore.getItemAsync('FLASH_DRIVER_TOKEN');
export const getRefreshToken = async () => SecureStore.getItemAsync('FLASH_DRIVER_REFRESH_TOKEN');

export const saveTokens = async (token, refreshToken) => {
  await SecureStore.setItemAsync('FLASH_DRIVER_TOKEN', token);
  if (refreshToken) await SecureStore.setItemAsync('FLASH_DRIVER_REFRESH_TOKEN', refreshToken);
};

export const clearTokens = async () => {
  await SecureStore.deleteItemAsync('FLASH_DRIVER_TOKEN').catch(() => {});
  await SecureStore.deleteItemAsync('FLASH_DRIVER_REFRESH_TOKEN').catch(() => {});
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
        // Refresh failed — clear and signal expiry
      }
    }

    await clearTokens();
    throw new Error('SESSION_EXPIRED');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Auth ──────────────────────────────────────────────────────────────────
const auth = {
  login: async (email, password) => {
    const data = await request('/auth/driver/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
    });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  register: async (payload) => {
    const data = await request('/auth/driver/register', {
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
    request('/auth/google/driver', { method: 'POST', body: JSON.stringify({ idToken }) }),

  appleSignIn: (payload) =>
    request('/auth/apple/driver', { method: 'POST', body: JSON.stringify(payload) }),
};

// ── Orders ────────────────────────────────────────────────────────────────
const orders = {
  getAvailable:  ()           => request('/orders/available'),
  getActive:     ()           => request('/orders/active'),
  accept:        (id)         => request(`/orders/${id}/accept`, { method: 'POST' }),
  updateStatus:  (id, status) => request(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  getById:       (id)         => request(`/orders/${id}`),
};

// ── Driver profile ─────────────────────────────────────────────────────────
const driver = {
  getProfile:     ()      => request('/drivers/profile'),
  updateProfile:  (body)  => request('/drivers/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  updateLocation: (lat, lng) => request('/drivers/location', { method: 'POST', body: JSON.stringify({ lat, lng }) }),
  setOnline:      (online) => request('/drivers/online', { method: 'POST', body: JSON.stringify({ online }) }),
  uploadDocument: (formData) => request('/drivers/documents', {
    method:  'POST',
    headers: {},
    body:    formData,
  }),
};

// ── Earnings / Wallet ──────────────────────────────────────────────────────
const earnings = {
  getSummary:     ()     => request('/drivers/earnings'),
  getTransactions:()     => request('/drivers/wallet/transactions'),
  requestPayout:  (body) => request('/drivers/payout', { method: 'POST', body: JSON.stringify(body) }),
  getBankDetails: ()     => request('/drivers/bank'),
  saveBankDetails:(body) => request('/drivers/bank', { method: 'POST', body: JSON.stringify(body) }),
};

// ── Subscription ──────────────────────────────────────────────────────────
const subscription = {
  getPlans:   ()      => request('/subscriptions/plans'),
  getCurrent: ()      => request('/subscriptions/current'),
  purchase:   (body)  => request('/subscriptions/purchase', { method: 'POST', body: JSON.stringify(body) }),
};

// ── Trusted Driver requests ───────────────────────────────────────────────
const trustedDrivers = {
  getRequests:  ()                   => request('/trusted-drivers/requests'),
  respond:      (requestId, action)  => request(`/trusted-drivers/${requestId}/respond`, {
    method: 'PATCH',
    body:   JSON.stringify({ action }),
  }),
};

// ── Payments (cash flow) ─────────────────────────────────────────────────
const payments = {
  sendCashOtp:     (orderId)       => request('/payments/cash/send-otp', { method: 'POST', body: JSON.stringify({ orderId }) }),
  confirmCash:     (orderId, otp)  => request('/payments/cash/confirm', { method: 'POST', body: JSON.stringify({ orderId, otp }) }),
  markCashFailed:  (orderId, reason) => request('/payments/cash/fail', { method: 'POST', body: JSON.stringify({ orderId, reason }) }),
};

const driverApi = {
  auth,
  orders,
  driver,
  earnings,
  subscription,
  trustedDrivers,
  payments,
};

export default driverApi;
