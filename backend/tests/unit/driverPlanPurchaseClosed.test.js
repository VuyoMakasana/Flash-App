'use strict';
/**
 * tests/unit/driverPlanPurchaseClosed.test.js
 *
 * Step 1 (#102), founder decision 6 (driver plans are free) and FI-127:
 * the driver app no longer links to plans, but the server still sold one to
 * anyone calling POST /api/subscriptions/driver/purchase directly. It now
 * refuses EVERY request with 410 and a clear message, and never takes a
 * payment: the purchase handler doesn't run, Paystack isn't called, nothing
 * is written. Proven on the real Express app.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/socket/socketServer', () => jest.fn());
jest.mock('../../src/config/database', () => {
  const query = jest.fn(async () => ({ rows: [] }));
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })), on: jest.fn(), end: jest.fn() };
});
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.userId = req.headers['x-user-id'];
    req.userRole = req.headers['x-user-role'];
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
const pool = require('../../src/config/database');
const SubscriptionController = require('../../src/controllers/subscriptionController');
const paystackService = require('../../src/services/paystackService');
const { DRIVER_PLANS_FREE_MESSAGE } = require('../../src/routes/subscriptionRoutes');

let app;
beforeAll(() => {
  process.env.RENDER = 'true';
  jest.spyOn(SubscriptionController, 'purchaseDriverPlan');
  jest.spyOn(paystackService, 'initializeGenericCharge');
  jest.spyOn(paystackService, 'request');
  app = require('../../src/server').createApp().app;
});
afterAll(() => { delete process.env.RENDER; });

test.each([
  ['an approved driver', { 'x-user-role': 'driver', 'x-user-id': '55555555-5555-4555-8555-555555555555' }],
  ['a customer', { 'x-user-role': 'user', 'x-user-id': '11111111-1111-4111-8111-111111111111' }],
  ['no login at all', {}],
])('%s: POST /api/subscriptions/driver/purchase is refused with 410, and no payment is taken', async (_label, headers) => {
  pool.query.mockClear();
  const res = await request(app)
    .post('/api/subscriptions/driver/purchase')
    .set(headers)
    .set('CF-Connecting-IP', '198.51.100.91')
    .send({ planId: 'monthly' });

  expect(res.status).toBe(410);
  expect(res.body).toEqual({ error: DRIVER_PLANS_FREE_MESSAGE, code: 'DRIVER_PLANS_FREE' });
  expect(DRIVER_PLANS_FREE_MESSAGE).toMatch(/free/i);
  expect(SubscriptionController.purchaseDriverPlan).not.toHaveBeenCalled();
  expect(paystackService.initializeGenericCharge).not.toHaveBeenCalled();
  expect(paystackService.request).not.toHaveBeenCalled();
  const writes = pool.query.mock.calls.filter(([sql]) => /\b(UPDATE|INSERT)\b/i.test(String(sql)));
  expect(writes).toEqual([]);
});
