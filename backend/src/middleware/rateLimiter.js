'use strict';

const rateLimit = require('express-rate-limit');

// General API rate limiter — 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) =>
    req.path === '/drivers/location' || req.path.startsWith('/webhooks'),
});

// Auth endpoints — 10 per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

// Admin login — 5 per 15 minutes (brute-force protection for privileged endpoint)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin login attempts, please try again later.' },
  skipSuccessfulRequests: false,
});

// Create order — 5 per minute
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders created. Please wait a moment.' },
});

// Driver location updates — 60 per minute (HTTP route)
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Location updates too frequent. Please reduce frequency.' },
});

// Cash OTP — 3 per minute
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait before trying again.' },
});

module.exports = {
  limiter,
  authLimiter,
  adminLimiter,
  orderLimiter,
  locationLimiter,
  otpLimiter,
};
