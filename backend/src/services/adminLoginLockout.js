'use strict';

// Admin hardening A1b (#87): per-account lockout for admin login.
//
// 5 failed attempts for one account within 15 minutes lock that account for
// the rest of the window, whichever IPs they came from (the per-IP limiters
// can't stop an attacker spread over many IPs). Shared by BOTH admin logins
// (AdminJS /admin-panel/login and POST /api/admin/login), so attempts on one
// endpoint count against the other. A successful login resets the count.
//
// Built on express-rate-limit's own MemoryStore (the existing library; no
// new dependency). It is in memory, like every limiter here today: one
// backend instance; a restart clears it. An earlier per-account limiter in
// rateLimiter.js was never wired to any route, and couldn't be for AdminJS:
// its login body is parsed inside AdminJS's own router, after any middleware
// we can put in front of it. It was deleted (FI-089, #89).

const { MemoryStore } = require('express-rate-limit');

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const keyFor = (email) => `admin-login:${String(email ?? '').trim().toLowerCase()}`;

function createAdminLoginLockout({ store = null, now = () => Date.now() } = {}) {
  const s = store || new MemoryStore();
  if (typeof s.init === 'function') s.init({ windowMs: WINDOW_MS });

  async function isLocked(email) {
    const entry = await s.get(keyFor(email));
    if (!entry || entry.totalHits < MAX_FAILURES) return false;
    const resetAt = entry.resetTime instanceof Date ? entry.resetTime.getTime() : Number(entry.resetTime);
    return !Number.isFinite(resetAt) || resetAt > now();
  }

  async function recordFailure(email) {
    await s.increment(keyFor(email));
  }

  async function recordSuccess(email) {
    await s.resetKey(keyFor(email));
  }

  return { isLocked, recordFailure, recordSuccess };
}

// The process-wide instance both logins use.
const adminLoginLockout = createAdminLoginLockout();

module.exports = { createAdminLoginLockout, adminLoginLockout, MAX_FAILURES, WINDOW_MS };
