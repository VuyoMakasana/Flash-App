'use strict';
/**
 * tests/unit/adminAccountLoginLockout.test.js
 *
 * Admin Platform Phase 2: adminLimiter (rateLimiter.js) is IP-keyed only —
 * an attacker distributing login attempts against ONE specific admin
 * account across many source IPs faces no additional friction once each
 * IP's own shared budget resets. adminAccountLoginLimiter adds a second,
 * account-keyed limiter (normalized email, skipSuccessfulRequests: true)
 * specifically on POST /api/admin/login — the same H-5 fix pattern already
 * shipped for /user/login and /driver/login on the security-fixes line,
 * built here since admin-platform was cut from main, not security-fixes.
 *
 * Builds a minimal standalone Express app around the real
 * adminAccountLoginLimiter middleware (not a hand-rolled stand-in) with a
 * controllable fake login handler, so these tests exercise the real
 * rate-limiting logic without needing the full app/DB stack.
 */

const express = require('express');
const request = require('supertest');
const { adminAccountLoginLimiter } = require('../../src/middleware/rateLimiter');

function makeApp(loginOutcome) {
  const app = express();
  app.use(express.json());
  app.post('/login', adminAccountLoginLimiter, (req, res) => {
    const outcome = typeof loginOutcome === 'function' ? loginOutcome(req) : loginOutcome;
    if (outcome === 'success') return res.status(200).json({ token: 'fake' });
    return res.status(401).json({ error: 'Invalid credentials' });
  });
  return app;
}

afterEach(() => {
  ['victim@example.com', 'other-admin@example.com', 'legit-admin@example.com', '__no_email_provided__']
    .forEach((key) => adminAccountLoginLimiter.resetKey(key));
});

describe('adminAccountLoginLimiter — per-account brute-force lockout (Admin Platform Phase 2)', () => {
  test('locks out after 5 failed attempts for the SAME account, regardless of source IP', async () => {
    const app = makeApp('fail');

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/login').send({ email: 'Victim@Example.com', password: 'wrong' });
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt, same account (different casing, confirming normalization).
    const blocked = await request(app).post('/login').send({ email: 'victim@example.com', password: 'wrong-again' });
    expect(blocked.statusCode).toBe(429);
  });

  test('a DIFFERENT admin account is never affected by another account being locked out', async () => {
    const app = makeApp('fail');

    for (let i = 0; i < 6; i++) {
      await request(app).post('/login').send({ email: 'victim@example.com', password: 'wrong' });
    }

    const otherAccount = await request(app).post('/login').send({ email: 'other-admin@example.com', password: 'wrong' });
    expect(otherAccount.statusCode).toBe(401); // rejected for bad credentials, NOT locked out
  });

  test('skipSuccessfulRequests: a legitimate admin who mistypes their password a couple of times is never locked out', async () => {
    let attempt = 0;
    const app = makeApp(() => {
      attempt++;
      return attempt <= 2 ? 'fail' : 'success';
    });

    const r1 = await request(app).post('/login').send({ email: 'legit-admin@example.com', password: 'typo1' });
    const r2 = await request(app).post('/login').send({ email: 'legit-admin@example.com', password: 'typo2' });
    const r3 = await request(app).post('/login').send({ email: 'legit-admin@example.com', password: 'correct' });

    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r3.statusCode).toBe(200);
  });

  test('a request with no email at all does not crash the limiter and is still handled', async () => {
    const app = makeApp('fail');
    const res = await request(app).post('/login').send({ password: 'whatever' });
    expect(res.statusCode).toBe(401); // reached the real handler, not a 500 from the limiter itself
  });
});
