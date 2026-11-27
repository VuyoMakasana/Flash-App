'use strict';
/**
 * tests/unit/deliveryCodeExposure.test.js
 *
 * Step 1 (#102), audit P0-5: the assigned driver must never be able to read
 * the customer's delivery code. GET /api/orders/:orderId returned the whole
 * orders row (SELECT o.*), including cash_otp_plain, so a driver could send
 * the code, read it back, and complete the delivery without the customer.
 *
 * Proven on the real Express app: no JSON response carries cash_otp_plain or
 * cash_otp_hash, while the customer can still read their own code from the
 * one endpoint meant for it (GET /api/payments/cash/otp/:orderId, customer
 * only, own orders only).
 */
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/socket/socketServer', () => jest.fn());

const ORDER = '44444444-4444-4444-8444-444444444444';
const DRIVER = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const CODE = '482913';

jest.mock('../../src/config/database', () => {
  const orderRow = () => ({
    id: '44444444-4444-4444-8444-444444444444',
    user_id: '11111111-1111-4111-8111-111111111111',
    driver_id: '55555555-5555-4555-8555-555555555555',
    status: 'in_transit',
    payment_method: 'card',
    cash_otp_plain: '482913',
    cash_otp_hash: '$2a$10$abcdefghijklmnopqrstuv',
    cash_otp_expires_at: new Date(Date.now() + 600000).toISOString(),
    items: [],
  });
  const query = jest.fn(async (sql) => {
    const s = String(sql);
    if (/FROM feature_switches/.test(s)) return { rows: [] };
    if (/user_blocks/i.test(s)) return { rows: [] };
    if (/SELECT cash_otp_plain, cash_otp_expires_at FROM orders/.test(s)) {
      return { rows: [{ cash_otp_plain: '482913', cash_otp_expires_at: new Date(Date.now() + 600000) }] };
    }
    if (/SELECT user_id FROM orders WHERE id/.test(s)) return { rows: [{ user_id: '11111111-1111-4111-8111-111111111111' }] };
    if (/FROM orders/.test(s)) return { rows: [orderRow()] };
    return { rows: [] };
  });
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })), on: jest.fn(), end: jest.fn() };
});
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.userId = req.headers['x-user-id'];
    req.userRole = req.headers['x-user-role'];
    req.driverStatus = 'approved';
    next();
  },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.userRole) ? next() : res.status(403).json({ error: 'forbidden' })),
  requireApprovedDriver: (_req, _res, next) => next(),
  authenticateStore: (_req, _res, next) => next(),
  requireStoreRole: () => (_req, _res, next) => next(),
  requireOwnStore: (_req, _res, next) => next(),
  requireStorePasswordCurrent: (_req, _res, next) => next(),
}));

const request = require('supertest');
const { stripOrderSecrets } = require('../../src/utils/orderSecrets');

let app;
beforeAll(() => {
  process.env.RENDER = 'true';
  app = require('../../src/server').createApp().app;
});
afterAll(() => { delete process.env.RENDER; });

const asDriver = { 'x-user-role': 'driver', 'x-user-id': DRIVER };
const asCustomer = { 'x-user-role': 'user', 'x-user-id': CUSTOMER };

describe('the delivery code never reaches the driver', () => {
  test('GET /api/orders/:id as the assigned driver: no code in the response', async () => {
    const res = await request(app).get(`/api/orders/${ORDER}`).set(asDriver);
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(ORDER);
    expect(res.body.order).not.toHaveProperty('cash_otp_plain');
    expect(res.body.order).not.toHaveProperty('cash_otp_hash');
    expect(JSON.stringify(res.body)).not.toContain(CODE);
  });

  test('GET /api/orders/:id as the customer: no code either (they read it from the code endpoint)', async () => {
    const res = await request(app).get(`/api/orders/${ORDER}`).set(asCustomer);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CODE);
  });

  test('the customer can still read their own code', async () => {
    const res = await request(app).get(`/api/payments/cash/otp/${ORDER}`).set(asCustomer);
    expect(res.status).toBe(200);
    expect(res.body.otp).toBe(CODE);
  });

  test('the driver cannot use the customer\'s code endpoint', async () => {
    const res = await request(app).get(`/api/payments/cash/otp/${ORDER}`).set(asDriver);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(CODE);
  });
});

describe('stripOrderSecrets', () => {
  test('removes the code fields at any depth, without touching the input', () => {
    const input = {
      order: { id: 'o1', cash_otp_plain: '1', cash_otp_hash: 'h', total: '10.00' },
      orders: [{ id: 'o2', cash_otp_plain: '2' }, { id: 'o3' }],
      nested: { deeper: { cash_otp_plain: '3', ok: true } },
    };
    const out = stripOrderSecrets(input);
    expect(out).toEqual({
      order: { id: 'o1', total: '10.00' },
      orders: [{ id: 'o2' }, { id: 'o3' }],
      nested: { deeper: { ok: true } },
    });
    expect(input.order.cash_otp_plain).toBe('1');
  });

  test('leaves other values alone', () => {
    const date = new Date();
    expect(stripOrderSecrets(null)).toBeNull();
    expect(stripOrderSecrets('text')).toBe('text');
    expect(stripOrderSecrets({ otp: '123456', expiresAt: date })).toEqual({ otp: '123456', expiresAt: date });
    const plain = { a: 1 };
    expect(stripOrderSecrets(plain)).toBe(plain);
  });
});
