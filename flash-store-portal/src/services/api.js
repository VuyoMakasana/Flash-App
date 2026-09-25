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
    // Store onboarding — express-validator replies with
    // { errors: [{ path, msg, ... }] } rather than a single { error }, and
    // this layer previously dropped that array entirely, leaving pages no
    // way to put a message next to the field that caused it. Normalized to
    // { fieldName: message } here (first message per field wins, matching
    // how the backend orders its own validation chain) so pages never have
    // to know express-validator's wire shape. Additive: `message` and
    // `status` behave exactly as before for every existing caller.
    if (Array.isArray(body.errors)) {
      error.fieldErrors = body.errors.reduce((acc, item) => {
        const field = item?.path || item?.param;
        if (field && !acc[field]) acc[field] = item.msg || 'Invalid value';
        return acc;
      }, {});
    }
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
  getAnalytics: (days) => request(`/api/store-analytics${days ? `?days=${encodeURIComponent(days)}` : ''}`),
  // Admin Platform Phase 3 — own independent forgot/change-password flow,
  // matching the /api/store-auth/* contract exactly (storeAuthRoutes.js).
  changePassword: (currentPassword, newPassword) =>
    request('/api/store-auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  forgotPassword: (email) =>
    request('/api/store-auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token, newPassword) =>
    request('/api/store-auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
  // Phase 3 — public store-onboarding application (no auth; the applicant has
  // no Flash account yet by definition). Field names are the snake_case ones
  // storeOnboardingRoutes.js validates, deliberately passed straight through
  // rather than camelCased here, so a validation error's `path` matches the
  // form field it belongs to without a translation layer in between.
  applyForStore: ({ store_name, owner_name, owner_email, owner_phone, address }) =>
    request('/api/store-onboarding/apply', {
      method: 'POST',
      body: JSON.stringify({ store_name, owner_name, owner_email, owner_phone, address }),
    }),
};

export { getToken };
