const rateLimit = require("express-rate-limit");

// General API rate limiter - 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  // Exclude high-frequency endpoints that have dedicated limiters/controls.
  skip: (req) =>
    req.path === "/drivers/location" || req.path.startsWith("/webhooks"),
});

// Auth endpoints rate limiter - stricter: 10 requests per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
});

// Create order rate limiter - 5 orders per minute
const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many orders created. Please wait a moment." },
});

// Driver location updates rate limiter - 60 per minute (one per second)
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Location updates too frequent. Please reduce frequency." },
});

// Cash OTP endpoints limiter - 3 OTP attempts per minute
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OTP requests. Please wait before trying again." },
});

module.exports = {
  limiter,
  authLimiter,
  orderLimiter,
  locationLimiter,
  otpLimiter,
};
