'use strict';

// L0.4 (#82): health checks.
//
// GET /health      Liveness, for the external keep-awake pinger and Render's
//                  health check. 200 {"status":"ok"}, no-store, and nothing
//                  else: no database or Redis work, no version string, no
//                  dependency status. A database blip therefore never makes
//                  Render restart a working server (startup takes ~1 minute).
//
// GET /health/db   Deep check, protected. Needs the X-Health-Token header,
//                  compared in constant time with HEALTH_CHECK_TOKEN. A wrong
//                  or missing token, or no HEALTH_CHECK_TOKEN at all, gets the
//                  app's normal 404, so the route is indistinguishable from a
//                  missing one. The result is cached for 15 s (concurrent
//                  requests share one query), so a flood costs at most one
//                  database query per 15 s. Returns only
//                  {"database":"ok"|"error","latencyMs":N}; 503 on error.
//
// This router is mounted BEFORE the request logger (server.js), so neither
// route is logged and the token header never reaches a log line. It answers
// every request itself and never calls next(), for the same reason.

const crypto = require('crypto');
const express = require('express');
const { notFound } = require('../middleware/errorHandler');

const CACHE_MS = 15000;

// Constant-time comparison that also hides the length: both sides are hashed
// to 32 bytes first, so timingSafeEqual never sees different lengths.
function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function createHealthRouter({ pool, now = () => Date.now(), getToken = () => process.env.HEALTH_CHECK_TOKEN } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createHealthRouter needs a pool');
  const router = express.Router();
  let cached = null;   // { at, status, body }
  let inflight = null; // Promise of the running check

  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok' });
  });

  async function runCheck() {
    const started = now();
    let ok = true;
    try {
      await pool.query('SELECT 1');
    } catch (_err) {
      ok = false; // never surface the error text
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    cached = { at: now(), status: ok ? 200 : 503, body: { database: ok ? 'ok' : 'error', latencyMs } };
    return cached;
  }

  router.get('/health/db', async (req, res) => {
    if (!tokensMatch(req.get('x-health-token'), getToken())) return notFound(req, res);
    res.set('Cache-Control', 'no-store');
    let result = cached && now() - cached.at < CACHE_MS ? cached : null;
    if (!result) {
      if (!inflight) inflight = runCheck().finally(() => { inflight = null; });
      result = await inflight;
    }
    res.status(result.status).json(result.body);
  });

  return router;
}

module.exports = { createHealthRouter, tokensMatch, CACHE_MS };
