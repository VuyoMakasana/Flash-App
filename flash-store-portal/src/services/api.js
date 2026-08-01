// All backend calls centralized here — matching the existing mobile apps'
// own services/api.js convention (CLAUDE.md), so changing the API base URL
// or adding an endpoint wrapper never means touching a page component.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

function getToken() {
  return localStorage.getItem('flash_store_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = res.status;
    throw error;
  }
  return body;
}

export const storeApi = {
  login: (email, password) =>
    request('/api/store-auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request('/api/store-auth/logout', { method: 'POST' }),
  getOrders: (status) => request(`/api/store-orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getOrder: (orderId) => request(`/api/store-orders/${orderId}`),
  acceptOrder: (orderId) => request(`/api/store-orders/${orderId}/accept`, { method: 'POST' }),
  rejectOrder: (orderId) => request(`/api/store-orders/${orderId}/reject`, { method: 'POST' }),
  markReady: (orderId) => request(`/api/store-orders/${orderId}/mark-ready`, { method: 'POST' }),
  getProducts: () => request('/api/store-inventory'),
  getProduct: (productId) => request(`/api/store-inventory/${productId}`),
  addProduct: (data) => request('/api/store-inventory', { method: 'POST', body: JSON.stringify(data) }),
  updateStock: (productId, stockBySize) =>
    request(`/api/store-inventory/${productId}/stock`, { method: 'PATCH', body: JSON.stringify({ stock_by_size: stockBySize }) }),
  deactivateProduct: (productId) => request(`/api/store-inventory/${productId}/deactivate`, { method: 'PATCH' }),
  getStaff: () => request('/api/store-staff'),
  createStaff: (data) => request('/api/store-staff', { method: 'POST', body: JSON.stringify(data) }),
  deactivateStaff: (staffId) => request(`/api/store-staff/${staffId}/deactivate`, { method: 'PATCH' }),
};

export { getToken };
