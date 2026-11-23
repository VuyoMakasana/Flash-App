'use strict';

// FI-087 (#89): authLimiter (10 per 15 minutes) must apply exactly ONCE to
// each /api/auth/* request. It was mounted twice (server.js and
// authRoutes.js), so every request used 2 and a customer got 5 attempts.
//
// FI-089 (#89): the unused adminAccountLoginLimiter is deleted; the
// per-account admin lockout is services/adminLoginLockout.js.

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(), on: jest.fn(), end: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const AUTH_MAX = 10;

describe('FI-087: the auth limiter applies exactly once per /api/auth request', () => {
  let app;
  const savedRender = process.env.RENDER;
  beforeAll(() => {
    process.env.RENDER = 'true'; // production client-IP handling (CF-Connecting-IP)
    app = require('../../src/server').createApp().app;
  });
  afterAll(() => { if (savedRender === undefined) delete process.env.RENDER; else process.env.RENDER = savedRender; });

  const attempt = (ip, path = '/api/auth/user/login') =>
    request(app).post(path).set('CF-Connecting-IP', ip).send({ email: 'customer@example.com', password: 'wrong-password' });

  test(`a customer gets exactly ${AUTH_MAX} attempts per 15 minutes; the ${AUTH_MAX + 1}th is refused`, async () => {
    const ip = '198.51.100.71';
    const statuses = [];
    const remaining = [];
    for (let i = 0; i < AUTH_MAX; i++) {
      const r = await attempt(ip);
      statuses.push(r.status);
      remaining.push(Number(r.headers['ratelimit-remaining']));
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);
    expect(remaining).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]); // exactly 1 per request
    const blocked = await attempt(ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many attempts, please try again later.' });
  });

  test('different /api/auth routes share the one counter, still 1 per request', async () => {
    const ip = '198.51.100.72';
    const a = await attempt(ip, '/api/auth/user/login');
    const b = await attempt(ip, '/api/auth/user/register');
    expect(Number(b.headers['ratelimit-remaining'])).toBe(Number(a.headers['ratelimit-remaining']) - 1);
  });

  test('another customer is unaffected', async () => {
    for (let i = 0; i < AUTH_MAX + 1; i++) await attempt('198.51.100.73');
    const other = await attempt('198.51.100.74');
    expect(other.status).not.toBe(429);
    expect(Number(other.headers['ratelimit-remaining'])).toBe(AUTH_MAX - 1);
  });

  test('authRoutes.js no longer mounts authLimiter itself (server.js is the one place)', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/authRoutes.js'), 'utf8');
    expect(routes).not.toMatch(/router\.use\(\s*authLimiter\s*\)/);
    const server = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    expect(server.match(/app\.use\(\s*["']\/api\/auth\/?["']\s*,\s*authLimiter\s*\)/g)).toHaveLength(1);
  });
});

describe('FI-089: the unused adminAccountLoginLimiter is gone', () => {
  test('rateLimiter no longer exports it', () => {
    const limiters = require('../../src/middleware/rateLimiter');
    expect(limiters).not.toHaveProperty('adminAccountLoginLimiter');
    expect(limiters).toHaveProperty('adminPasswordResetLimiter'); // its sibling, still used
  });

  test('nothing in the backend source refers to it', () => {
    const root = path.join(__dirname, '../../src');
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(js|jsx)$/.test(entry.name) && fs.readFileSync(p, 'utf8').includes('adminAccountLoginLimiter')) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
