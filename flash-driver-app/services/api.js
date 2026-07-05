/**
 * flash-driver-app/services/api.js
 *
 * HIGH-4 FIX: Auth tokens stored in expo-secure-store (encrypted Keychain/Keystore)
 *   instead of AsyncStorage (plaintext on Android).
 *
 * D1/D3/H10 FIX: every path here previously targeted routes that don't exist on
 *   the real backend — missing the `/api` prefix (every route in
 *   backend/src/server.js is mounted under /api/...), wrong path shapes
 *   (e.g. PATCH /orders/:id/status instead of PUT /api/orders/:id/status),
 *   and whole namespaces (bank, profile document upload) that were never
 *   implemented at all. Rewritten against backend/src/routes/*.js as the
 *   source of truth. BASE_URL itself stays a bare origin (no /api) because
 *   it's also used directly for the Socket.IO connection in dashboard.js —
 *   the /api prefix is added centrally in request() instead.
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

// H11 FIX: session-expiry recovery previously relied entirely on
// ErrorUtils.setGlobalHandler catching the thrown 'SESSION_EXPIRED' Error in
// _layout.js — but that only catches truly *uncaught* exceptions, and nearly
// every screen wraps its driverApi calls in a local try/catch (the dominant
// pattern in this app), which swallows the error before it ever reaches
// ErrorUtils. A driver whose token expired saw a raw "SESSION_EXPIRED" alert
// and stayed stuck on the current screen. _layout.js now registers a real
// callback here, invoked directly and unconditionally at the moment expiry
// is detected — independent of whether the caller catches the error too.
let onSessionExpired = null;
export const setSessionExpiredHandler = (fn) => { onSessionExpired = fn; };

// ── Shared fetch wrapper ────────────────────────────────────────────────────
function buildHeaders(token, isFormData, extra) {
  return {
    // A FormData body needs fetch to set its own multipart boundary —
    // setting Content-Type here would break the upload.
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function request(path, options = {}) {
  const token = await getToken();
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = buildHeaders(token, isFormData, options.headers);

  const res = await fetch(`${BASE_URL}/api${path}`, { ...options, headers });

  // Token expired — try to refresh once
  if (res.status === 401) {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refreshToken }),
        });

        if (refreshRes.ok) {
          const data = await refreshRes.json();
          await saveTokens(data.token, data.refreshToken);

          const retryRes = await fetch(`${BASE_URL}/api${path}`, {
            ...options,
            headers: buildHeaders(data.token, isFormData, options.headers),
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
    if (onSessionExpired) onSessionExpired();
    throw new Error('SESSION_EXPIRED');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const thrown = new Error(err.error || 'Request failed');
    // Some endpoints (e.g. driver login) return a structured `status` field
    // alongside the message (driver.status: pending_documents/suspended/etc).
    // Attach it so callers can branch on the real value instead of fragile
    // substring-matching the free-text message, which silently breaks the
    // moment the message copy changes.
    if (err.status) thrown.status = err.status;
    throw thrown;
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

  googleSignIn: async (idToken) => {
    const data = await request('/auth/driver/google', { method: 'POST', body: JSON.stringify({ idToken }) });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  appleSignIn: async (payload) => {
    const data = await request('/auth/driver/apple', { method: 'POST', body: JSON.stringify(payload) });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },
};

// ── Orders ────────────────────────────────────────────────────────────────
const orders = {
  getAvailable:  ()           => request('/drivers/available-orders'),
  getActive:     ()           => request('/drivers/active-order'),
  accept:        (id)         => request(`/drivers/orders/${id}/accept`, { method: 'POST' }),
  cancelActive:  (id)         => request(`/drivers/orders/${id}/cancel`, { method: 'POST' }),
  updateStatus:  (id, status) => request(`/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  getById:       (id)         => request(`/orders/${id}`),
};

// ── Driver profile ─────────────────────────────────────────────────────────
const driver = {
  getProfile:     ()      => request('/drivers/me'),
  updateProfile:  (body)  => request('/drivers/me', { method: 'PUT', body: JSON.stringify(body) }),
  updateLocation: (lat, lng, orderId) => request('/drivers/location', {
    method: 'POST',
    body:   JSON.stringify({ lat, lng, orderId }),
  }),
  setOnline:      (online, lat, lng) => request('/drivers/online', { method: 'POST', body: JSON.stringify({ online, lat, lng }) }),
  savePushToken:  (pushToken) => request('/drivers/push-token', {
    method: 'POST',
    body:   JSON.stringify({ push_token: pushToken }),
  }),
  // formData must contain a `document_type` field and a `document` file field —
  // matches upload.single('document') + req.body.document_type on the backend.
  uploadDocument: (formData) => request('/drivers/documents/upload', {
    method: 'POST',
    body:   formData,
  }),
};

// ── Bank account / payout setup ─────────────────────────────────────────────
const bank = {
  getBanks: async () => {
    const data = await request('/drivers/bank/supported-banks');
    return { banks: data.banks || [] };
  },
  getAccount: async () => {
    const data = await request('/drivers/bank/account');
    return { account: data.bank_account || null };
  },
  verifyAccount: async (accountNumber, bankCode) => {
    const data = await request('/drivers/bank/verify', {
      method: 'POST',
      body:   JSON.stringify({ account_number: accountNumber, bank_code: bankCode }),
    });
    // A non-2xx response already throws in request(), so reaching here means
    // Paystack resolved the account — mark it verified for the caller.
    return { ...data, verified: true };
  },
  saveAccount: (accountNumber, bankCode, accountName) => request('/drivers/bank/save', {
    method: 'POST',
    body:   JSON.stringify({
      account_number: accountNumber,
      bank_code:      bankCode,
      account_name:   accountName,
    }),
  }),
};

// ── Earnings / Wallet ──────────────────────────────────────────────────────
const earnings = {
  getSummary:    ()     => request('/drivers/earnings'),
  requestPayout: (amount) => request('/drivers/wallet/payout-request', {
    method: 'POST',
    body:   JSON.stringify({ amount }),
  }),
};

// ── Subscription ──────────────────────────────────────────────────────────
const subscription = {
  getCurrent: () => request('/subscriptions/driver'),
  purchase:   (planId) => request('/subscriptions/driver/purchase', {
    method: 'POST',
    body:   JSON.stringify({ planId }),
  }),
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

// ── SOS / safety ─────────────────────────────────────────────────────────
const sos = {
  trigger: (orderId, lat, lng) => request(`/sos/${orderId}/trigger`, { method: 'POST', body: JSON.stringify({ lat, lng }) }),
};

const driverApi = {
  auth,
  orders,
  driver,
  bank,
  earnings,
  subscription,
  trustedDrivers,
  payments,
  sos,
};

export default driverApi;
