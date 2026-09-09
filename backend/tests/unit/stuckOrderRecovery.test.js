'use strict';
/**
 * tests/unit/stuckOrderRecovery.test.js
 *
 * Production-readiness audit §2.10 (stuck-order state machine). Three real
 * gaps found in the order lifecycle's timeout coverage, each with zero
 * automated recovery before this fix:
 *
 *   1. cancelAbandonedPaymentPendingOrders — a customer who abandons
 *      checkout before ever attempting payment leaves the order (and the
 *      real flash_inventory stock Order.create() already decremented for
 *      it) stuck at payment_pending forever. paymentReconciliationJob.
 *      reconcilePendingPayments explicitly excludes this case.
 *   2. cancelStalePreparingOrders — a store accepting an order but never
 *      marking it ready for pickup had no timeout at all.
 *   3. recoverStuckPaidOrders — the paid -> pending_store_acceptance
 *      transition is wrapped in a swallow-all catch at both real call
 *      sites, with nothing anywhere else ever scanning for an order stuck
 *      at status='paid'.
 *
 * These were extracted into named, exported functions specifically so they
 * could be tested like this — the cron bodies in server.js that call them
 * are now thin wrappers with no logic of their own to test.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/refundService');
jest.mock('@sentry/node');

const pool = require('../../src/config/database');
const notificationService = require('../../src/services/notificationService');
const RefundService = require('../../src/services/refundService');
const Sentry = require('@sentry/node');
const {
  cancelAbandonedPaymentPendingOrders,
  cancelStalePreparingOrders,
  recoverStuckPaidOrders,
} = require('../../src/services/orderStateMachineService');

// A client mock generic enough to answer every query updateOrderStatus /
// Order.restockItems issues inside the per-order transaction these
// functions open — mirrors the pattern already established in
// orderStateMachine.test.js and orderCancellation.test.js.
function makeClient(orderRow) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([sql, params]);
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (/SELECT \* FROM orders WHERE id = \$1\s+FOR UPDATE/i.test(s)) {
      return { rows: orderRow ? [{ ...orderRow }] : [] };
    }
    if (/INSERT INTO order_cancellations/i.test(s)) {
      return { rows: [{ id: 'cancellation-1' }] };
    }
    if (/UPDATE orders\b/i.test(s)) {
      return { rows: [{ ...orderRow, status: 'cancelled' }] };
    }
    // order_items lookup inside Order.restockItems — empty means nothing
    // to restock, a harmless no-op for what this file is testing.
    if (/FROM order_items WHERE order_id/i.test(s)) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query, release: jest.fn(), calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  // recoverStuckPaidOrders doesn't pass externalClient, so updateOrderStatus
  // runs its own post-commit notifyOrderStatusChange, which .catch()es this
  // result in the real code — the automock's default undefined return would
  // throw on that chain otherwise.
  notificationService.notifyUserOrderUpdate = jest.fn().mockResolvedValue();
});

describe('cancelAbandonedPaymentPendingOrders', () => {
  test('cancels every candidate order and returns a count', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [
        { id: 'order-1', user_id: 'user-1' },
        { id: 'order-2', user_id: 'user-2' },
      ],
    });
    const client1 = makeClient({ id: 'order-1', status: 'payment_pending', user_id: 'user-1' });
    const client2 = makeClient({ id: 'order-2', status: 'payment_pending', user_id: 'user-2' });
    let connectCall = 0;
    pool.connect = jest.fn(async () => {
      connectCall += 1;
      return connectCall === 1 ? client1 : client2;
    });

    const result = await cancelAbandonedPaymentPendingOrders({ io: null });

    expect(result).toEqual({ cancelled: 2, total: 2 });
    const insertCall1 = client1.calls.find(([sql]) => /INSERT INTO order_cancellations/i.test(sql));
    expect(insertCall1[1]).toEqual(expect.arrayContaining(['order-1']));
    expect(insertCall1[0]).toMatch(/payment_never_initiated_timeout/);
  });

  test('queries only payment_pending orders with no paystack_reference, using the given threshold', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    pool.connect = jest.fn();

    await cancelAbandonedPaymentPendingOrders({ thresholdMinutes: 15 });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'payment_pending'[\s\S]*paystack_reference IS NULL/),
      [15],
    );
  });

  test('defaults to 60 minutes when no threshold is given', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await cancelAbandonedPaymentPendingOrders({});
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [60]);
  });

  test('one order failing does not stop the rest from being cancelled', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-1', user_id: 'user-1' }, { id: 'order-2', user_id: 'user-2' }],
    });
    const badClient = { query: jest.fn().mockRejectedValue(new Error('DB blip')), release: jest.fn() };
    const goodClient = makeClient({ id: 'order-2', status: 'payment_pending', user_id: 'user-2' });
    let connectCall = 0;
    pool.connect = jest.fn(async () => {
      connectCall += 1;
      return connectCall === 1 ? badClient : goodClient;
    });

    const result = await cancelAbandonedPaymentPendingOrders({});

    expect(result).toEqual({ cancelled: 1, total: 2 });
  });
});

describe('cancelStalePreparingOrders', () => {
  test('a paid card order gets a real refund submitted', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-1', user_id: 'user-1', payment_method: 'card', payment_status: 'paid' }],
    });
    pool.connect = jest.fn().mockResolvedValue(
      makeClient({ id: 'order-1', status: 'preparing', user_id: 'user-1' }),
    );
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    const result = await cancelStalePreparingOrders({});

    expect(result).toEqual({ cancelled: 1, total: 1 });
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'store_preparation_timeout');
  });

  test('a cash order (never charged) does not trigger a refund attempt', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-2', user_id: 'user-2', payment_method: 'cash', payment_status: 'pending_cash' }],
    });
    pool.connect = jest.fn().mockResolvedValue(
      makeClient({ id: 'order-2', status: 'preparing', user_id: 'user-2' }),
    );

    await cancelStalePreparingOrders({});

    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
  });

  test('records the store_preparation_timeout reason on the cancellation', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-3', user_id: 'user-3', payment_method: 'cash', payment_status: 'pending' }],
    });
    const client = makeClient({ id: 'order-3', status: 'preparing', user_id: 'user-3' });
    pool.connect = jest.fn().mockResolvedValue(client);

    await cancelStalePreparingOrders({});

    const insertCall = client.calls.find(([sql]) => /INSERT INTO order_cancellations/i.test(sql));
    expect(insertCall[0]).toMatch(/store_preparation_timeout/);
  });

  test('defaults to 30 minutes when no threshold is given', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await cancelStalePreparingOrders({});
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [30]);
  });
});

describe('recoverStuckPaidOrders', () => {
  test('successfully advances a stuck order to pending_store_acceptance', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'order-1' }] });
    pool.connect = jest.fn().mockResolvedValue(
      makeClient({ id: 'order-1', status: 'paid', user_id: 'user-1' }),
    );

    const result = await recoverStuckPaidOrders({});

    expect(result).toEqual({ recovered: 1, total: 1 });
  });

  test('reports to Sentry (not silently) when the retry itself fails', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'order-1' }] });
    const badClient = { query: jest.fn().mockRejectedValue(new Error('still broken')), release: jest.fn() };
    pool.connect = jest.fn().mockResolvedValue(badClient);

    const result = await recoverStuckPaidOrders({});

    expect(result).toEqual({ recovered: 0, total: 1 });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('order-1') }),
    );
  });

  test('defaults to 10 minutes when no threshold is given', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await recoverStuckPaidOrders({});
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [10]);
  });
});
