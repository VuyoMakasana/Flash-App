import AsyncStorage from '@react-native-async-storage/async-storage';

export const BASE_URL = 'http://100.66.42.15:3000'; // ← Change to your LAN IP

const getToken = async () => AsyncStorage.getItem('FLASH_DRIVER_TOKEN');

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
      const response = await fetch(`${BASE_URL}/api/drivers/documents/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      return data;
    },
  },
  status: {
    setOnline: (online) => request('POST', '/api/drivers/online', { online }),
    updateLocation: (lat, lng, orderId) =>
      request('POST', '/api/drivers/location', { lat, lng, orderId }),
  },
  orders: {
    getAvailable: () => request('GET', '/api/drivers/available-orders'),
    acceptOrder: (orderId) => request('POST', `/api/drivers/orders/${orderId}/accept`),
    updateStatus: (orderId, status) => request('PUT', `/api/orders/${orderId}/status`, { status }),
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
};

export default driverApi;
