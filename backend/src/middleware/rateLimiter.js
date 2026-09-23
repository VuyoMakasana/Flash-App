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

// ADMIN PLATFORM PHASE 2: per-account brute-force lockout for admin login,
// same pattern as accountLoginLimiter below (security-fixes' H-5 fix,
// reused here for the admin surface since it's not on this branch's base —
// see the task's own instruction to build the equivalent if missing).
// adminLimiter above is IP-keyed; this is keyed by the normalized email
// itself, so an attacker spraying one admin account's password from many
// IPs (defeating the IP-keyed limiter) still hits a real per-account cap.
// skipSuccessfulRequests: true — a legitimate admin logging in repeatedly
// across a workday never burns down this budget, only real failed guesses
// do.
function normalizeAdminEmailKey(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  return email || '__no_email_provided__';
}

const adminAccountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts for this account. Please try again later.' },
  skipSuccessfulRequests: true,
  keyGenerator: normalizeAdminEmailKey,
  ...storeOption,
});

// ADMIN PLATFORM PHASE 2 — forgot-password request, admin surface. Keyed by
// the same normalized-email pattern as adminAccountLoginLimiter above (a
// forgot-password request always carries an email in its body, same shape),
// so a burst of reset requests against one specific account is capped
// per-account, not just per-IP — same reasoning as the user/driver
// forgot-password flow's shared authLimiter, but this is a privileged
// surface so the cap is tighter and per-account rather than relying on the
// generic router-wide limiter alone.
const adminPasswordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' },
  keyGenerator: normalizeAdminEmailKey,
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

// Payment initiation — 10 per 15 minutes. Previously only the general
// 100/15min limiter covered /payments/initialize and /charge-saved-card —
// the two endpoints most exposed to card-testing/fraud attempts (rapidly
// trying many saved cards, or hammering Paystack initialization).
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait before trying again.' },
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

// Order chat — 20 per minute. Previously covered only by the blanket
// 100/15min `/api/` limiter, shared with every other endpoint a user calls
// -- a chat flood could burn a user's entire API budget for the whole app,
// while still being a fairly loose ceiling for spam specifically. 20/min
// is generous for real back-and-forth conversation (one every 3s sustained)
// but stops a scripted flood.
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent. Please slow down.' },
  ...storeOption,
});

// Chat report/block — 5 per hour. §2.7 audit: these should be rare, real
// events, not something a legitimate user needs to do repeatedly in a short
// window -- also raises the cost of using the report queue itself as a
// harassment tool against a specific driver/customer.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reports/blocks submitted. Please wait before trying again.' },
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

// ADMIN PLATFORM PHASE 3 — Store Admin Portal login, its own dedicated
// counter (FLASH_STORE_ADMIN_DESIGN.md §5.5): "a credential-stuffing
// attempt against one store's login shouldn't be able to exhaust the
// rate-limit budget for a different store's legitimate login attempts, or
// for the internal admin panel's." Same IP-keyed shape as adminLimiter.
const storeAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: false,
  ...storeOption,
});

function normalizeStoreEmailKey(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  return email || '__no_email_provided__';
}

// Per-account brute-force lockout, same reasoning as adminAccountLoginLimiter
// above — an attacker spreading guesses against one store account across
// many IPs still hits a real per-account cap.
const storeAccountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts for this account. Please try again later.' },
  skipSuccessfulRequests: true,
  keyGenerator: normalizeStoreEmailKey,
  ...storeOption,
});

const storePasswordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' },
  keyGenerator: normalizeStoreEmailKey,
  ...storeOption,
});

// ADMIN PLATFORM PHASE 3 — write-endpoint rate limiting for the Store Admin
// Portal (CLAUDE.md's own scale rule: "rate limiting on every write
// endpoint especially order-related"). IP-keyed (a store account is a real
// staff member, not a customer — the realistic abuse case is a compromised
// or malicious session hammering writes, not casual overuse) at a level
// generous enough for real, busy order-acceptance/inventory-update traffic
// but well below what a scripted flood needs.
const storeWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  ...storeOption,
});

module.exports = {
  limiter,
  authLimiter,
  adminLimiter,
  adminAccountLoginLimiter,
  adminPasswordResetLimiter,
  storeAuthLimiter,
  storeAccountLoginLimiter,
  storePasswordResetLimiter,
  storeWriteLimiter,
  orderLimiter,
  locationLimiter,
  otpLimiter,
  trustRequestLimiter,
  paymentLimiter,
  messageLimiter,
  reportLimiter,
};
