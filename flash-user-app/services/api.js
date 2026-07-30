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
 *
 * D8 FIX: every path here was missing the /api prefix (every backend route
 *   is mounted under /api/... in backend/src/server.js), several paths did
 *   not match the real route shape at all (e.g. GET /orders instead of
 *   GET /api/orders/my-orders, GET /products instead of GET /api/inventory),
 *   and register()/appleSignIn() took multiple positional arguments from
 *   their only callers (FlashContext.js) but only ever bound the first one
 *   to a single `payload` parameter — every sign-up and Apple sign-in sent
 *   a bare JSON string as the request body instead of an object. Rewritten
 *   against backend/src/routes/*.js as the source of truth. Two methods
 *   (getStores, getByStore) called a /stores endpoint that has never
 *   existed on the backend and nothing in the app called them — removed.
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

// H-8 FIX: session-expiry recovery previously relied entirely on
// ErrorUtils.setGlobalHandler catching the thrown 'SESSION_EXPIRED' Error in
// App.js — but that only catches truly *uncaught* exceptions, and nearly
// every screen wraps its api calls in a local try/catch, which swallows the
// error before it ever reaches ErrorUtils. FlashContext's isAuthenticated
// state was never actually reset, so a user whose token expired was stuck
// in a dead, authenticated-looking UI until they force-quit. App.js now
// registers a real callback here, invoked directly and unconditionally at
// the moment expiry is detected — independent of whether the caller catches
// the error too. (Same pattern already used in flash-driver-app/services/
// api.js.)
let onSessionExpired = null;
export const setSessionExpiredHandler = (fn) => { onSessionExpired = fn; };

// H-7 FIX: no fetch() call here had a timeout — a dropped connection (common
// on South African cellular networks, this app's actual target) hung
// indefinitely instead of failing, with no way for the caller to know
// whether the request is still in flight. 20s is generous enough for a slow
// mobile connection while still giving the user a clear failure instead of
// a frozen screen.
const REQUEST_TIMEOUT_MS = 20_000;
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Shared fetch wrapper ────────────────────────────────────────────────────
async function request(path, options = {}) {
  const token = await getToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetchWithTimeout(`${BASE_URL}/api${path}`, { ...options, headers });

  // Token expired — try to refresh once
  if (res.status === 401) {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetchWithTimeout(`${BASE_URL}/api/auth/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refreshToken }),
        });

        if (refreshRes.ok) {
          const data = await refreshRes.json();
          await saveTokens(data.token, data.refreshToken);

          // Retry the original request with the new token
          const retryRes = await fetchWithTimeout(`${BASE_URL}/api${path}`, {
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
    if (onSessionExpired) onSessionExpired();
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
    const data = await request('/auth/user/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
    });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  register: async (name, email, password, phone, dateOfBirth) => {
    const data = await request('/auth/user/register', {
      method: 'POST',
      body:   JSON.stringify({ name, email, password, phone, date_of_birth: dateOfBirth }),
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
    const data = await request('/auth/user/google', { method: 'POST', body: JSON.stringify({ idToken }) });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  appleSignIn: async (identityToken, fullName, email) => {
    const data = await request('/auth/user/apple', {
      method: 'POST',
      body:   JSON.stringify({ identityToken, fullName, email }),
    });
    await saveTokens(data.token, data.refreshToken);
    return data;
  },

  acceptTerms: () => request('/auth/user/accept-terms', { method: 'POST' }),

  resendVerification: (email) =>
    request('/auth/user/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }),

  forgotPassword: (email) =>
    request('/auth/user/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (token, newPassword) =>
    request('/auth/user/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
};

// ── Products / Stores ─────────────────────────────────────────────────────
// Mounted as /api/inventory on the backend — "products" is this app's own
// naming for it, not the real route segment.
const products = {
  getAll:  (params = '') => request(`/inventory${params}`),
  getById: (id)          => request(`/inventory/${id}`),
};

// ── Orders ────────────────────────────────────────────────────────────────
const orders = {
  create:      (body)         => request('/orders', { method: 'POST', body: JSON.stringify(body) }),
  getAll:      ()              => request('/orders/my-orders'),
  getOrder:    (id)            => request(`/orders/${id}`),
  cancel:      (id, body)       => request(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify(body || {}) }),
  getCancellationPreview: (id)  => request(`/orders/${id}/cancellation-preview`),
  getPhotos:   (id)             => request(`/orders/${id}/photos`),
  return:      (id, body)       => request(`/orders/${id}/return`, { method: 'POST', body: JSON.stringify(body) }),
  selectDriver:(id, driverId)   => request(`/orders/${id}/select-driver`, { method: 'POST', body: JSON.stringify({ driverId }) }),
  rateDriver:  (id, rating, comment) => request(`/orders/${id}/rate-driver`, { method: 'POST', body: JSON.stringify({ rating, comment }) }),
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
  getCashOtp:    (orderId)         => request(`/payments/cash/otp/${orderId}`),
};

// ── Nearby drivers (for "Pick a Driver" checkout mode) ──────────────────────
const drivers = {
  getNearby:      (lat, lng) => request(`/drivers/nearby${lat && lng ? `?lat=${lat}&lng=${lng}` : ''}`),
  getAvailability: ()        => request('/drivers/availability'),
};

// ── User profile ──────────────────────────────────────────────────────────
const user = {
  getProfile:      ()      => request('/users/me'),
  updateProfile:   (body)  => request('/users/me', { method: 'PUT', body: JSON.stringify(body) }),
  registerPushToken: (pushToken) => request('/users/push-token', {
    method: 'POST',
    body:   JSON.stringify({ push_token: pushToken }),
  }),
  rateApp: (rating, comment) => request('/users/app-rating', {
    method: 'POST',
    body:   JSON.stringify({ rating, comment }),
  }),

  // NOTE: none of the four methods below have a real backend route today —
  // there is no addressRoutes.js and no address table wired into the API,
  // and there is no account-deletion endpoint anywhere in the backend (only
  // the path prefix was fixed here for consistency with the rest of this
  // file). AddressScreen and the "Delete Account" button will keep failing
  // until that backend work is done — that's a missing feature, not a
  // client routing bug, and out of scope for this fix pass.
  getAddresses:    ()          => request('/users/addresses'),
  addAddress:      (body)      => request('/users/addresses', { method: 'POST', body: JSON.stringify(body) }),
  updateAddress:   (id, body)  => request(`/users/addresses/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAddress:   (id)        => request(`/users/addresses/${id}`, { method: 'DELETE' }),
  deleteAccount:   ()          => request('/users/account', { method: 'DELETE' }),
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
// NOTE: no generic notifications list/read-state route exists on the
// backend either — same caveat as the user.* methods above.
const notifications = {
  getAll:      () => request('/notifications'),
  markRead:    (id) => request(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => request('/notifications/read-all', { method: 'POST' }),
};

// ── Feed ──────────────────────────────────────────────────────────────────
const feed = {
  getPosts:    (page = 1)          => request(`/feed?page=${page}`),
  likePost:    (postId)            => request(`/feed/${postId}/like`, { method: 'POST' }),
  getComments: (postId)            => request(`/feed/${postId}/comments`),
  addComment:  (postId, content)   => request(`/feed/${postId}/comments`, { method: 'POST', body: JSON.stringify({ content }) }),
  deletePost:  (postId)            => request(`/feed/${postId}`, { method: 'DELETE' }),
};

// ── Sizing / AI size match ─────────────────────────────────────────────────
const sizing = {
  getGuide:    ()       => request('/sizing/guide'),
  getProfile:  ()       => request('/sizing/profile'),
  saveProfile: (body)   => request('/sizing/profile', { method: 'POST', body: JSON.stringify(body) }),
};

// ── Returns / Store credit ──────────────────────────────────────────────────
const returns = {
  getCredits: () => request('/returns/credits'),
};

// ── Messages (chat with driver) ─────────────────────────────────────────────
const messages = {
  getMessages: (orderId)          => request(`/messages/${orderId}`),
  sendMessage: (orderId, content)  => request(`/messages/${orderId}`, { method: 'POST', body: JSON.stringify({ content }) }),
};

// ── SOS / safety ─────────────────────────────────────────────────────────
const sos = {
  trigger: (orderId, lat, lng) => request(`/sos/${orderId}/trigger`, { method: 'POST', body: JSON.stringify({ lat, lng }) }),
};

// ── Flash Premium ────────────────────────────────────────────────────────
const subscription = {
  getPremiumStatus:      ()               => request('/subscriptions/premium'),
  purchasePremiumWithCard: (cardId)       => request('/subscriptions/premium/purchase-with-card', {
    method: 'POST',
    body:   JSON.stringify({ cardId }),
  }),
  cancelPremium:         ()               => request('/subscriptions/premium/cancel', { method: 'POST' }),
};

export { BASE_URL, getToken, saveTokens, clearTokens };

export default {
  auth,
  products,
  orders,
  payments,
  drivers,
  user,
  trustedDrivers,
  notifications,
  feed,
  sizing,
  returns,
  messages,
  sos,
  subscription,
};
