'use strict';
/**
 * tests/unit/storeAccountLoginLockout.test.js
 *
 * Admin Platform Phase 3/4 — brute-force/enumeration testing on the new
 * store-auth login endpoint, same H-5 per-account lockout pattern already
 * verified for /api/user/login, /api/driver/login, and /api/admin/login.
 * Mirrors adminAccountLoginLockout.test.js exactly.
 */

const express = require('express');
const request = require('supertest');
const { storeAccountLoginLimiter } = require('../../src/middleware/rateLimiter');

function makeApp(loginOutcome) {
  const app = express();
  app.use(express.json());
  app.post('/login', storeAccountLoginLimiter, (req, res) => {
    const outcome = typeof loginOutcome === 'function' ? loginOutcome(req) : loginOutcome;
    if (outcome === 'success') return res.status(200).json({ token: 'fake' });
    return res.status(401).json({ error: 'Invalid credentials' });
  });
  return app;
}

afterEach(() => {
  ['victim@example.com', 'other-store@example.com', 'legit-store@example.com', '__no_email_provided__']
    .forEach((key) => storeAccountLoginLimiter.resetKey(key));
});

describe('storeAccountLoginLimiter — per-account brute-force lockout (Admin Platform Phase 3)', () => {
  test('locks out after 5 failed attempts for the SAME account, regardless of source IP', async () => {
    const app = makeApp('fail');
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/login').send({ email: 'Victim@Example.com', password: 'wrong' });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await request(app).post('/login').send({ email: 'victim@example.com', password: 'wrong-again' });
    expect(blocked.statusCode).toBe(429);
  });

  test('a DIFFERENT store account is never affected by another account being locked out', async () => {
    const app = makeApp('fail');
    for (let i = 0; i < 6; i++) {
      await request(app).post('/login').send({ email: 'victim@example.com', password: 'wrong' });
    }
    const otherAccount = await request(app).post('/login').send({ email: 'other-store@example.com', password: 'wrong' });
    expect(otherAccount.statusCode).toBe(401);
  });

  test('skipSuccessfulRequests: a legitimate store user who mistypes their password is never locked out', async () => {
    let attempt = 0;
    const app = makeApp(() => {
      attempt++;
      return attempt <= 2 ? 'fail' : 'success';
    });
    await request(app).post('/login').send({ email: 'legit-store@example.com', password: 'typo1' });
    await request(app).post('/login').send({ email: 'legit-store@example.com', password: 'typo2' });
    const r3 = await request(app).post('/login').send({ email: 'legit-store@example.com', password: 'correct' });
    expect(r3.statusCode).toBe(200);
  });
});
