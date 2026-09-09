'use strict';
/**
 * tests/unit/paymentReconciliationJob.test.js
 *
 * Production-readiness audit §2.9 (refund lifecycle). This file had zero
 * test coverage before this audit -- consistent with how the two bugs
 * fixed here went unnoticed:
 *
 *   1. reconcileMissingRefunds always retried a stuck/missing refund at
 *      the FULL original payment amount, with no idea whether the
 *      original cancellation was a split compensation (driver_assigned/
 *      driver_arrived_store). A failed split-refund attempt got "fixed"
 *      by silently over-refunding the customer the store's/driver's
 *      withheld shares too.
 *   2. A payment_refunds row orphaned at status='processing' with a NULL
 *      refund_reference (a process crash between committing that row and
 *      the Paystack call ever returning) had no reconciliation path at
 *      all -- invisible to both reconcileStuckRefunds (needs a reference
 *      to poll Paystack) and reconcileMissingRefunds (whose retry just
 *      finds the same 'processing' row via refundOrderPayment's own
 *      idempotency short-circuit and returns it unchanged).
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/paystackService');
jest.mock('../../src/services/refundService');

const db = require('../../src/config/database');
const paystackService = require('../../src/services/paystackService');
const RefundService = require('../../src/services/refundService');
const {
  reconcileMissingRefunds,
  reconcileOrphanedProcessingRefunds,
  reconcileStuckRefunds,
} = require('../../src/services/paymentReconciliationJob');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reconcileMissingRefunds — split-aware retry amount (§2.9)', () => {
  test('full_refund mode: retries with no override (full payment amount)', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-1', user_id: 'user-1', refund_mode: 'full_refund', customer_item_refund: '0', delivery_fee_refunded: '0' }],
    });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    await reconcileMissingRefunds();

    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-1', 'user-1', 'reconciliation_retry', null);
  });

  test('pre_pickup_split mode: retries with the stored customer share, not the full amount', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{
        id: 'order-2', user_id: 'user-2', refund_mode: 'pre_pickup_split',
        customer_item_refund: '85.00', delivery_fee_refunded: '30.00',
      }],
    });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    await reconcileMissingRefunds();

    // 85 + 30 = 115, NOT the full original payment.
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-2', 'user-2', 'reconciliation_retry', 115);
  });

  test('store_arrival_split mode: also retries with the stored partial amount', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{
        id: 'order-3', user_id: 'user-3', refund_mode: 'store_arrival_split',
        customer_item_refund: '92.00', delivery_fee_refunded: '30.00',
      }],
    });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    await reconcileMissingRefunds();

    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-3', 'user-3', 'reconciliation_retry', 122);
  });

  test('skips a split order whose customer share is genuinely zero (nothing was ever meant to be refunded)', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{
        id: 'order-4', user_id: 'user-4', refund_mode: 'pre_pickup_split',
        customer_item_refund: '0', delivery_fee_refunded: '0',
      }],
    });

    await reconcileMissingRefunds();

    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
  });

  test('missing order_cancellations row (refund_mode null) falls back to a full refund, the safe default', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'order-5', user_id: 'user-5', refund_mode: null, customer_item_refund: null, delivery_fee_refunded: null }],
    });
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    await reconcileMissingRefunds();

    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('order-5', 'user-5', 'reconciliation_retry', null);
  });

  test('one order failing does not stop the others from being retried', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [
        { id: 'order-6', user_id: 'user-6', refund_mode: 'full_refund', customer_item_refund: '0', delivery_fee_refunded: '0' },
        { id: 'order-7', user_id: 'user-7', refund_mode: 'full_refund', customer_item_refund: '0', delivery_fee_refunded: '0' },
      ],
    });
    RefundService.refundOrderPayment
      .mockRejectedValueOnce(new Error('Paystack down'))
      .mockResolvedValueOnce({ status: 'processing' });

    await reconcileMissingRefunds();

    expect(RefundService.refundOrderPayment).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileOrphanedProcessingRefunds — crash-orphaned refunds (§2.9)', () => {
  test('marks a stale processing refund with no reference as failed', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ id: 'refund-1', order_id: 'order-1' }],
    });

    const result = await reconcileOrphanedProcessingRefunds();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE payment_refunds\s+SET status = 'failed'/),
    );
    expect(result.rows).toEqual([{ id: 'refund-1', order_id: 'order-1' }]);
  });

  test('no-ops cleanly when nothing is orphaned', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(reconcileOrphanedProcessingRefunds()).resolves.not.toThrow();
  });
});

describe('reconcileStuckRefunds — runs the orphan sweep before polling Paystack', () => {
  test('calls the orphan-recovery UPDATE, then polls referenced rows', async () => {
    const calls = [];
    db.query = jest.fn(async (sql) => {
      calls.push(sql.trim());
      if (/UPDATE payment_refunds/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id, refund_reference/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await reconcileStuckRefunds();

    expect(calls[0]).toMatch(/UPDATE payment_refunds/);
    expect(paystackService.fetchRefund).not.toHaveBeenCalled();
  });
});
