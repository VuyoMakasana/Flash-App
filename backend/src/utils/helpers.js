const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { getRequired } = require("../config/env");

// ─── TOKEN GENERATION ────────────────────────────────────────────────────────
// Access tokens: 15 minutes. Short-lived so a stolen token expires quickly.
// Refresh tokens: 7 days. Stored in DB, revocable at any time.
const ACCESS_TOKEN_EXPIRY  = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";



const { v4: uuidv4 } = require('uuid');

const generateToken = (id, role, status = null) => {
  const jwtSecret = getRequired('JWT_SECRET', 'auth');

  const payload = {
    id,
    role,
    jti: uuidv4(),
  };

  if (status) {
    payload.status = status;
  }

  return jwt.sign(payload, jwtSecret, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};



const generateRefreshToken = () => {
  // 48 random bytes = 384 bits of entropy. Impossible to guess.
  return crypto.randomBytes(48).toString("hex");
};

// ─── COMMISSION MATH ─────────────────────────────────────────────────────────
// Flash earns minimum R10, driver earns 75% of delivery fee.
// This is called ONLY server-side. Frontend values are never trusted.
const computeCommission = (deliveryFee) => {
  const fee = parseFloat(deliveryFee) || 0;
  const flashCommission = Math.max(10, Math.round(fee * 0.25 * 100) / 100);
  const driverPayout    = Math.round((fee - flashCommission) * 100) / 100;
  return { flashCommission, driverPayout };
};

// ─── CURRENCY ────────────────────────────────────────────────────────────────
const formatCurrency = (amount) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(amount);

// ─── GEO MATH ────────────────────────────────────────────────────────────────
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const estimateDeliveryTime = (distanceKm) =>
  Math.max(1, Math.round((distanceKm / 25) * 60));

// ─── ORDER NUMBERS ───────────────────────────────────────────────────────────
const generateOrderNumber = () =>
  `FLASH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

// ─── UTILS ───────────────────────────────────────────────────────────────────
const sanitizePhoneNumber = (phone) => {
  if (!phone) return null;
  let c = phone.replace(/\D/g, "");
  if (c.startsWith("0")) c = "+27" + c.substring(1);
  return c;
};

const isValidEmail = (email) => /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/.test(email);

const maskData = (data, visibleChars = 4) => {
  if (!data) return null;
  if (data.length <= visibleChars) return "*".repeat(data.length);
  return "*".repeat(data.length - visibleChars) + data.slice(-visibleChars);
};

const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
const sleep     = (ms)  => new Promise((r) => setTimeout(r, ms));

const retry = async (fn, maxRetries = 3, delay = 1000) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (e) { lastError = e; if (i < maxRetries - 1) await sleep(delay * (i + 1)); }
  }
  throw lastError;
};

module.exports = {
  generateToken, generateRefreshToken,
  computeCommission,
  formatCurrency, calculateDistance, estimateDeliveryTime,
  generateOrderNumber, sanitizePhoneNumber, isValidEmail,
  maskData, deepClone, sleep, retry,
  ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY,
};
