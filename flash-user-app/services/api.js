import AsyncStorage from '@react-native-async-storage/async-storage';

// ← Change this to your computer's LAN IP when testing on device
export const BASE_URL = 'http://172.20.10.9:3000';

const getToken = async () => AsyncStorage.getItem('FLASH_TOKEN');

async function request(method, path, body = null, isPublic = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (!isPublic) {
    const token = await getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE_URL}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
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
  },
  orders: {
    create: (orderData) => request('POST', '/api/orders', orderData),
    getMyOrders: () => request('GET', '/api/orders/my-orders'),
    getOrder: (orderId) => request('GET', `/api/orders/${orderId}`),
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
