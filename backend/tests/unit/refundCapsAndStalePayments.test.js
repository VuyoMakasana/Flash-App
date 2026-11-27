'use strict';
/**
 * tests/unit/refundCapsAndStalePayments.test.js
 *
 * Step 1 (#102), founder rules:
 *   1. a stale pending payment is cancelled ONLY on a definite Paystack
 *      answer, and its items are restocked once;
 *   2. (orderChargeService: see unrecordedCharges.test.js) a late
 *      charge.success on a cancelled order is refunded in full, alerted;
 *   3. refunds stop after 3 failures, with an admin alert and a manual retry.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService', () => ({
  updateOrderStatus: jest.fn().mockResolvedValue({}),
  notifyAdminNewOrderPendingAcceptance: jest.fn(),
}));
jest.mock('../../src/services/emailService', () => ({ sendPaymentAlertEmail: jest.fn().mockResolvedValue() }));
jest.mock('../../src/models/Order', () => ({ restockItems: jest.fn().mockResolvedValue() }));

const pool = require('../../src/config/database');
const { updateOrderStatus } = require('../../src/services/orderStateMachineService');
const { sendPaymentAlertEmail } = require('../../src/services/emailService');
const Order = require('../../src/models/Order');
const paystackService = require('../../src/services/paystackService');
const RefundService = require('../../src/services/refundService');
const WebhookController = require('../../src/controllers/webhookController');
const {
  cancelStalePendingPayments, reconcileMissingRefunds, reconcileStrayRefunds, manualRetryOrderRefund,
} = require('../../src/services/paymentReconciliationJob');

const REF = 'flash_order-1_abc';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── 1. Stale pending payments ─────────────────────────────────────────────
describe('fetchTransactionStatus: only Paystack\'s own final answer is definite', () => {
  test.each([
    ['success', true], ['failed', true], ['abandoned', true], ['reversed', true],
    ['ongoing', false], ['pending', false], ['processing', false], ['queued', false],
  ])('status %s → definite %s', async (status, definite) => {
    jest.spyOn(paystackService, 'request').mockResolvedValue({ status: true, data: { status, id: 1 } });
    expect((await paystackService.fetchTransactionStatus(REF)).definite).toBe(definite);
  });

  test('a network error or timeout is not definite', async () => {
    jest.spyOn(paystackService, 'request').mockRejectedValue(new Error('Paystack API request timeout'));
    expect(await paystackService.fetchTransactionStatus(REF)).toEqual(expect.objectContaining({ definite: false, status: null }));
  });

  test('Paystack answering status:false (e.g. reference not found) is not definite', async () => {
    jest.spyOn(paystackService, 'request').mockResolvedValue({ status: false, message: 'Transaction reference not found' });
    expect((await paystackService.fetchTransactionStatus(REF)).definite).toBe(false);
  });
});

describe('cancelStalePendingPayments', () => {
  const stale = { id: 'order-1', user_id: 'user-1', paystack_reference: REF };

  function setupLock(lockedRow) {
    const calls = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        calls.push([String(sql), params]);
        if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(String(sql))) return { rows: lockedRow ? [lockedRow] : [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect = jest.fn().mockResolvedValue(client);
    pool.query = jest.fn().mockResolvedValueOnce({ rows: [stale] }).mockResolvedValue({ rows: [] });
    return calls;
  }

  const lockedUnpaid = { status: 'payment_pending', payment_status: 'pending', paystack_reference: REF };

  test('only looks at unpaid card orders older than 60 minutes', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await cancelStalePendingPayments(null);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('created', 'payment_pending'\)/);
    expect(sql).toMatch(/payment_status IN \('pending', 'failed'\)/);
    expect(sql).toMatch(/paystack_reference IS NOT NULL/);
    expect(params).toEqual([60]);
  });

  test.each(['failed', 'abandoned', 'reversed'])('Paystack says %s: cancelled through the state machine (which restocks once)', async (status) => {
    const calls = setupLock(lockedUnpaid);
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockResolvedValue({ definite: true, status });
    const result = await cancelStalePendingPayments(null);
    expect(result).toEqual({ cancelled: 1 });
    expect(calls.some(([s]) => /INSERT INTO order_cancellations/.test(s))).toBe(true);
    expect(updateOrderStatus).toHaveBeenCalledTimes(1);
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'cancelled', expect.objectContaining({ externalClient: expect.any(Object) }));
  });

  test.each([
    ['a network error', { definite: false, status: null, error: 'timeout' }],
    ['an in-flight status', { definite: false, status: 'ongoing' }],
    ['a success (reconcilePendingPayments records it)', { definite: true, status: 'success' }],
  ])('%s: NOT cancelled', async (_label, answer) => {
    setupLock(lockedUnpaid);
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockResolvedValue(answer);
    const result = await cancelStalePendingPayments(null);
    expect(result).toEqual({ cancelled: 0 });
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test.each([
    ['it was paid meanwhile', { ...lockedUnpaid, payment_status: 'paid' }],
    ['a newer payment page was opened', { ...lockedUnpaid, paystack_reference: 'flash_order-1_newer' }],
    ['it was already cancelled', { ...lockedUnpaid, status: 'cancelled' }],
  ])('re-checked under the lock: NOT cancelled if %s', async (_label, locked) => {
    setupLock(locked);
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockResolvedValue({ definite: true, status: 'abandoned' });
    expect(await cancelStalePendingPayments(null)).toEqual({ cancelled: 0 });
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });
});

describe('restock once: a failed card attempt no longer restocks', () => {
  test('charge.failed marks the payment failed but leaves the stock reserved', async () => {
    const calls = [];
    const client = {
      query: jest.fn(async (sql) => {
        calls.push(String(sql));
        if (/SELECT paystack_reference, payment_status FROM orders/.test(String(sql))) {
          return { rows: [{ paystack_reference: REF, payment_status: 'pending' }] };
        }
        if (/SET payment_status = 'failed'/.test(String(sql))) return { rows: [{ id: 'order-1' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect = jest.fn().mockResolvedValue(client);
    pool.query = jest.fn().mockResolvedValue({ rows: [{ user_id: 'user-1' }] });
    await WebhookController.handleChargeFailed({
      id: 77, event: 'charge.failed', data: { reference: REF, metadata: { orderId: 'order-1' } },
    }, null);
    expect(calls.some((s) => /SET payment_status = 'failed'/.test(s))).toBe(true);
    expect(Order.restockItems).not.toHaveBeenCalled();
  });
});

// ─── 3. Refund attempt cap ────────────────────────────────────────────────
function refundClient({ order, failedCount = 0, payment = { id: 'pay-1', provider: 'paystack', provider_transaction_id: '555', amount: '180.00' } }) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql); calls.push([s, params]);
      if (/FROM orders\s+WHERE id = \$1\s+FOR UPDATE/.test(s)) return { rows: [order] };
      if (/status IN \('processing', 'completed'\)/.test(s)) return { rows: [] };
      if (/COUNT\(\*\)::int AS n/.test(s)) return { rows: [{ n: failedCount }] };
      if (/FROM payments\s+WHERE order_id/.test(s)) return { rows: [payment] };
      if (/INSERT INTO payment_refunds/.test(s)) return { rows: [{ id: 'ref-1', amount: '180.00' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect = jest.fn().mockResolvedValue(client);
  return { calls, client };
}

describe('refunds stop after 3 automatic failures', () => {
  const paidCancelled = { id: 'order-1', user_id: 'user-1', payment_method: 'card', payment_status: 'paid', total: '180.00' };

  test('the limit is 3', () => {
    expect(RefundService.MAX_AUTOMATIC_REFUND_ATTEMPTS).toBe(3);
  });

  test('after 3 failures an automatic retry is refused without calling Paystack', async () => {
    refundClient({ order: paidCancelled, failedCount: 3 });
    const spy = jest.spyOn(paystackService, 'refundTransaction');
    await expect(RefundService.refundOrderPayment('order-1', 'user-1', 'reconciliation_retry'))
      .rejects.toMatchObject({ code: 'REFUND_RETRY_CAP_REACHED' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a manual retry goes ahead past the limit', async () => {
    refundClient({ order: paidCancelled, failedCount: 5 });
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'ref-1', status: 'processing' }] });
    const spy = jest.spyOn(paystackService, 'refundTransaction').mockResolvedValue({ status: true, data: { id: 9 } });
    await RefundService.refundOrderPayment('order-1', 'user-1', 'admin_manual_retry', null, { manual: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('an order whose refund Paystack declined (refund_failed) can be retried', async () => {
    refundClient({ order: { ...paidCancelled, payment_status: 'refund_failed' }, failedCount: 1 });
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'ref-1' }] });
    const spy = jest.spyOn(paystackService, 'refundTransaction').mockResolvedValue({ status: true, data: { id: 9 } });
    await RefundService.refundOrderPayment('order-1', 'user-1', 'reconciliation_retry');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('the 3rd failure alerts an admin; the 2nd does not', async () => {
    pool.query = jest.fn().mockResolvedValueOnce({ rows: [{ n: 2 }] });
    expect(await RefundService.alertIfRefundRetriesExhausted({ orderId: 'order-1', amount: 180 })).toBe(false);
    expect(sendPaymentAlertEmail).not.toHaveBeenCalled();

    pool.query = jest.fn().mockResolvedValueOnce({ rows: [{ n: 3 }] });
    expect(await RefundService.alertIfRefundRetriesExhausted({ orderId: 'order-1', amount: 180 })).toBe(true);
    expect(sendPaymentAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      title: 'A refund keeps failing', orderId: 'order-1',
    }));
  });

  test('a failed Paystack call records the failure, then checks whether to alert', async () => {
    refundClient({ order: paidCancelled, failedCount: 2 });
    pool.query = jest.fn(async (sql) => (/COUNT/.test(String(sql)) ? { rows: [{ n: 3 }] } : { rows: [] }));
    jest.spyOn(paystackService, 'refundTransaction').mockRejectedValue(new Error('Paystack down'));
    await expect(RefundService.refundOrderPayment('order-1', 'user-1', 'reconciliation_retry')).rejects.toThrow('Paystack down');
    expect(pool.query.mock.calls.some(([s]) => /SET status = 'failed'/.test(String(s)))).toBe(true);
    expect(sendPaymentAlertEmail).toHaveBeenCalled();
  });

  test('the retry job skips orders at the limit and includes refund_failed orders', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await reconcileMissingRefunds(null);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/payment_status IN \('paid', 'refund_failed'\)/);
    expect(sql).toMatch(/status = 'failed'[\s\S]*\) < \$1/);
    expect(params).toEqual([3]);
  });

  test('the stray-refund retry job uses the same limit', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'pay-stray-1' }] });
    const spy = jest.spyOn(RefundService, 'refundStrayPayment').mockResolvedValue({});
    await reconcileStrayRefunds();
    expect(pool.query.mock.calls[0][1]).toEqual(['stray', 3]);
    expect(spy).toHaveBeenCalledWith('pay-stray-1');
  });

  test('the admin manual retry passes manual: true', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'order-1', user_id: 'user-1', refund_mode: 'full_refund' }] });
    const spy = jest.spyOn(RefundService, 'refundOrderPayment').mockResolvedValue({});
    await manualRetryOrderRefund('order-1');
    expect(spy).toHaveBeenCalledWith('order-1', 'user-1', 'admin_manual_retry', null, { manual: true });
  });
});

describe('a stray charge\'s refund never changes the order', () => {
  test('finalizeRefund marks the payment stray_refunded and leaves orders alone', async () => {
    const calls = [];
    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql); calls.push(s);
        if (/FROM payment_refunds pr/.test(s)) {
          return { rows: [{ id: 'ref-1', order_id: 'order-1', status: 'processing', amount: '180.00', payment_id: 'pay-stray-1', payment_status: 'stray' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect = jest.fn().mockResolvedValue(client);
    const result = await RefundService.finalizeRefund('9', null, 'completed', {});
    expect(result).toEqual({ orderId: 'order-1', alreadyFinalized: false, stray: true });
    expect(calls.some((s) => /UPDATE payments SET status = 'stray_refunded'/.test(s))).toBe(true);
    expect(calls.some((s) => /UPDATE orders/.test(s))).toBe(false);
    // Postgres refuses FOR UPDATE on the nullable side of a LEFT JOIN.
    expect(calls.find((s) => /FROM payment_refunds pr/.test(s))).toMatch(/FOR UPDATE OF pr/);
  });

  test('an order refund still updates the order', async () => {
    const calls = [];
    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql); calls.push(s);
        if (/FROM payment_refunds pr/.test(s)) {
          return { rows: [{ id: 'ref-1', order_id: 'order-1', status: 'processing', amount: '180.00', payment_id: 'pay-1', payment_status: 'paid' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect = jest.fn().mockResolvedValue(client);
    await RefundService.finalizeRefund('9', null, 'completed', {});
    expect(calls.some((s) => /UPDATE orders SET payment_status/.test(s))).toBe(true);
  });
});
