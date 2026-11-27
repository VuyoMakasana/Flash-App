'use strict';
/**
 * tests/unit/cashOrdersSwitch.test.js
 *
 * Step 1 (#102): confirms on the real Express app that a cash order is
 * refused SERVER-SIDE when the cash_orders switch is off, whatever the app
 * shows. The refusal happens before the handler runs, so nothing is
 * written: no order update and no payment row.
 * (featureSwitchGuards.test.js already proves the 503 for every switch;
 * this adds the "nothing was written" half for cash, the one Sunday needs.)
 */
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/socket/socketServer', () => jest.fn());
jest.mock('../../src/config/database', () => {
  const ALL_ON = ['card_payments', 'new_orders', 'cash_orders', 'driver_payouts',
    'store_portal_writes', 'signups', 'premium', 'boosts'];
  const query = jest.fn(async (sql) => {
    const s = String(sql);
    if (/FROM feature_switches/.test(s)) {
      return { rows: ALL_ON.map((key) => ({ key, enabled: key !== 'cash_orders' })) };
    }
    return { rows: [] };
  });
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })), on: jest.fn(), end: jest.fn() };
});
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.userId = '11111111-1111-4111-8111-111111111111'; req.userRole = 'user'; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.userRole) ? next() : res.status(403).json({ error: 'forbidden' })),
  requireApprovedDriver: (_req, _res, next) => next(),
  authenticateStore: (_req, _res, next) => next(),
  requireStoreRole: () => (_req, _res, next) => next(),
  requireOwnStore: (_req, _res, next) => next(),
  requireStorePasswordCurrent: (_req, _res, next) => next(),
}));

const request = require('supertest');
const pool = require('../../src/config/database');
const PaymentController = require('../../src/controllers/paymentController');
const { MESSAGES } = require('../../src/services/featureSwitches');

let app;
beforeAll(() => {
  process.env.RENDER = 'true';
  jest.spyOn(PaymentController, 'cashOnDelivery');
  app = require('../../src/server').createApp().app;
});
afterAll(() => { delete process.env.RENDER; });

test('cash_orders off (as set in the admin panel): POST /api/payments/cash-on-delivery is refused and nothing is written', async () => {
  pool.query.mockClear();
  const res = await request(app)
    .post('/api/payments/cash-on-delivery')
    .set('CF-Connecting-IP', '198.51.100.77')
    .send({ orderId: '44444444-4444-4444-8444-444444444444' });

  expect(res.status).toBe(503);
  expect(res.body).toEqual({ error: MESSAGES.cash_orders, code: 'FEATURE_OFF', feature: 'cash_orders' });
  expect(PaymentController.cashOnDelivery).not.toHaveBeenCalled();
  const writes = pool.query.mock.calls.filter(([sql]) => /\b(UPDATE|INSERT)\b/i.test(String(sql)));
  expect(writes).toEqual([]);
});
