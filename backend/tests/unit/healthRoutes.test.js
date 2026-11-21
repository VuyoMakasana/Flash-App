'use strict';

// L0.4 (#82): GET /health is a cheap liveness check for the external
// pinger and Render's health check (no database, nothing revealing);
// GET /health/db is a token-protected deep check, cached for 15 s, that is
// indistinguishable from a missing route without the right token.

const express = require('express');
const request = require('supertest');
const { createHealthRouter, CACHE_MS } = require('../../src/routes/healthRoutes');

const TOKEN = 'test-only-health-token-placeholder';

function appWith({ pool, now, token }) {
  const app = express();
  app.use(createHealthRouter({ pool, now, getToken: () => token }));
  app.use((req, res) => res.status(418).json({ fellThrough: true })); // must never be reached
  return app;
}

function fakePool(impl = async () => ({ rows: [{ '?column?': 1 }] })) {
  return { query: jest.fn(impl) };
}

describe('GET /health (liveness)', () => {
  test('200 {"status":"ok"}, Cache-Control: no-store, and no database work', async () => {
    const pool = fakePool();
    const res = await request(appWith({ pool, token: TOKEN })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('says nothing else: no version, no Redis status, no timestamp, no checks', async () => {
    const res = await request(appWith({ pool: fakePool(), token: TOKEN })).get('/health');
    expect(Object.keys(res.body)).toEqual(['status']);
    expect(JSON.stringify(res.body)).not.toMatch(/version|redis|timestamp|checks|database/i);
  });

  test('still 200 when the database is down (a DB blip must not make Render restart a working server)', async () => {
    const pool = fakePool(async () => { throw new Error('db down'); });
    const res = await request(appWith({ pool, token: TOKEN })).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /health/db (protected deep check)', () => {
  test('404 without the header, like any missing route, and no database work', async () => {
    const pool = fakePool();
    const res = await request(appWith({ pool, token: TOKEN })).get('/health/db');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', message: 'Cannot GET /health/db' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('404 with a wrong token, including one that differs only in length or case', async () => {
    const pool = fakePool();
    const app = appWith({ pool, token: TOKEN });
    for (const wrong of ['x', TOKEN + 'x', TOKEN.slice(0, -1), TOKEN.toUpperCase(), 'x' + TOKEN]) {
      const res = await request(app).get('/health/db').set('X-Health-Token', wrong);
      expect(res.status).toBe(404);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('surrounding spaces are not part of the token: HTTP strips them before the server sees the header', async () => {
    // Node's HTTP parser trims leading/trailing whitespace from header values
    // (RFC 9110 optional whitespace), so " <token>" arrives as "<token>".
    const res = await request(appWith({ pool: fakePool(), token: TOKEN })).get('/health/db').set('X-Health-Token', ` ${TOKEN} `);
    expect(res.status).toBe(200);
  });

  test('404 for everyone when HEALTH_CHECK_TOKEN is not set (even an empty header)', async () => {
    const pool = fakePool();
    for (const token of [undefined, '']) {
      const app = appWith({ pool, token });
      expect((await request(app).get('/health/db')).status).toBe(404);
      expect((await request(app).get('/health/db').set('X-Health-Token', '')).status).toBe(404);
      expect((await request(app).get('/health/db').set('X-Health-Token', 'anything')).status).toBe(404);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('right token: 200 {"database":"ok","latencyMs":N} and nothing else, no-store', async () => {
    const pool = fakePool();
    const res = await request(appWith({ pool, token: TOKEN })).get('/health/db').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['database', 'latencyMs']);
    expect(res.body.database).toBe('ok');
    expect(Number.isInteger(res.body.latencyMs)).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('database error: 503 {"database":"error","latencyMs":N}, no error details', async () => {
    const pool = fakePool(async () => { throw new Error('password authentication failed for user "secret_user" at db.internal.host'); });
    const res = await request(appWith({ pool, token: TOKEN })).get('/health/db').set('X-Health-Token', TOKEN);
    expect(res.status).toBe(503);
    expect(Object.keys(res.body).sort()).toEqual(['database', 'latencyMs']);
    expect(res.body.database).toBe('error');
    expect(JSON.stringify(res.body)).not.toMatch(/secret_user|internal|password/);
  });

  test('the result is cached for 15 s: one database query per window, then refreshed', async () => {
    let t = 1_000_000;
    const pool = fakePool();
    const app = appWith({ pool, token: TOKEN, now: () => t });
    for (let i = 0; i < 5; i++) await request(app).get('/health/db').set('X-Health-Token', TOKEN);
    expect(pool.query).toHaveBeenCalledTimes(1);
    t += CACHE_MS - 1;
    await request(app).get('/health/db').set('X-Health-Token', TOKEN);
    expect(pool.query).toHaveBeenCalledTimes(1);
    t += 1;
    await request(app).get('/health/db').set('X-Health-Token', TOKEN);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(CACHE_MS).toBe(15000);
  });

  test('concurrent requests while a check is running share one database query', async () => {
    let release;
    const pool = fakePool(() => new Promise((r) => { release = () => r({ rows: [] }); }));
    const app = appWith({ pool, token: TOKEN });
    const pending = [1, 2, 3].map(() => request(app).get('/health/db').set('X-Health-Token', TOKEN).then((r) => r));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('a failed check is cached too (a flood during an outage still costs one query per 15 s)', async () => {
    const pool = fakePool(async () => { throw new Error('down'); });
    const app = appWith({ pool, token: TOKEN });
    for (let i = 0; i < 4; i++) expect((await request(app).get('/health/db').set('X-Health-Token', TOKEN)).status).toBe(503);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('mounted in the real app before the request logger', () => {
  const logged = [];
  let app;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
    jest.doMock('../../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn(), on: jest.fn(), end: jest.fn() }));
    // Replace the request logger with a recorder: anything that reaches it would be logged (headers included).
    jest.doMock('pino-http', () => jest.fn(() => (req, res, next) => { logged.push({ url: req.url, headers: { ...req.headers } }); next(); }));
    process.env.HEALTH_CHECK_TOKEN = TOKEN;
    app = require('../../src/server').createApp().app;
  });
  afterAll(() => { delete process.env.HEALTH_CHECK_TOKEN; jest.resetModules(); });

  test('/health and /health/db (right, wrong and missing token) never reach the request logger', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/health/db').set('X-Health-Token', TOKEN)).status).toBe(200);
    expect((await request(app).get('/health/db').set('X-Health-Token', 'wrong')).status).toBe(404);
    expect((await request(app).get('/health/db')).status).toBe(404);
    expect(logged.filter((l) => l.url.startsWith('/health'))).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  test('other routes are still logged (the logger is wired, not removed)', async () => {
    await request(app).get('/api/status/hours');
    expect(logged.some((l) => l.url === '/api/status/hours')).toBe(true);
  });

  test('the request logger redacts x-health-token too (defence in depth)', () => {
    const pinoHttp = require('pino-http');
    const opts = pinoHttp.mock.calls[0][0];
    expect(opts.redact).toEqual(expect.arrayContaining(['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-health-token"]']));
  });
});
