import AsyncStorage from '@react-native-async-storage/async-storage';

// REQUEST_TIMEOUT_MS: abort any API call that takes longer than 15 seconds
// WHY: Without this constant the request function throws a ReferenceError
// on every single API call, crashing the entire app immediately at startup
const REQUEST_TIMEOUT_MS = 15000;

// FIX 1: Changed hardcoded LAN IP to production server URL — the old IP was a local Tailscale address that fails for every user outside the developer's network
const DEFAULT_BASE_URL = 'https://flash-app-hplc.onrender.com';
export const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_BASE_URL;

const getToken = async () => AsyncStorage.getItem('FLASH_TOKEN');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (_) {
    return { error: text };
  }
};

const shouldRetry = (method, responseStatus, errName) => {
  if (method !== 'GET') return false;
  if (responseStatus >= 500 || responseStatus === 429) return true;
  if (errName === 'AbortError' || errName === 'TypeError') return true;
  return false;
};

async function request(method, path, body = null, isPublic = false) {
  const maxAttempts = method === 'GET' ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (!isPublic) {
        const token = await getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      }

      const options = { method, headers, signal: controller.signal };
      if (body) options.body = JSON.stringify(body);

      const response = await fetch(`${BASE_URL}${path}`, options);
      const data = await parseResponse(response);

      if (!response.ok) {
        // 401 INTERCEPTOR: Token expired or invalid — clear storage and force re-login
        // WHY: Without this, users with expired tokens see confusing error messages
        // on whatever screen they're on and have no way to recover except reinstalling
        if (response.status === 401) {
          try {
            await AsyncStorage.multiRemove(['FLASH_TOKEN', 'FLASH_USER']);
          } catch (_) {}
          throw new Error('SESSION_EXPIRED');
        }
        if (attempt < maxAttempts && shouldRetry(method, response.status, '')) {
          await sleep(attempt * 250);
          continue;
        }
        throw new Error(data.error || data.message || `Request failed (${response.status})`);
      }

      return data;
    } catch (err) {
      if (attempt < maxAttempts && shouldRetry(method, 0, err.name)) {
        await sleep(attempt * 250);
        continue;
      }
      if (err.name === 'AbortError') {
        throw new Error('Request timed out. Please try again.');
      }
      throw new Error(err.message || 'Network request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Request failed');
}

export const api = {
  auth: {
    register: (name, email, password, phone) =>
      request('POST', '/api/auth/user/register', { name, email, password, phone }, true),
    login: (email, password) =>
      request('POST', '/api/auth/user/login', { email, password }, true),
    acceptTerms: () => request('POST', '/api/auth/user/accept-terms'),
  },
  user: {
    getProfile: () => request('GET', '/api/users/me'),
    updateProfile: (data) => request('PUT', '/api/users/me', data),
    registerPushToken: (push_token) => request('POST', '/api/users/push-token', { push_token }),
  },
  orders: {
    create: (orderData) => request('POST', '/api/orders', orderData),
    getMyOrders: () => request('GET', '/api/orders/my-orders'),
    getOrder: (orderId) => request('GET', `/api/orders/${orderId}`),
    selectDriver: (orderId, driverId) =>
      request('POST', `/api/orders/${orderId}/select-driver`, { driverId }),
  },
  payments: {
    // Initialize a Paystack payment — returns { authorizationUrl, reference }
    initialize: (orderId) =>
      request('POST', '/api/payments/initialize', { orderId }),
    // Verify after Paystack redirects back
    verify: (reference) =>
      request('GET', `/api/payments/verify/${reference}`),
    cashOnDelivery: (orderId) =>
      request('POST', '/api/payments/cash-on-delivery', { orderId }),
    initPayflex: (orderId) =>
      request('POST', '/api/payments/payflex/initiate', { orderId }),
    getStatus: (orderId) =>
      request('GET', `/api/payments/status/${orderId}`),
    getSavedCards: () =>
      request('GET', '/api/payments/cards'),
    chargeSavedCard: (orderId, cardId) =>
      request('POST', '/api/payments/charge-saved-card', { orderId, cardId }),
    removeCard: (cardId) =>
      request('DELETE', `/api/payments/cards/${cardId}`),
    setDefaultCard: (cardId) =>
      request('PATCH', `/api/payments/cards/${cardId}/default`),
  },
  returns: {
    request: (orderId, reason) =>
      request('POST', `/api/returns/${orderId}`, { reason }),
    getMyReturns: () => request('GET', '/api/returns/my'),
    getCredits: () => request('GET', '/api/returns/credits'),
  },
  premium: {
    getStatus: () => request('GET', '/api/subscriptions/premium'),
    purchase: () => request('POST', '/api/subscriptions/premium/purchase'),
  },
  sizing: {
    getGuide: () => request('GET', '/api/sizing/guide', null, true),
    getProfile: () => request('GET', '/api/sizing/profile'),
    saveProfile: (data) => request('POST', '/api/sizing/profile', data),
    getRecommendation: (storeId, category) =>
      request('GET', `/api/sizing/recommend/${storeId}/${category}`),
  },
  feed: {
    getPosts: (page = 1) => request('GET', `/api/feed?page=${page}`),
    createPost: (data) => request('POST', '/api/feed', data),
    likePost: (postId) => request('POST', `/api/feed/${postId}/like`),
    getComments: (postId) => request('GET', `/api/feed/${postId}/comments`),
    addComment: (postId, content) =>
      request('POST', `/api/feed/${postId}/comments`, { content }),
    deletePost: (postId) => request('DELETE', `/api/feed/${postId}`),
  },
  boost: {
    getActive: () => request('GET', '/api/boost/active'),
    getPromotions: () => request('GET', '/api/boost/promotions'),
  },
  trends: {
    recordBrowse: (data) => request('POST', '/api/trends/browse', data),
  },
  tracking: {
    getDriverLocation: (orderId) =>
      request('GET', `/api/tracking/order/${orderId}`),
  },
  inventory: {
    getProducts: (category) =>
      request('GET', `/api/inventory${category ? `?category=${category}` : ''}`),
    getProduct: (productId) =>
      request('GET', `/api/inventory/${productId}`),
  },
  // ── v3 NEW ─────────────────────────────────────────────────────────────────
  messages: {
    getMessages: (orderId) => request('GET', `/api/messages/${orderId}`),
    sendMessage: (orderId, content) =>
      request('POST', `/api/messages/${orderId}`, { content }),
    getUnread: (orderId) => request('GET', `/api/messages/${orderId}/unread`),
  },
  drivers: {
    getNearby: (lat, lng) =>
      request('GET', `/api/drivers/nearby${lat && lng ? `?lat=${lat}&lng=${lng}` : ''}`, null, true),
  },
  trustedDrivers: {
    getMyTrusted: () => request('GET', '/api/trusted-drivers'),
    getPending: () => request('GET', '/api/trusted-drivers/pending'),
    sendRequest: (driverId) => request('POST', `/api/trusted-drivers/${driverId}/request`),
    remove: (driverId) => request('DELETE', `/api/trusted-drivers/${driverId}`),
    checkStatus: (driverId) => request('GET', `/api/trusted-drivers/${driverId}/status`),
  },
};

export default api;
