'use strict';
/**
 * tests/unit/webhookFailClosedAndReturnPage.test.js
 *
 * Step 1 (#102):
 *   - In production the Paystack webhook refuses (503, loud log) when
 *     PAYSTACK_SECRET_KEY is missing OR is a test key (sk_test_…). A test key
 *     would verify test-mode events as genuine. Development and test keep
 *     their old behaviour (a test key verifies; no key skips the check).
 *   - GET /payment/return is a static, data-free page for Paystack's
 *     callback_url, and Paystack is sent there.
 */
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/config/database');

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
  jest.resetModules();
});

// Loads webhookController fresh under the given environment (isProd is read
// once, when config/env.js loads).
function loadController(env) {
  process.env = { ...ORIGINAL_ENV, ...env };
  if (!('PAYSTACK_SECRET_KEY' in env)) delete process.env.PAYSTACK_SECRET_KEY;
  let Controller;
  jest.isolateModules(() => {
    jest.doMock('../../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));
    Controller = require('../../src/controllers/webhookController');
  });
  return Controller;
}

function appFor(Controller) {
  const app = express();
  app.post('/hook', express.raw({ type: '*/*' }), (req, res) => Controller.handlePaystack(req, res));
  return app;
}

const BODY = JSON.stringify({ event: 'unhandled.event', data: {} });
const sign = (key) => crypto.createHmac('sha512', key).update(BODY).digest('hex');

describe('webhook: fail closed in production', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  test('missing key in production → 503, logged as CRITICAL', async () => {
    const res = await request(appFor(loadController({ NODE_ENV: 'production' })))
      .post('/hook').set('Content-Type', 'application/json').send(BODY);
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL.*missing in production/));
  });

  test('a TEST key in production → 503 even with a valid signature', async () => {
    const key = 'sk_test_aaaaaaaaaaaaaaaaaaaa';
    const res = await request(appFor(loadController({ NODE_ENV: 'production', PAYSTACK_SECRET_KEY: key })))
      .post('/hook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(key)).send(BODY);
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL.*TEST key in production/));
  });

  test('a live key in production with a valid signature is accepted', async () => {
    const key = 'sk_live_bbbbbbbbbbbbbbbbbbbb';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await request(appFor(loadController({ NODE_ENV: 'production', PAYSTACK_SECRET_KEY: key })))
      .post('/hook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(key)).send(BODY);
    expect(res.status).toBe(200);
  });

  test('a live key in production with a wrong signature is rejected (400)', async () => {
    const key = 'sk_live_bbbbbbbbbbbbbbbbbbbb';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(appFor(loadController({ NODE_ENV: 'production', PAYSTACK_SECRET_KEY: key })))
      .post('/hook').set('Content-Type', 'application/json').set('x-paystack-signature', sign('sk_live_wrong')).send(BODY);
    expect(res.status).toBe(400);
  });

  test('development keeps working with a test key', async () => {
    const key = 'sk_test_cccccccccccccccccccc';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await request(appFor(loadController({ NODE_ENV: 'development', PAYSTACK_SECRET_KEY: key })))
      .post('/hook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(key)).send(BODY);
    expect(res.status).toBe(200);
  });
});

describe('GET /payment/return', () => {
  const { createPaymentReturnRouter, paymentReturnUrl } = require('../../src/routes/paymentReturnRoutes');
  const app = express().use(createPaymentReturnRouter());

  test('a static page: 200, HTML, not cached, not indexed', async () => {
    const res = await request(app).get('/payment/return');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).toMatch(/go back to Flash/);
    expect(res.text).not.toMatch(/<script/i);
  });

  test('never echoes the query string', async () => {
    const res = await request(app).get('/payment/return?reference=flash_secret_ref_123&trxref=<b>x</b>');
    expect(res.text).not.toMatch(/flash_secret_ref_123/);
    expect(res.text).not.toMatch(/<b>x<\/b>/);
    const plain = await request(app).get('/payment/return');
    expect(res.text).toBe(plain.text);
  });

  test('Paystack is sent to it: production default, override, and development', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PAYSTACK_CALLBACK_URL;
    expect(paymentReturnUrl()).toBe('https://api.flashdelivery.co.za/payment/return');
    process.env.PAYSTACK_CALLBACK_URL = 'https://staging.example/payment/return';
    expect(paymentReturnUrl()).toBe('https://staging.example/payment/return');
    delete process.env.PAYSTACK_CALLBACK_URL;
    process.env.NODE_ENV = 'development';
    process.env.PORT = '3000';
    expect(paymentReturnUrl()).toBe('http://localhost:3000/payment/return');
  });

  test('initializePayment sends that callback_url to Paystack', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    let paystackService;
    let pool;
    jest.isolateModules(() => {
      jest.doMock('../../src/config/database', () => {
        const client = { query: jest.fn(async (sql) => (/FOR UPDATE/.test(sql)
          ? { rows: [{ id: 'order-1', total: '180.00', user_id: 'user-1', payment_status: 'pending', paystack_reference: null }] }
          : { rows: [] })), release: jest.fn() };
        return { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [{ email: 'a@b.co' }] }) };
      });
      paystackService = require('../../src/services/paystackService');
      pool = require('../../src/config/database');
    });
    expect(pool).toBeDefined();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(paystackService, 'request').mockResolvedValue({ status: true, data: { authorization_url: 'https://checkout', reference: 'r' } });
    await paystackService.initializePayment('order-1', 'user-1');
    expect(spy.mock.calls[0][2].callback_url).toBe('http://localhost:3000/payment/return');
  });
});
