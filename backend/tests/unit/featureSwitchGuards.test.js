'use strict';
/**
 * tests/unit/featureSwitchGuards.test.js
 *
 * L0.5b (#98): every kill switch guards exactly its approved routes, and NOT
 * the never-blocked ones, proven on the real Express app (createApp) with the
 * real routers.
 *   - With every switch OFF (the FEATURE_<KEY>=off override), each guarded
 *     route answers 503, Retry-After: 300, {error, code: "FEATURE_OFF", feature}.
 *   - With every switch OFF, webhooks, verification, cash OTP, cancellations,
 *     store order handling and login are NOT refused by a switch.
 *   - With every switch ON (read from feature_switches), no route is refused.
 * Auth is stubbed (as in productionStateMachine.test.js): this file tests the
 * switch wiring, not authentication.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/socket/socketServer', () => jest.fn());
jest.mock('../../src/config/database', () => {
  const rows = (sql) => {
    if (/FROM feature_switches/.test(String(sql))) {
      return [
        'card_payments', 'new_orders', 'cash_orders', 'driver_payouts',
        'store_portal_writes', 'signups', 'premium', 'boosts',
      ].map((key) => ({ key, enabled: true }));
    }
    return [];
  };
  const query = jest.fn(async (sql) => ({ rows: rows(sql), rowCount: 0 }));
  return {
    query,
    connect: jest.fn(async () => ({ query, release: jest.fn() })),
    on: jest.fn(),
    end: jest.fn(),
  };
});
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.userId = req.headers['x-user-id'] || '11111111-1111-4111-8111-111111111111';
    req.userRole = req.headers['x-user-role'] || 'user';
    req.driverStatus = 'approved';
    next();
  },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.userRole) ? next() : res.status(403).json({ error: 'forbidden' })),
  requireApprovedDriver: (_req, _res, next) => next(),
  authenticateStore: (req, _res, next) => {
    req.storeUserId = '22222222-2222-4222-8222-222222222222';
    req.storeId = '33333333-3333-4333-8333-333333333333';
    req.storeRole = 'owner';
    next();
  },
  requireStoreRole: () => (_req, _res, next) => next(),
  requireOwnStore: (_req, _res, next) => next(),
  requireStorePasswordCurrent: (_req, _res, next) => next(),
}));

const request = require('supertest');
const { KEYS, MESSAGES } = require('../../src/services/featureSwitches');

const ORDER = '44444444-4444-4444-8444-444444444444';
const as = (role) => ({ 'x-user-role': role });

// [method, path, role headers, switch]
const GUARDED = [
  ['post', '/api/payments/initialize', as('user'), 'card_payments'],
  ['post', '/api/payments/charge-saved-card', as('user'), 'card_payments'],
  ['post', '/api/orders', as('user'), 'new_orders'],
  ['post', '/api/payments/cash-on-delivery', as('user'), 'cash_orders'],
  ['post', '/api/store-inventory', {}, 'store_portal_writes'],
  ['patch', `/api/store-inventory/${ORDER}/stock`, {}, 'store_portal_writes'],
  ['patch', `/api/store-inventory/${ORDER}/image`, {}, 'store_portal_writes'],
  ['patch', `/api/store-inventory/${ORDER}`, {}, 'store_portal_writes'],
  ['patch', `/api/store-inventory/${ORDER}/deactivate`, {}, 'store_portal_writes'],
  ['patch', `/api/store-inventory/${ORDER}/reactivate`, {}, 'store_portal_writes'],
  ['post', '/api/store-staff', {}, 'store_portal_writes'],
  ['patch', `/api/store-staff/${ORDER}/deactivate`, {}, 'store_portal_writes'],
  ['patch', `/api/store-staff/${ORDER}/reactivate`, {}, 'store_portal_writes'],
  ['post', '/api/store-banking', {}, 'store_portal_writes'],
  ['post', '/api/auth/user/register', {}, 'signups'],
  ['post', '/api/auth/driver/register', {}, 'signups'],
  ['post', '/api/store-onboarding/apply', {}, 'signups'],
  ['post', '/api/subscriptions/premium/purchase', as('user'), 'premium'],
  ['post', '/api/subscriptions/premium/purchase-with-card', as('user'), 'premium'],
  ['post', '/api/boost/purchase', as('admin'), 'boosts'],
  ['post', '/api/boost/promotions', as('admin'), 'boosts'],
];

// Never blocked by any switch (approved list).
const NEVER_BLOCKED = [
  ['post', '/api/webhooks/paystack', {}, 'Paystack webhook'],
  ['get', '/api/payments/verify/flash_ref_1', as('user'), 'payment verification'],
  ['post', '/api/payments/cash/send-otp', as('driver'), 'cash OTP send'],
  ['post', '/api/payments/cash/confirm', as('driver'), 'cash OTP confirm'],
  ['get', `/api/payments/cash/otp/${ORDER}`, as('user'), 'cash OTP read'],
  ['post', '/api/payments/cash/fail', as('driver'), 'cash failed'],
  ['post', `/api/orders/${ORDER}/cancel`, as('user'), 'customer cancellation'],
  ['post', `/api/store-orders/${ORDER}/accept`, {}, 'store accept'],
  ['post', `/api/store-orders/${ORDER}/reject`, {}, 'store reject'],
  ['post', `/api/store-orders/${ORDER}/mark-ready`, {}, 'store mark ready'],
  ['put', `/api/orders/${ORDER}/status`, as('driver'), 'driver status updates'],
  ['post', '/api/auth/user/login', {}, 'user login'],
  ['post', '/api/auth/driver/login', {}, 'driver login'],
  ['post', '/api/auth/refresh', {}, 'token refresh'],
];

let app;
let ip = 0;
const call = ([method, path, headers]) => {
  ip += 1;
  return request(app)[method](path)
    .set(headers)
    .set('CF-Connecting-IP', `198.51.100.${(ip % 250) + 1}`)
    .send({});
};

beforeAll(() => {
  process.env.RENDER = 'true';
  app = require('../../src/server').createApp().app;
});
afterAll(() => { delete process.env.RENDER; });

describe('every switch OFF (FEATURE_<KEY>=off)', () => {
  beforeAll(() => { for (const k of KEYS) process.env[`FEATURE_${k.toUpperCase()}`] = 'off'; });
  afterAll(() => { for (const k of KEYS) delete process.env[`FEATURE_${k.toUpperCase()}`]; });

  test.each(GUARDED)('%s %s is refused by %s', async (method, path, headers, key) => {
    const res = await call([method, path, headers]);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('300');
    expect(res.body).toEqual({ error: MESSAGES[key], code: 'FEATURE_OFF', feature: key });
  });

  test.each(NEVER_BLOCKED)('%s %s (%s) is never refused by a switch', async (method, path, headers) => {
    const res = await call([method, path, headers]);
    expect(res.body?.code).not.toBe('FEATURE_OFF');
  });
});

describe('every switch ON (from the feature_switches table)', () => {
  test.each(GUARDED)('%s %s is not refused when %s is on', async (method, path, headers) => {
    const res = await call([method, path, headers]);
    expect(res.body?.code).not.toBe('FEATURE_OFF');
  });
});

describe('GET /api/status/features (public)', () => {
  test('returns every key with on/off and its message, and nothing else', async () => {
    process.env.FEATURE_CASH_ORDERS = 'off';
    try {
      const res = await request(app).get('/api/status/features');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=15');
      expect(Object.keys(res.body)).toEqual(['features']);
      expect(Object.keys(res.body.features).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        expect(res.body.features[key]).toEqual({ enabled: key !== 'cash_orders', message: MESSAGES[key] });
      }
    } finally {
      delete process.env.FEATURE_CASH_ORDERS;
    }
  });
});
