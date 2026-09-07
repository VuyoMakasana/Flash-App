'use strict';
/**
 * tests/unit/orderController.test.js
 *
 * OrderController.updateOrderStatus — the generic driver status-update
 * endpoint. Covers the production-readiness audit's §2.4 fix: this
 * endpoint already blocked a driver from reaching 'completed' directly
 * (bypassing the delivery-confirmation OTP), but had no equivalent block
 * for 'picked_up' or 'delivered' — both real ALLOWED_TRANSITIONS targets
 * that are supposed to require a real photo first
 * (submitPickupPhoto/submitDropoffPhoto). Confirmed live that calling
 * this endpoint directly with either status skipped the photo entirely.
 */

jest.mock('../../src/models/Order');
jest.mock('../../src/services/orderStateMachineService');

const Order = require('../../src/models/Order');
const { updateOrderStatus, normalizeState } = require('../../src/services/orderStateMachineService');
const OrderController = require('../../src/controllers/orderController');

normalizeState.mockImplementation((s) => s);

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function baseOrder(overrides = {}) {
  return { id: 'order-1', driver_id: 'driver-1', is_return_order: false, ...overrides };
}

describe('OrderController.updateOrderStatus — photo-gate bypass block (§2.4)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('blocks a driver from setting picked_up directly (bypassing the pickup photo)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder());
    const req = { params: { orderId: 'order-1' }, body: { status: 'picked_up' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toMatch(/photo capture/i);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('blocks a driver from setting delivered directly (bypassing the dropoff photo)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder());
    const req = { params: { orderId: 'order-1' }, body: { status: 'delivered' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toMatch(/photo capture/i);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('blocks delivered even for a return order (no OTP exception applies here)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder({ is_return_order: true }));
    const req = { params: { orderId: 'order-1' }, body: { status: 'delivered' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('still blocks completed for a non-return order (regression, pre-existing behavior)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder());
    const req = { params: { orderId: 'order-1' }, body: { status: 'completed' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toMatch(/OTP/i);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('still allows completed for a return order (regression, pre-existing exception)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder({ is_return_order: true }));
    updateOrderStatus.mockResolvedValue({ status: 'completed' });
    const req = { params: { orderId: 'order-1' }, body: { status: 'completed' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(updateOrderStatus).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, status: 'completed' });
  });

  test('still allows a legitimate transition (driver_arrived_store) through this endpoint', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder());
    updateOrderStatus.mockResolvedValue({ status: 'driver_arrived_store' });
    const req = { params: { orderId: 'order-1' }, body: { status: 'driver_arrived_store' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(updateOrderStatus).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  test('still returns 403 for a driver who does not own the order (regression)', async () => {
    Order.getByIdWithDetails.mockResolvedValue(baseOrder({ driver_id: 'someone-else' }));
    const req = { params: { orderId: 'order-1' }, body: { status: 'delivered' }, userId: 'driver-1', app: { get: () => null } };
    const res = mockRes();

    await OrderController.updateOrderStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
