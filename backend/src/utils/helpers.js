const jwt = require("jsonwebtoken");

/**
 * Generate JWT token for user/driver
 * @param {string} id - User or driver ID
 * @param {string} role - Role (user, driver, admin)
 * @returns {string} JWT token
 */
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
};

/**
 * Format currency to ZAR
 * @param {number} amount - Amount in Rands
 * @returns {string} Formatted currency
 */
const formatCurrency = (amount) => {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(amount);
};

/**
 * Calculate distance between two coordinates (Haversine formula)
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @returns {number|null} Distance in kilometers
 */
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;

  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

/**
 * Estimate delivery time based on distance
 * @param {number} distanceKm - Distance in kilometers
 * @returns {number} Estimated minutes
 */
const estimateDeliveryTime = (distanceKm) => {
  const avgSpeedKmh = 25; // Average speed in city
  return Math.max(1, Math.round((distanceKm / avgSpeedKmh) * 60));
};

/**
 * Generate random order number
 * @returns {string} Order number
 */
const generateOrderNumber = () => {
  return `FLASH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
};

/**
 * Calculate driver payout from delivery fee
 * @param {number} deliveryFee - Delivery fee charged to customer
 * @returns {number} Driver payout
 */
const calculateDriverPayout = (deliveryFee) => {
  return Math.round((deliveryFee * 0.75 + 15) * 100) / 100;
};

/**
 * Paginate results
 * @param {Array} data - Array of results
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @returns {Object} Paginated results
 */
const paginate = (data, page, limit) => {
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  const results = data.slice(startIndex, endIndex);

  return {
    data: results,
    page,
    limit,
    total: data.length,
    totalPages: Math.ceil(data.length / limit),
    hasNext: endIndex < data.length,
    hasPrev: startIndex > 0,
  };
};

/**
 * Sanitize phone number
 * @param {string} phone - Raw phone number
 * @returns {string} Sanitized phone number
 */
const sanitizePhoneNumber = (phone) => {
  if (!phone) return null;
  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, "");
  // If starts with 0, replace with +27
  if (cleaned.startsWith("0")) {
    cleaned = "+27" + cleaned.substring(1);
  }
  return cleaned;
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} Is valid email
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Mask sensitive data
 * @param {string} data - Data to mask
 * @param {number} visibleChars - Number of visible characters
 * @returns {string} Masked data
 */
const maskData = (data, visibleChars = 4) => {
  if (!data) return null;
  if (data.length <= visibleChars) return "*".repeat(data.length);
  const visible = data.slice(-visibleChars);
  const masked = "*".repeat(data.length - visibleChars);
  return masked + visible;
};

/**
 * Deep clone object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
const deepClone = (obj) => {
  return JSON.parse(JSON.stringify(obj));
};

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after sleep
 */
const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Retry async function
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise} Result of function
 */
const retry = async (fn, maxRetries = 3, delay = 1000) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await sleep(delay);
      }
    }
  }
  throw lastError;
};

module.exports = {
  generateToken,
  formatCurrency,
  calculateDistance,
  estimateDeliveryTime,
  generateOrderNumber,
  calculateDriverPayout,
  paginate,
  sanitizePhoneNumber,
  isValidEmail,
  maskData,
  deepClone,
  sleep,
  retry,
};
