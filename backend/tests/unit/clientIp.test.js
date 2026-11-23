'use strict';

// Admin hardening A0 (#87): every per-IP rate limit must key on the real
// client, not a proxy hop.
//
// Production requests reach the app through Cloudflare and Render's own
// proxies. They arrive with a 3-entry X-Forwarded-For
// (client, Cloudflare edge, Render internal) plus CF-Connecting-IP and
// True-Client-IP. With `trust proxy 1`, Express's req.ip is the RIGHT-MOST
// X-Forwarded-For entry: a Render-internal proxy address. So every client
// arriving through the same proxy shared one counter, and one client got a
// different counter per edge. The fix keys every limiter on
// CF-Connecting-IP (on Render only), which Cloudflare sets itself.

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(), on: jest.fn(), end: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { clientIpFrom } = require('../../src/middleware/clientIp');

// Production's header shape. Edges are Cloudflare ranges; the last hop is Render-internal.
const via = (client, edge, internal) => ({
  'X-Forwarded-For': `${client}, ${edge}, ${internal}`,
  'CF-Connecting-IP': client,
  'True-Client-IP': client,
});
const EDGE_1 = ['172.70.1.1', '10.200.0.5'];
const EDGE_2 = ['172.70.2.2', '10.200.0.9'];

describe('what req.ip is today: trust proxy 1 + the production header shape', () => {
  test('Express gives the right-most X-Forwarded-For entry: a Render-internal proxy, not the client', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const r = await request(app).get('/ip').set(via('41.1.1.1', ...EDGE_1));
    expect(r.body.ip).toBe('10.200.0.5');
  });
});

describe('clientIpFrom (pure)', () => {
  const req = (headers, fallbackIp = '10.200.0.5') => ({ headers, ip: fallbackIp });
  const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  test('on Render, the client is CF-Connecting-IP', () => {
    expect(clientIpFrom(req(lower(via('41.1.1.1', ...EDGE_1))), { onRender: true })).toBe('41.1.1.1');
  });

  test('IPv6 clients work too', () => {
    expect(clientIpFrom(req({ 'cf-connecting-ip': '2c0f:f4c0:1:2::7' }), { onRender: true })).toBe('2c0f:f4c0:1:2::7');
  });

  test('a junk or list-shaped CF-Connecting-IP is ignored (falls back to the proxy-derived address)', () => {
    for (const bad of ['', 'not-an-ip', '41.1.1.1, 6.6.6.6', '999.1.1.1', ' ']) {
      expect(clientIpFrom(req({ 'cf-connecting-ip': bad }), { onRender: true })).toBe('10.200.0.5');
    }
  });

  test('X-Forwarded-For and True-Client-IP are never used for the key', () => {
    const r = req({ 'x-forwarded-for': '6.6.6.6', 'true-client-ip': '7.7.7.7', 'cf-connecting-ip': '41.1.1.1' });
    expect(clientIpFrom(r, { onRender: true })).toBe('41.1.1.1');
  });

  test('off Render (local, CI) CF-Connecting-IP is NOT trusted: anyone could send it', () => {
    expect(clientIpFrom(req({ 'cf-connecting-ip': '41.1.1.1' }, '127.0.0.1'), { onRender: false })).toBe('127.0.0.1');
  });
});

describe('every limiter keys on the real client (the real app, production header shape)', () => {
  let app;
  const savedRender = process.env.RENDER;
  beforeAll(() => {
    process.env.RENDER = 'true';
    app = require('../../src/server').createApp().app;
  });
  afterAll(() => { if (savedRender === undefined) delete process.env.RENDER; else process.env.RENDER = savedRender; });

  const remaining = (r) => Number(r.headers['ratelimit-remaining']);
  // Each test uses its own client addresses, because the limiters are module-level.
  const hit = (method, path, headers, body) => request(app)[method](path).set(headers).send(body);

  // `step` = how much one request uses: 1 for every limiter. (The auth
  // limiter used 2 until FI-087 was fixed in #89; it was mounted twice.)
  test.each([
    ['global /api limiter', 'get', '/api/status/hours', undefined, 1],
    ['auth limiter', 'post', '/api/auth/user/login', { email: 'x@example.com', password: 'x' }, 1],
    ['admin login limiter', 'post', '/api/admin/login', { email: 'x@example.com', password: 'x' }, 1],
    ['order limiter', 'post', '/api/orders', {}, 1],
  ])('%s: two clients behind the same proxy get separate counters', async (_name, method, path, body, step) => {
    const n = Math.floor(Math.random() * 200) + 20;
    const a = await hit(method, path, via(`41.10.${n}.1`, ...EDGE_1), body);
    const a2 = await hit(method, path, via(`41.10.${n}.1`, ...EDGE_1), body);
    const b = await hit(method, path, via(`102.20.${n}.2`, ...EDGE_1), body);
    expect(remaining(a2)).toBe(remaining(a) - step);
    expect(remaining(b)).toBe(remaining(a)); // B starts fresh, not after A's hits
  });

  test.each([
    ['global /api limiter', 'get', '/api/status/hours', undefined],
    ['admin login limiter', 'post', '/api/admin/login', { email: 'x@example.com', password: 'x' }],
  ])('%s: the same client through different edges shares one counter', async (_name, method, path, body) => {
    const n = Math.floor(Math.random() * 200) + 20;
    const first = await hit(method, path, via(`41.30.${n}.3`, ...EDGE_1), body);
    const second = await hit(method, path, via(`41.30.${n}.3`, ...EDGE_2), body);
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  test('a client cannot change its counter by sending its own X-Forwarded-For or True-Client-IP', async () => {
    const n = Math.floor(Math.random() * 200) + 20;
    const client = `41.40.${n}.4`;
    const honest = await hit('get', '/api/status/hours', via(client, ...EDGE_1));
    const spoofed = await hit('get', '/api/status/hours', {
      // What arrives when the client sends its own X-Forwarded-For: Cloudflare appends
      // the real address after it, and sets CF-Connecting-IP itself.
      'X-Forwarded-For': `6.6.6.6, 7.7.7.7, ${client}, ${EDGE_1[0]}, ${EDGE_1[1]}`,
      'True-Client-IP': '8.8.8.8',
      'CF-Connecting-IP': client,
    });
    expect(remaining(spoofed)).toBe(remaining(honest) - 1);
  });

  test('req.ip itself is the real client, so error logs and any library reading req.ip agree', async () => {
    const probe = express();
    probe.set('trust proxy', 1);
    probe.use(require('../../src/middleware/clientIp').realClientIp);
    probe.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const r = await request(probe).get('/ip').set(via('41.50.0.5', ...EDGE_2));
    expect(r.body.ip).toBe('41.50.0.5');
  });
});
