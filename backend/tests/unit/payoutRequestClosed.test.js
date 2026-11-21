'use strict';

// L0.4 (#82): driver withdrawals are permanently off for launch (founder
// decision 2026-11-21). POST /api/drivers/wallet/payout-request used to
// create a payout request and immediately call
// PayoutService.processRequestedPayout -- a live Paystack transfer. It must
// now refuse before any database write or Paystack call. PayoutService
// itself stays (L3's nightly transfer reuses it).

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/config/database', () => ({ query: jest.fn(), connect: jest.fn(), on: jest.fn(), end: jest.fn() }));
jest.mock('../../src/services/payoutService', () => ({
  processRequestedPayout: jest.fn(),
  finalizeSuccessfulPayout: jest.fn(),
  handleFailedPayout: jest.fn(),
}));
jest.mock('../../src/models/DriverWallet', () => ({ createPayoutRequest: jest.fn() }));

const request = require('supertest');
const pool = require('../../src/config/database');
const PayoutService = require('../../src/services/payoutService');
const DriverWallet = require('../../src/models/DriverWallet');
const { generateToken } = require('../../src/utils/helpers');

const DRIVER_ID = '22222222-2222-2222-2222-222222222222';
const MESSAGE = "Withdrawals aren't available. Your earnings are paid to your bank automatically.";

let app;
beforeAll(() => { app = require('../../src/server').createApp().app; });
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM revoked_tokens/.test(sql)) return { rows: [] };
    if (/SELECT status FROM drivers/.test(sql)) return { rows: [{ status: pool.__driverStatus || 'approved' }] };
    throw new Error(`unexpected query in a closed endpoint: ${sql}`);
  });
  pool.__driverStatus = 'approved';
});

const writes = () => pool.query.mock.calls.map(([sql]) => sql).filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql));

describe('POST /api/drivers/wallet/payout-request is closed', () => {
  test('an approved driver gets a clear 403 message, with no database write and no payout call', async () => {
    const res = await request(app)
      .post('/api/drivers/wallet/payout-request')
      .set('Authorization', `Bearer ${generateToken(DRIVER_ID, 'driver', 'approved')}`)
      .send({ amount: 500 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: MESSAGE, code: 'WITHDRAWALS_DISABLED' });
    expect(PayoutService.processRequestedPayout).not.toHaveBeenCalled();
    expect(DriverWallet.createPayoutRequest).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test('the same for any body: missing, zero, negative, huge, or junk amounts', async () => {
    const token = generateToken(DRIVER_ID, 'driver', 'approved');
    for (const body of [{}, { amount: 0 }, { amount: -5 }, { amount: 1e9 }, { amount: 'all' }]) {
      const res = await request(app).post('/api/drivers/wallet/payout-request').set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WITHDRAWALS_DISABLED');
    }
    expect(PayoutService.processRequestedPayout).not.toHaveBeenCalled();
    expect(DriverWallet.createPayoutRequest).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test('requireApprovedDriver now guards the route: a driver who is not approved is stopped first', async () => {
    pool.__driverStatus = 'pending_documents';
    const res = await request(app)
      .post('/api/drivers/wallet/payout-request')
      .set('Authorization', `Bearer ${generateToken(DRIVER_ID, 'driver')}`)
      .send({ amount: 500 });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('pending_documents');
    expect(pool.query.mock.calls.some(([sql]) => /SELECT status FROM drivers/.test(sql))).toBe(true);
    expect(PayoutService.processRequestedPayout).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test('still requires a driver login (unauthenticated: 401; a customer token: 403)', async () => {
    expect((await request(app).post('/api/drivers/wallet/payout-request').send({ amount: 5 })).status).toBe(401);
    const customer = await request(app)
      .post('/api/drivers/wallet/payout-request')
      .set('Authorization', `Bearer ${generateToken(DRIVER_ID, 'user')}`)
      .send({ amount: 5 });
    expect(customer.status).toBe(403);
    expect(PayoutService.processRequestedPayout).not.toHaveBeenCalled();
  });

  test('the old handler that started the transfer is gone from the controller; PayoutService is kept for L3', () => {
    const DriverController = require('../../src/controllers/driverController');
    expect(DriverController.requestPayout).toBeUndefined();
    expect(typeof DriverController.refuseWithdrawal).toBe('function');
    const real = jest.requireActual('../../src/services/payoutService');
    expect(typeof real.processRequestedPayout).toBe('function');
  });
});
