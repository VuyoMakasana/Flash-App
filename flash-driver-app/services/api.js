import AsyncStorage from '@react-native-async-storage/async-storage';

// FIX 1: Changed hardcoded LAN IP to production server URL — the old IP was a local Tailscale address that fails for every user outside the developer's network
const DEFAULT_BASE_URL = 'https://your-production-server.com';
export const BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  process.env.REACT_NATIVE_API_BASE_URL ||
  DEFAULT_BASE_URL;
const REQUEST_TIMEOUT_MS = 15000;

const getToken = async () => AsyncStorage.getItem('FLASH_DRIVER_TOKEN');

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

export const driverApi = {
  auth: {
    register: (data) => request('POST', '/api/auth/driver/register', data, true),
    login: (email, password) => request('POST', '/api/auth/driver/login', { email, password }, true),
  },
  profile: {
    getMe: () => request('GET', '/api/drivers/me'),
    update: (data) => request('PUT', '/api/drivers/me', data),
    uploadDocument: async (documentType, fileUri, fileName, mimeType) => {
      const token = await getToken();
      const formData = new FormData();
      formData.append('document_type', documentType);
      formData.append('document', { uri: fileUri, name: fileName, type: mimeType });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${BASE_URL}/api/drivers/documents/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
          signal: controller.signal,
        });

        const data = await parseResponse(response);
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        return data;
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('Upload timed out. Please try again.');
        }
        throw new Error(err.message || 'Upload failed');
      } finally {
        clearTimeout(timeout);
      }
    },
  },
  status: {
    setOnline: (online) => request('POST', '/api/drivers/online', { online }),
    updateLocation: (lat, lng, orderId) =>
      request('POST', '/api/drivers/location', { lat, lng, orderId }),
  },
  orders: {
    getAvailable: () => request('GET', '/api/drivers/available-orders'),
    getActive: () => request('GET', '/api/drivers/active-order'),
    acceptOrder: (orderId) => request('POST', `/api/drivers/orders/${orderId}/accept`),
    updateStatus: (orderId, status) => request('PUT', `/api/orders/${orderId}/status`, { status }),
    // Cash OTP flow: driver sends OTP to user then confirms payment with the code
    sendCashOtp: (orderId) => request('POST', '/api/payments/cash/send-otp', { orderId }),
    confirmCashPayment: (orderId, otp) => request('POST', '/api/payments/cash/confirm', { orderId, otp }),
  },
  earnings: {
    get: () => request('GET', '/api/drivers/earnings'),
  },
  subscription: {
    get: () => request('GET', '/api/subscriptions/driver'),
    purchase: (planId) => request('POST', '/api/subscriptions/driver/purchase', { planId }),
    incrementDelivery: () => request('POST', '/api/subscriptions/driver/increment'),
  },
  fleet: {
    getClusters: () => request('GET', '/api/fleet/clusters'),
  },
  returns: {
    pickupReturn: (returnId) => request('POST', `/api/returns/${returnId}/pickup`),
  },
  // ── v3 NEW ─────────────────────────────────────────────────────────────────
  messages: {
    getMessages: (orderId) => request('GET', `/api/messages/${orderId}`),
    sendMessage: (orderId, content) =>
      request('POST', `/api/messages/${orderId}`, { content }),
    getUnread: (orderId) => request('GET', `/api/messages/${orderId}/unread`),
  },
  trustedDrivers: {
    getRequests: () => request('GET', '/api/trusted-drivers/requests'),
    respond: (requestId, action) =>
      request('PATCH', `/api/trusted-drivers/${requestId}/respond`, { action }),
    removeSelf: (userId) => request('DELETE', `/api/trusted-drivers/remove-self/${userId}`),
  },
  // ── Bank account setup for payouts ─────────────────────────────────────────
  bank: {
    getSupportedBanks: () => request('GET', '/api/drivers/bank/supported-banks'),
    verifyAccount: (account_number, bank_code) =>
      request('POST', '/api/drivers/bank/verify', { account_number, bank_code }),
    saveAccount: (account_number, bank_code, account_name) =>
      request('POST', '/api/drivers/bank/save', { account_number, bank_code, account_name }),
    getAccount: () => request('GET', '/api/drivers/bank/account'),
  },
  // ── Push notification token registration ───────────────────────────────────
  notifications: {
    registerToken: (push_token) =>
      request('POST', '/api/drivers/push-token', { push_token }),
  },
};

export default driverApi;
