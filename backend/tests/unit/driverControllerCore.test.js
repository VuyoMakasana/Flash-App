'use strict';
/**
 * tests/unit/driverControllerCore.test.js
 *
 * Coverage-remediation Phase 3 — DriverController's thin wrapper methods
 * around the (already well-tested elsewhere) state-machine/commission/
 * wallet services: setOnlineStatus, acceptOrder, getWallet, getEarnings,
 * requestPayout. None of these had controller-level coverage before this
 * file -- assignDriver's own accept/assignment logic is thoroughly tested
 * in orderStateMachine.test.js, and getWalletWithDebt/
 * deductDebtBeforePayout are thoroughly tested in driverCommission.test.js,
 * but nothing proved these controllers actually call them correctly, map
 * their real-world gates (commission debt, subscription, service area) to
 * the right HTTP response, or handle failure cleanly.
 */

jest.mock('../../src/models/Driver');
jest.mock('../../src/models/DriverWallet');
jest.mock('../../src/services/driverCommissionService');
jest.mock('../../src/services/subscriptionService');
jest.mock('../../src/services/orderStateMachineService');
jest.mock('../../src/services/payoutService');

const Driver = require('../../src/models/Driver');
const DriverWallet = require('../../src/models/DriverWallet');
const { checkCommissionBlock, getWalletWithDebt } = require('../../src/services/driverCommissionService');
const { checkDriverSubscriptionAllowed } = require('../../src/services/subscriptionService');
const { assignDriver } = require('../../src/services/orderStateMachineService');
const PayoutService = require('../../src/services/payoutService');
const DriverController = require('../../src/controllers/driverController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function mockReq(overrides = {}) {
  return { userId: 'driver-1', params: {}, body: {}, query: {}, app: { get: () => null }, ...overrides };
}

beforeEach(() => jest.clearAllMocks());

// ─── Going online/offline ───────────────────────────────────────────────────
//
// Real-world scenario: a driver taps the "Go Online" toggle at the start
// of their shift. Three real gates stand between that tap and actually
// appearing in the driver pool -- commission debt, an expired
// subscription, and being outside Flash's service area -- and going
// OFFLINE must never be blocked by any of them.
describe('DriverController.setOnlineStatus', () => {
  test('returns 400 when the online field is missing entirely', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await DriverController.setOnlineStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });

  test('blocks going online when the driver owes real commission debt', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: true, debtAmount: 150.5, unpaidDeliveries: 7 });
    const req = mockReq({ body: { online: true, lat: -33.884, lng: 25.585 } });
    const res = mockRes();

    await DriverController.setOnlineStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('COMMISSION_DEBT_BLOCKED');
    expect(body.debtAmount).toBe(150.5);
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });

  test('blocks going online with an expired/disallowed subscription', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: false });
    checkDriverSubscriptionAllowed.mockResolvedValue({ allowed: false, reason: 'Your subscription has expired.' });
    const req = mockReq({ body: { online: true, lat: -33.884, lng: 25.585 } });
    const res = mockRes();

    await DriverController.setOnlineStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requiresSubscription: true }));
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });

  test('blocks going online from outside Nelson Mandela Bay', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: false });
    checkDriverSubscriptionAllowed.mockResolvedValue({ allowed: true });
    const req = mockReq({ body: { online: true, lat: -26.2041, lng: 28.0473 } }); // Johannesburg
    const res = mockRes();

    await DriverController.setOnlineStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });

  test('a driver who passes every gate actually goes online', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: false });
    checkDriverSubscriptionAllowed.mockResolvedValue({ allowed: true });
    Driver.setOnlineStatus.mockResolvedValue();
    const req = mockReq({ body: { online: true, lat: -33.884, lng: 25.585 } });
    const res = mockRes();

    await DriverController.setOnlineStatus(req, res);

    expect(Driver.setOnlineStatus).toHaveBeenCalledWith('driver-1', true);
    expect(res.json).toHaveBeenCalledWith({ online: true });
  });

  test('going offline skips every online-only gate, even a commission-blocked driver', async () => {
    Driver.setOnlineStatus.mockResolvedValue();
    const req = mockReq({ body: { online: false } });
    const res = mockRes();

    await DriverController.setOnlineStatus(req, res);

    expect(checkCommissionBlock).not.toHaveBeenCalled();
    expect(checkDriverSubscriptionAllowed).not.toHaveBeenCalled();
    expect(Driver.setOnlineStatus).toHaveBeenCalledWith('driver-1', false);
    expect(res.json).toHaveBeenCalledWith({ online: false });
  });
});

// ─── Accepting an order ─────────────────────────────────────────────────────
//
// Real-world scenario: a driver taps "Accept" on an order in their feed.
// assignDriver's own real assignment/race-condition logic is tested
// thoroughly in orderStateMachine.test.js -- this is specifically the
// controller's own commission-debt gate (checked BEFORE assignDriver is
// even called) and its error->response mapping.
describe('DriverController.acceptOrder', () => {
  test('blocks a commission-indebted driver from accepting, before ever calling assignDriver', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: true, debtAmount: 80, unpaidDeliveries: 3 });
    const req = mockReq({ params: { orderId: 'order-1' } });
    const res = mockRes();

    await DriverController.acceptOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('COMMISSION_DEBT_BLOCKED');
    expect(assignDriver).not.toHaveBeenCalled();
  });

  test('accepts a real available order and returns it', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: false });
    const assignedOrder = { id: 'order-1', status: 'driver_assigned', driver_id: 'driver-1' };
    assignDriver.mockResolvedValue(assignedOrder);
    const req = mockReq({ params: { orderId: 'order-1' } });
    const res = mockRes();

    await DriverController.acceptOrder(req, res);

    expect(assignDriver).toHaveBeenCalledWith('order-1', 'driver-1', expect.objectContaining({ enforceTrustedDriverWindow: true }));
    expect(res.json).toHaveBeenCalledWith({ order: assignedOrder });
  });

  // Real-world scenario: two drivers tap "Accept" on the same order within
  // moments of each other -- assignDriver's own real locking is what
  // decides the loser (proven in orderStateMachine.test.js); this proves
  // the controller surfaces that loss as a clean 400, not a 500.
  test('a losing race for the same order becomes a clean 400 with the real reason', async () => {
    checkCommissionBlock.mockResolvedValue({ blocked: false });
    assignDriver.mockRejectedValue(new Error('Driver is not available'));
    const req = mockReq({ params: { orderId: 'order-1' } });
    const res = mockRes();

    await DriverController.acceptOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Driver is not available' });
  });
});

// ─── Wallet / earnings / payout ─────────────────────────────────────────────
describe('DriverController.getWallet', () => {
  test('returns the real wallet-with-debt shape for the authenticated driver', async () => {
    const wallet = { walletBalance: 500, pendingBalance: 90, cashCommissionDebt: 0 };
    getWalletWithDebt.mockResolvedValue(wallet);
    const req = mockReq();
    const res = mockRes();

    await DriverController.getWallet(req, res);

    expect(getWalletWithDebt).toHaveBeenCalledWith('driver-1');
    expect(res.json).toHaveBeenCalledWith({ wallet });
  });

  test('returns 500 without leaking internal detail on failure', async () => {
    getWalletWithDebt.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const req = mockReq();
    const res = mockRes();

    await DriverController.getWallet(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].error).not.toMatch(/connection terminated/);
  });
});

describe('DriverController.getEarnings', () => {
  test('combines real earnings totals with the real wallet-with-debt shape', async () => {
    Driver.getEarnings.mockResolvedValue({ totalDeliveries: 42, totalEarned: 3200 });
    getWalletWithDebt.mockResolvedValue({ walletBalance: 500 });
    const req = mockReq();
    const res = mockRes();

    await DriverController.getEarnings(req, res);

    expect(res.json).toHaveBeenCalledWith({ totalDeliveries: 42, totalEarned: 3200, wallet: { walletBalance: 500 } });
  });
});

describe('DriverController.requestPayout', () => {
  test('rejects a missing amount', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await DriverController.requestPayout(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(DriverWallet.createPayoutRequest).not.toHaveBeenCalled();
  });

  test('rejects a zero or negative amount', async () => {
    const req = mockReq({ body: { amount: -50 } });
    const res = mockRes();
    await DriverController.requestPayout(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(DriverWallet.createPayoutRequest).not.toHaveBeenCalled();
  });

  test('rejects a non-numeric amount', async () => {
    const req = mockReq({ body: { amount: 'lots' } });
    const res = mockRes();
    await DriverController.requestPayout(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('a real, valid payout request is created and processed', async () => {
    const payoutRequest = { id: 'payout-1', amount: 200, status: 'pending' };
    DriverWallet.createPayoutRequest.mockResolvedValue(payoutRequest);
    PayoutService.processRequestedPayout.mockResolvedValue({ status: 'processed' });
    const req = mockReq({ body: { amount: 200 } });
    const res = mockRes();

    await DriverController.requestPayout(req, res);

    expect(DriverWallet.createPayoutRequest).toHaveBeenCalledWith('driver-1', 200);
    expect(PayoutService.processRequestedPayout).toHaveBeenCalledWith('payout-1');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ payoutRequest, payout: { status: 'processed' } });
  });

  test('a real business-rule rejection (e.g. insufficient balance) becomes a clean 400', async () => {
    DriverWallet.createPayoutRequest.mockRejectedValue(new Error('Insufficient wallet balance for this payout amount'));
    const req = mockReq({ body: { amount: 10000 } });
    const res = mockRes();

    await DriverController.requestPayout(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient wallet balance for this payout amount' });
  });
});
