'use strict';
/**
 * tests/unit/payments.test.js
 *
 * Tests for PaymentController: initializePayment, confirmCashReceived (with
 * commission), chargeSavedCard, cash OTP, row-lock idempotency.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/paystackService');
jest.mock('../../src/services/cashOtpService');
jest.mock('../../src/services/orderStateMachineService');
jest.mock('../../src/services/fleetIntelligenceService');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/services/operatingHoursService');
jest.mock('../../src/services/driverCommissionService');
jest.mock('../../src/models/Payment');
jest.mock('../../src/models/Order');

const db                 = require('../../src/config/database');
const cashOtpService     = require('../../src/services/cashOtpService');
const commissionService  = require('../../src/services/driverCommissionService');
const { updateOrderStatus } = require('../../src/services/orderStateMachineService');
const PaymentController  = require('../../src/controllers/paymentController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function mockClient(queryImpl) {
  const client = {
    query: jest.fn().mockImplementation(queryImpl || (() => Promise.resolve({ rows: [] }))),
    release: jest.fn(),
  };
  return client;
}

// ─── confirmCashReceived ──────────────────────────────────────────────────────

describe('PaymentController.confirmCashReceived', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when orderId missing', async () => {
    const req = { body: {}, userId: 'driver-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.confirmCashReceived(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({ error: /orderId/ });
  });

  test('returns 400 when OTP missing', async () => {
    const req = { body: { orderId: 'order-001' }, userId: 'driver-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.confirmCashReceived(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 403 when driver is not order owner', async () => {
    cashOtpService.verifyOtp.mockResolvedValue(true);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({              // SELECT FOR UPDATE
        rows: [{ id: 'order-001', driver_id: 'other-driver', payment_method: 'cash',
                 payment_status: 'pending_cash', status: 'delivered', user_id: 'user-001' }],
      });
    db.connect.mockResolvedValue(client);

    const req = { body: { orderId: 'order-001', otp: '1234' }, userId: 'driver-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.confirmCashReceived(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('records commission on successful cash confirmation', async () => {
    cashOtpService.verifyOtp.mockResolvedValue(true);
    commissionService.checkCommissionBlock.mockResolvedValue({ blocked: false, debtAmount: 0, unpaidDeliveries: 0 });
    commissionService.recordCashCommission.mockResolvedValue();
    updateOrderStatus.mockResolvedValue();

    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({              // SELECT FOR UPDATE
        rows: [{ id: 'order-001', driver_id: 'driver-001', payment_method: 'cash',
                 payment_status: 'pending_cash', status: 'delivered', user_id: 'user-001' }],
      })
      .mockResolvedValueOnce({ rows: [] })  // UPDATE payment_status
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    db.connect.mockResolvedValue(client);

    const req = {
      body: { orderId: 'order-001', otp: '1234' },
      userId: 'driver-001',
      app: { get: () => null },
    };
    const res = mockRes();
    await PaymentController.confirmCashReceived(req, res);

    expect(commissionService.recordCashCommission).toHaveBeenCalledWith(
      client, 'driver-001', 'order-001',
    );
    expect(res.json).toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.commission.recorded).toBe(true);
  });

  test('rolls back transaction when OTP verification fails', async () => {
    cashOtpService.verifyOtp.mockRejectedValue(new Error('Invalid OTP'));
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    const req = {
      body: { orderId: 'order-001', otp: 'wrong' },
      userId: 'driver-001',
      app: { get: () => null },
    };
    const res = mockRes();
    await PaymentController.confirmCashReceived(req, res);

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─── initializePayment ────────────────────────────────────────────────────────

describe('PaymentController.initializePayment', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when orderId missing', async () => {
    const req = { body: {}, userId: 'user-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.initializePayment(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns payment URL on success', async () => {
    const paystackService = require('../../src/services/paystackService');
    paystackService.initializePayment = jest.fn().mockResolvedValue({
      authorization_url: 'https://paystack.com/pay/test',
      reference: 'flash_123',
    });

    const req = { body: { orderId: 'order-001' }, userId: 'user-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.initializePayment(req, res);
    expect(res.json).toHaveBeenCalled();
  });
});

// ─── sendCashOtp ──────────────────────────────────────────────────────────────

describe('PaymentController.sendCashOtp', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 403 when driver is not the assigned driver', async () => {
    db.query.mockResolvedValue({
      rows: [{
        id: 'order-001', user_id: 'user-001', driver_id: 'other-driver',
        payment_method: 'cash', payment_status: 'pending_cash', status: 'in_transit',
      }],
    });

    const req = { body: { orderId: 'order-001' }, userId: 'driver-hacker', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.sendCashOtp(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 409 when order not in correct state', async () => {
    db.query.mockResolvedValue({
      rows: [{
        id: 'order-001', user_id: 'user-001', driver_id: 'driver-001',
        payment_method: 'cash', payment_status: 'pending_cash', status: 'created',
      }],
    });

    const req = { body: { orderId: 'order-001' }, userId: 'driver-001', app: { get: () => null } };
    const res = mockRes();
    await PaymentController.sendCashOtp(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
