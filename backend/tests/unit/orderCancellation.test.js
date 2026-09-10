'use strict';
/**
 * tests/unit/orderCancellation.test.js
 *
 * Production-readiness audit §2.9 (refund lifecycle) — OrderController.
 * cancelOrder previously computed refundMode/split and credited the
 * driver's wallet from a plain, UNLOCKED read taken before the transaction
 * even opened. Two concurrent cancelOrder calls for the same order (a
 * client retry after its own 20s timeout while the first attempt was still
 * running server-side -- the same reachable shape as the §2.8
 * initializePayment race, since this handler's own duration includes a
 * live Paystack refund submission -- or simply two sessions) could both
 * read the pre-cancellation state and both credit the driver's
 * cancellation compensation.
 *
 * The fix: the order is now looked up via SELECT ... FOR UPDATE as the
 * FIRST statement inside the transaction, and every decision (refundMode,
 * split, the cancellable-stage guard, the wallet credit) is made from that
 * fresh, locked read. These tests exercise that guard directly by
 * controlling exactly what each locked SELECT returns.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService');
jest.mock('../../src/models/DriverWallet');
jest.mock('../../src/services/refundService');

const db = require('../../src/config/database');
const { updateOrderStatus, normalizeState, emitOrderUpdate, notifyOrderStatusChange } = require('../../src/services/orderStateMachineService');
const DriverWallet = require('../../src/models/DriverWallet');
const RefundService = require('../../src/services/refundService');
const OrderController = require('../../src/controllers/orderController');

normalizeState.mockImplementation((s) => s);

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function mockReq(overrides = {}) {
  return {
    params: { orderId: 'order-1' },
    userId: 'user-1',
    body: {},
    app: { get: () => null },
    ...overrides,
  };
}

// Builds a pg client mock whose .query() inspects the SQL text and returns
// whatever `lockedRows` currently holds for the FOR UPDATE lookup -- tests
// can mutate `state.lockedRows` between/during calls to simulate a
// concurrently-committed change becoming visible once the lock is granted.
function makeClient(state) {
  return {
    query: jest.fn(async (sql) => {
      const s = sql.trim();
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (/FROM orders\s+WHERE id = \$1 AND user_id = \$2\s+FOR UPDATE/i.test(s)) {
        return { rows: state.lockedRows };
      }
      if (/INSERT INTO order_cancellations/i.test(s)) {
        return { rows: [{ id: 'cancellation-1' }] };
      }
      if (/INSERT INTO order_cancellation_store_shares/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  normalizeState.mockImplementation((s) => s);
});

describe('OrderController.cancelOrder — locked-read guard (§2.9)', () => {
  test('returns 404 when the order does not exist or is not owned by this user', async () => {
    const state = { lockedRows: [] };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
  });

  test('returns 409 and does not credit anything when already past a cancellable stage', async () => {
    const state = { lockedRows: [{ id: 'order-1', status: 'picked_up', payment_method: 'card', payment_status: 'paid' }] };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toBe('Order cannot be cancelled at this stage');
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('returns 409 with a distinct message when the order is already cancelled', async () => {
    const state = { lockedRows: [{ id: 'order-1', status: 'cancelled', payment_method: 'card', payment_status: 'refunded' }] };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toBe('Order has already been cancelled');
    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
  });

  test('full_refund mode: no driver credit, refunds the full payment', async () => {
    const state = {
      lockedRows: [{
        id: 'order-1', status: 'waiting_for_driver', payment_method: 'card', payment_status: 'paid',
        subtotal: '100.00', delivery_fee: '30.00', driver_id: null,
      }],
    };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'cancelled' });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing', refund_reference: 'ref-1' });

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    expect(DriverWallet.creditAvailable).not.toHaveBeenCalled();
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, refundMode: 'full_refund' }));
  });

  test('pre_pickup_split mode: credits the driver 5% and refunds only the customer share', async () => {
    const state = {
      lockedRows: [{
        id: 'order-1', status: 'driver_assigned', payment_method: 'card', payment_status: 'paid',
        subtotal: '100.00', delivery_fee: '30.00', driver_id: 'driver-1',
        delivery_payment_status: 'assigned', driver_paid: false, driver_payout: '25.00',
      }],
    };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'cancelled' });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing', refund_reference: 'ref-2' });

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    // 5% of R100 subtotal = R5 to the driver; reversePending for the pending payout too.
    expect(DriverWallet.reversePending).toHaveBeenCalledWith(expect.anything(), 'driver-1', 25, 'order-1', 'customer_cancelled');
    expect(DriverWallet.creditAvailable).toHaveBeenCalledWith(
      expect.anything(), 'driver-1', 5, 'order-1', 'pre_pickup_cancellation_compensation',
    );
    // customerItemRefund (95 - store 10%=10 -> 100-10-5=85) + full delivery fee (30) = 115
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation', 115);
  });

  test('store_arrival_split mode: 0% to store, 8% to driver', async () => {
    const state = {
      lockedRows: [{
        id: 'order-1', status: 'driver_arrived_store', payment_method: 'card', payment_status: 'paid',
        subtotal: '100.00', delivery_fee: '30.00', driver_id: 'driver-1',
        delivery_payment_status: 'assigned', driver_paid: false, driver_payout: '25.00',
      }],
    };
    db.connect = jest.fn().mockResolvedValue(makeClient(state));
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'cancelled' });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing', refund_reference: 'ref-3' });

    const res = mockRes();
    await OrderController.cancelOrder(mockReq(), res);

    expect(DriverWallet.creditAvailable).toHaveBeenCalledWith(
      expect.anything(), 'driver-1', 8, 'order-1', 'store_arrival_cancellation_compensation',
    );
    // 92% of 100 = 92 to customer + full 30 delivery fee = 122
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'customer_cancellation', 122);
  });

  // ── Concurrency guard (the actual §2.9 fix) ────────────────────────────────
  test('a second call that only acquires the lock after the first commits sees the fresh state and never double-credits', async () => {
    // Simulates two concurrent cancelOrder calls for the same driver_assigned
    // order: the FIRST call's FOR UPDATE lock is granted immediately (row
    // still driver_assigned); the SECOND call's lock only becomes available
    // AFTER the first has committed -- by which point the row is already
    // 'cancelled'. Modeled here by having the second client's mocked FOR
    // UPDATE query return the POST-commit row directly (exactly what a real
    // row lock would produce once the first transaction releases it).
    const driverAssignedOrder = {
      id: 'order-1', status: 'driver_assigned', payment_method: 'card', payment_status: 'paid',
      subtotal: '100.00', delivery_fee: '30.00', driver_id: 'driver-1',
      delivery_payment_status: 'assigned', driver_paid: false, driver_payout: '25.00',
    };
    const alreadyCancelledOrder = { ...driverAssignedOrder, status: 'cancelled' };

    const firstClientState = { lockedRows: [driverAssignedOrder] };
    const secondClientState = { lockedRows: [alreadyCancelledOrder] };

    let connectCall = 0;
    db.connect = jest.fn(async () => {
      connectCall += 1;
      return makeClient(connectCall === 1 ? firstClientState : secondClientState);
    });
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'cancelled' });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing', refund_reference: 'ref-4' });

    const res1 = mockRes();
    const res2 = mockRes();

    await OrderController.cancelOrder(mockReq(), res1);
    await OrderController.cancelOrder(mockReq(), res2);

    // The first call is the one genuine cancellation: exactly one driver
    // credit, ever, across both calls -- not one per call.
    expect(DriverWallet.creditAvailable).toHaveBeenCalledTimes(1);
    expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // The second call is rejected outright, before touching the wallet.
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json.mock.calls[0][0].error).toBe('Order has already been cancelled');
  });
});
