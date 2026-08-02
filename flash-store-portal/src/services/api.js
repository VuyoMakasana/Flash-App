// All backend calls centralized here — matching the existing mobile apps'
// own services/api.js convention (CLAUDE.md), so changing the API base URL
// or adding an endpoint wrapper never means touching a page component.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

function getToken() {
  return localStorage.getItem('flash_store_token');
}

async function request(path, options = {}) {
  const token = getToken();
  // A FormData body (real image uploads) must never get a manual
  // Content-Type — fetch sets its own multipart boundary automatically,
  // and overriding it here would break the browser's own boundary parsing.
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
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
  deleteAccount: () => request('/api/store-auth/account', { method: 'DELETE' }),
  getOrders: (status) => request(`/api/store-orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getOrder: (orderId) => request(`/api/store-orders/${orderId}`),
  acceptOrder: (orderId) => request(`/api/store-orders/${orderId}/accept`, { method: 'POST' }),
  rejectOrder: (orderId) => request(`/api/store-orders/${orderId}/reject`, { method: 'POST' }),
  markReady: (orderId) => request(`/api/store-orders/${orderId}/mark-ready`, { method: 'POST' }),
  getProducts: () => request('/api/store-inventory'),
  getProduct: (productId) => request(`/api/store-inventory/${productId}`),
  // formData is a real FormData instance built by the caller (AddProductForm)
  // — always used now, even without an image, so the backend's multer
  // middleware sees one consistent content-type for this route.
  addProduct: (formData) => request('/api/store-inventory', { method: 'POST', body: formData }),
  updateStock: (productId, stockBySize) =>
    request(`/api/store-inventory/${productId}/stock`, { method: 'PATCH', body: JSON.stringify({ stock_by_size: stockBySize }) }),
  updateProductImage: (productId, formData) =>
    request(`/api/store-inventory/${productId}/image`, { method: 'PATCH', body: formData }),
  deactivateProduct: (productId) => request(`/api/store-inventory/${productId}/deactivate`, { method: 'PATCH' }),
  getStaff: () => request('/api/store-staff'),
  createStaff: (data) => request('/api/store-staff', { method: 'POST', body: JSON.stringify(data) }),
  deactivateStaff: (staffId) => request(`/api/store-staff/${staffId}/deactivate`, { method: 'PATCH' }),
};

export { getToken };
