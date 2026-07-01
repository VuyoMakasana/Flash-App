'use strict';

/**
 * rateLimiter.js — Flash API rate limiting
 *
 * HIGH-1 FIX: When REDIS_URL is set, all rate-limit counters are stored in
 * Redis so multiple backend instances share a single counter per client.
 * Without this, each instance has its own in-memory counter and an attacker
 * can bypass limits by hitting N instances N times.
 *
 * Falls back to in-memory store (default express-rate-limit behaviour) when
 * REDIS_URL is not configured, which is fine for single-instance development.
 */

const rateLimit = require('express-rate-limit');

let redisStore = null;

if (process.env.REDIS_URL && process.env.REDIS_URL !== 'disabled') {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const { createClient } = require('redis');

    const redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.connect().catch((err) => {
      console.error('[RateLimiter] Redis connection error — falling back to memory store:', err.message);
    });

    redisStore = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
    });

    console.log('[RateLimiter] Using Redis store for distributed rate limiting');
  } catch (err) {
    console.warn('[RateLimiter] rate-limit-redis not available — using memory store:', err.message);
  }
}

const storeOption = redisStore ? { store: redisStore } : {};

// General API rate limiter — 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) =>
    req.path === '/drivers/location' || req.path.startsWith('/webhooks'),
  ...storeOption,
});

// Auth endpoints — 10 per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
  ...storeOption,
});

// Admin login — 5 per 15 minutes (brute-force protection for privileged endpoint)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin login attempts, please try again later.' },
  skipSuccessfulRequests: false,
  ...storeOption,
});

// Create order — 5 per minute
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders created. Please wait a moment.' },
  ...storeOption,
});

// Driver location updates — 60 per minute (HTTP route)
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Location updates too frequent. Please reduce frequency.' },
  ...storeOption,
});

// Cash OTP — 3 per minute
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait before trying again.' },
  ...storeOption,
});

// Trusted driver requests — 3 per hour (HIGH-2)
const trustRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many trusted driver requests. Please wait before trying again.' },
  ...storeOption,
});

module.exports = {
  limiter,
  authLimiter,
  adminLimiter,
  orderLimiter,
  locationLimiter,
  otpLimiter,
  trustRequestLimiter,
};
