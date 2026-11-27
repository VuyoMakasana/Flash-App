'use strict';
/**
 * tests/unit/driverPlanGate.test.js
 *
 * Step 1 (#102), founder decision 6: driver plans are free. A driver with
 * no driver_subscriptions row (none was ever bought, or the test-mode plan
 * expired) must still be able to go online and see available orders. The
 * paid-plan check (subscriptionService.checkDriverSubscriptionAllowed) is no
 * longer consulted on either path. The other go-online checks (commission
 * debt, service area) are unchanged.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/subscriptionService', () => ({
  checkDriverSubscriptionAllowed: jest.fn().mockResolvedValue({
    allowed: false,
    reason: 'No active subscription plan. Purchase a plan to accept deliveries.',
  }),
}));
jest.mock('../../src/services/driverCommissionService', () => ({
  checkCommissionBlock: jest.fn().mockResolvedValue({ blocked: false }),
  getWalletWithDebt: jest.fn(),
}));
jest.mock('../../src/services/operatingHoursService', () => ({ isClosedNow: jest.fn(() => false) }));
jest.mock('../../src/services/s3Service', () => ({}));
jest.mock('../../src/services/autoMatchService', () => ({ autoAssignNearestDriver: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({
  saveDriverPushToken: jest.fn(), sendPushNotification: jest.fn(), reportPushFailure: jest.fn(),
}));
jest.mock('../../src/models/Driver', () => ({
  setOnlineStatus: jest.fn().mockResolvedValue(),
  getAvailableOrders: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
}));

const { checkDriverSubscriptionAllowed } = require('../../src/services/subscriptionService');
const { checkCommissionBlock } = require('../../src/services/driverCommissionService');
const Driver = require('../../src/models/Driver');
const DriverController = require('../../src/controllers/driverController');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// A point inside Nelson Mandela Bay (Gqeberha central).
const IN_AREA = { lat: -33.9608, lng: 25.6022 };

beforeEach(() => jest.clearAllMocks());

describe('decision 6: no paid plan is needed to go online', () => {
  test('a driver with no plan goes online', async () => {
    const res = makeRes();
    await DriverController.setOnlineStatus({ userId: 'driver-1', body: { online: true, ...IN_AREA } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ online: true });
    expect(Driver.setOnlineStatus).toHaveBeenCalledWith('driver-1', true);
    expect(checkDriverSubscriptionAllowed).not.toHaveBeenCalled();
  });

  test('the commission-debt block still applies', async () => {
    checkCommissionBlock.mockResolvedValueOnce({ blocked: true, debtAmount: 250, unpaidDeliveries: 3 });
    const res = makeRes();
    await DriverController.setOnlineStatus({ userId: 'driver-1', body: { online: true, ...IN_AREA } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'COMMISSION_DEBT_BLOCKED' }));
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });

  test('the service-area check still applies', async () => {
    const res = makeRes();
    await DriverController.setOnlineStatus({ userId: 'driver-1', body: { online: true, lat: -26.2041, lng: 28.0473 } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Driver.setOnlineStatus).not.toHaveBeenCalled();
  });
});

describe('decision 6: no paid plan is needed to see available orders', () => {
  test('a driver with no plan gets the order list', async () => {
    const res = makeRes();
    await DriverController.getAvailableOrders({ userId: 'driver-1' }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ orders: [{ id: 'order-1' }] });
    expect(checkDriverSubscriptionAllowed).not.toHaveBeenCalled();
  });

  test('no response ever asks the driver to buy a plan', async () => {
    const res = makeRes();
    await DriverController.getAvailableOrders({ userId: 'driver-1' }, res);
    await DriverController.setOnlineStatus({ userId: 'driver-1', body: { online: true, ...IN_AREA } }, res);
    for (const [body] of res.json.mock.calls) {
      expect(body).not.toHaveProperty('requiresSubscription');
    }
  });
});
