'use strict';
/**
 * tests/unit/cancellationTermsA9.test.js
 *
 * PR G1 (#106): customer cancellation follows the live Terms, A9
 * (flashdelivery.co.za/terms, read 2026-11-27), with the founder's two
 * decisions of 2026-11-27:
 *   - before the store accepts, AND while the store is still preparing:
 *     full refund (items + delivery fee). The charge starts only once the
 *     order is marked ready;
 *   - ready, before the driver collects: the full delivery fee plus the items
 *     less a charge of up to 15% of the item value: 10% to the store, plus
 *     5% to the driver only once a driver is assigned;
 *   - after collection: no cancellation.
 * Every stage is tested through cancelOrder AND the read-only preview, which
 * must always agree.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService');
jest.mock('../../src/models/DriverWallet');
jest.mock('../../src/services/refundService');

const db = require('../../src/config/database');
const { updateOrderStatus, normalizeState } = require('../../src/services/orderStateMachineService');
const DriverWallet = require('../../src/models/DriverWallet');
const RefundService = require('../../src/services/refundService');
const OrderController = require('../../src/controllers/orderController');
const { cancellationTermsFor, STORE_CHARGE_PCT, DRIVER_CHARGE_PCT } = require('../../src/services/cancellationPolicy');

const base = {
  id: 'order-1', user_id: 'user-1', payment_method: 'card', payment_status: 'paid',
  subtotal: '100.00', delivery_fee: '30.00', store_id: 'store-1',
  delivery_payment_status: 'pending_driver', driver_paid: false, driver_payout: '25.00',
};
const withDriver = { driver_id: 'driver-1', delivery_payment_status: 'assigned' };

function mockRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
function mockReq() { return { params: { orderId: 'order-1' }, userId: 'user-1', body: {}, app: { get: () => null } }; }

function useOrder(order) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql).trim();
      calls.push([s, params]);
      if (/FROM orders\s+WHERE id = \$1 AND user_id = \$2\s+FOR UPDATE/i.test(s)) return { rows: [{ ...order }] };
      if (/INSERT INTO order_cancellations/i.test(s)) return { rows: [{ id: 'cancellation-1' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect = jest.fn().mockResolvedValue(client);
  db.query = jest.fn(async () => ({ rows: [{ ...order }] })); // the preview's plain SELECT
  updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'cancelled' });
  RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing', refund_reference: 'r' });
  return calls;
}

beforeEach(() => {
  jest.clearAllMocks();
  normalizeState.mockImplementation((s) => s);
});

describe('the policy constants match Terms A9 and the kept 10% / 5% split', () => {
  test('10% store, 5% driver, so at most 15%', () => {
    expect(STORE_CHARGE_PCT).toBe(0.10);
    expect(DRIVER_CHARGE_PCT).toBe(0.05);
    expect(STORE_CHARGE_PCT + DRIVER_CHARGE_PCT).toBeCloseTo(0.15);
  });
});

describe('full refund: before the store accepts, and while it is still preparing', () => {
  test.each(['created', 'payment_pending', 'paid', 'scheduled_for_morning', 'pending_store_acceptance', 'preparing'])(
    '%s: the whole payment comes back, nobody is paid compensation',
    async (status) => {
      const calls = useOrder({ ...base, status });
      const res = mockRes();
      await OrderController.cancelOrder(mockReq(), res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, refundMode: 'full_refund' }));
      // No amount passed: refundOrderPayment refunds the full payment.
      expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation');
      expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
      expect(calls.some(([s]) => /order_cancellation_store_shares/.test(s))).toBe(false);

      const preview = mockRes();
      await OrderController.getCancellationPreview({ params: { orderId: 'order-1' }, userId: 'user-1' }, preview);
      expect(preview.json).toHaveBeenCalledWith(expect.objectContaining({ fullRefund: true, chargePct: 0 }));
    },
  );
});

describe('ready, no driver yet (waiting_for_driver): 10% charge to the store', () => {
  test('the delivery fee and 90% of the items come back; the store share is recorded', async () => {
    const calls = useOrder({ ...base, status: 'waiting_for_driver', driver_id: null });
    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    // 100 - 10 (store) + 30 delivery fee = 120
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation', 120);
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
    const share = calls.find(([s]) => /INSERT INTO order_cancellation_store_shares/.test(s));
    expect(share[1]).toEqual(['cancellation-1', 'store-1', 10]);
    const cancellation = calls.find(([s]) => /INSERT INTO order_cancellations/.test(s));
    // refund_mode, item value, store, driver, customer item refund, delivery fee refunded
    expect(cancellation[1].slice(3)).toEqual(['pre_pickup_split', 100, 10, 0, 90, 30]);

    const preview = mockRes();
    await OrderController.getCancellationPreview({ params: { orderId: 'order-1' }, userId: 'user-1' }, preview);
    expect(preview.json).toHaveBeenCalledWith(expect.objectContaining({
      fullRefund: false, hasDriverAssigned: false, storePct: 0.10, driverPct: 0, chargePct: 0.10,
      storeAmount: 10, driverAmount: 0, customerItemRefund: 90, deliveryFeeRefund: 30, totalCustomerRefund: 120,
    }));
  });
});

describe('ready, driver assigned or at the store: 15% charge (10% store, 5% driver)', () => {
  test.each(['driver_assigned', 'driver_arrived_store'])('%s: delivery fee + 85% of the items back, driver paid 5%', async (status) => {
    const calls = useOrder({ ...base, ...withDriver, status });
    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    // 100 - 10 - 5 + 30 = 115
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation', 115);
    expect(DriverWallet.reversePending).toHaveBeenCalledWith(expect.anything(), 'driver-1', 25, 'order-1', 'customer_cancelled');
    expect(DriverWallet.creditAvailable).toHaveBeenCalledWith(
      expect.anything(), 'driver-1', 5, 'order-1', 'pre_pickup_cancellation_compensation',
    );
    expect(calls.find(([s]) => /order_cancellation_store_shares/.test(s))[1][2]).toBe(10);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ refundMode: 'pre_pickup_split' }));

    const preview = mockRes();
    await OrderController.getCancellationPreview({ params: { orderId: 'order-1' }, userId: 'user-1' }, preview);
    expect(preview.json).toHaveBeenCalledWith(expect.objectContaining({
      fullRefund: false, hasDriverAssigned: true, storePct: 0.10, driverPct: 0.05, chargePct: 0.15,
      storeAmount: 10, driverAmount: 5, totalCustomerRefund: 115,
    }));
  });

  test('the charge never exceeds 15% of the item value, and the three shares add up exactly', () => {
    for (const subtotal of ['0.01', '33.33', '99.99', '149.95', '1234.57']) {
      const { split } = cancellationTermsFor({ ...base, ...withDriver, status: 'driver_assigned', subtotal });
      const items = parseFloat(subtotal);
      expect(split.storeAmount + split.driverAmount).toBeLessThanOrEqual(Math.round(items * 0.15 * 100) / 100 + 0.01);
      expect(Math.round((split.storeAmount + split.driverAmount + split.customerItemRefund) * 100)).toBe(Math.round(items * 100));
    }
  });

  test('a cash order: nothing was collected, so nothing is refunded or kept; the driver is still compensated 5%', async () => {
    useOrder({ ...base, ...withDriver, status: 'driver_assigned', payment_method: 'cash', payment_status: 'pending_cash' });
    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
    expect(DriverWallet.creditAvailable).toHaveBeenCalledWith(expect.anything(), 'driver-1', 5, 'order-1', 'pre_pickup_cancellation_compensation');
  });
});

describe('after the driver collects: no cancellation', () => {
  test.each(['picked_up', 'in_transit', 'delivered', 'completed'])('%s: refused (409), nothing changes', async (status) => {
    useOrder({ ...base, ...withDriver, status });
    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();

    const preview = mockRes();
    await OrderController.getCancellationPreview({ params: { orderId: 'order-1' }, userId: 'user-1' }, preview);
    expect(preview.status).toHaveBeenCalledWith(409);
  });
});

// PR G1 (#106), found in review: the customer is shown the preview, then the
// order moves on (the store marks it ready, or a driver is assigned) before
// they confirm. The app sends the charge it showed; if it no longer matches,
// nothing is written and the new preview comes back for a fresh confirm.
describe('the charge the customer saw must still be the charge', () => {
  const reqWith = (body) => ({ ...mockReq(), body });

  test('shown "full refund" (0%), but the order is now ready: refused (409), nothing written', async () => {
    const calls = useOrder({ ...base, status: 'waiting_for_driver', driver_id: null });
    const res = mockRes();
    await OrderController.cancelOrder(reqWith({ expectedChargePct: 0 }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CANCELLATION_TERMS_CHANGED',
      preview: expect.objectContaining({ fullRefund: false, chargePct: 0.10, totalCustomerRefund: 120 }),
    }));
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
    expect(DriverWallet.reversePending).not.toHaveBeenCalled();
    expect(calls.some(([s]) => /INSERT INTO order_cancellations/.test(s))).toBe(false);
    expect(calls.some(([s]) => /^ROLLBACK/.test(s))).toBe(true);
  });

  test('shown 10%, but a driver has since been assigned (15%): refused', async () => {
    useOrder({ ...base, ...withDriver, status: 'driver_assigned' });
    const res = mockRes();
    await OrderController.cancelOrder(reqWith({ expectedChargePct: 0.10 }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
  });

  test('the charge shown still applies: cancelled as usual', async () => {
    useOrder({ ...base, ...withDriver, status: 'driver_assigned' });
    const res = mockRes();
    await OrderController.cancelOrder(reqWith({ expectedChargePct: 0.15 }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, refundMode: 'pre_pickup_split' }));
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation', 115);
  });

  test('an older app that sends no expected charge is unaffected', async () => {
    useOrder({ ...base, status: 'waiting_for_driver', driver_id: null });
    const res = mockRes();
    await OrderController.cancelOrder(reqWith({ reason: 'changed my mind' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
