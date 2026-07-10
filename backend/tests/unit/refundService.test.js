'use strict';
/**
 * tests/unit/refundService.test.js
 *
 * Regression baseline for RefundService.refundOrderPayment(), written
 * BEFORE that function is extended to accept an optional partial-amount
 * parameter for the returns feature. Every assertion here pins down its
 * CURRENT full-amount behavior (existing caller: orderController's
 * cancellation-refund path, which never passes an amount override) so that
 * after the partial-amount extension lands, re-running this file unchanged
 * proves the existing cancellation-refund path is byte-for-byte identical —
 * no silent behavior change to a flow this file did not touch.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/paystackService');

const db = require('../../src/config/database');
const paystackService = require('../../src/services/paystackService');
const RefundService = require('../../src/services/refundService');

const ORDER_ID = 'order-uuid-001';
const USER_ID  = 'user-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const PROVIDER_TXN_ID = 'txn-provider-001';

// Builds a pg client mock whose .query() inspects the SQL text, matching
// the same pattern already used in orderStateMachine.test.js — mirrors how
// one real client is shared through refundOrderPayment's own transaction.
function makeClient({ order, existingRefund = null, payment } = {}) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([sql, params]);
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (/FROM orders\s+WHERE id = \$1\s+FOR UPDATE/i.test(s)) {
      return { rows: order ? [order] : [] };
    }
    if (/FROM payment_refunds\s+WHERE order_id = \$1/i.test(s)) {
      return { rows: existingRefund ? [existingRefund] : [] };
    }
    if (/FROM payments\s+WHERE order_id = \$1/i.test(s)) {
      return { rows: payment ? [payment] : [] };
    }
    if (/INSERT INTO payment_refunds/i.test(s)) {
      return {
        rows: [{
          id: 'refund-uuid-001',
          order_id: params[0],
          user_id: params[1],
          payment_id: params[2],
          amount: params[3],
          provider: params[4],
          status: 'processing',
          reason: params[5],
        }],
      };
    }
    return { rows: [] };
  });
  return { query, release: jest.fn(), calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn().mockResolvedValue({ rows: [{ id: 'refund-uuid-001', status: 'processing' }] });
});

describe('RefundService.refundOrderPayment — full-refund baseline (pre partial-amount extension)', () => {
  const order = {
    id: ORDER_ID,
    user_id: USER_ID,
    payment_method: 'card',
    payment_status: 'paid',
    total: '250.00',
  };
  const payment = {
    id: PAYMENT_ID,
    provider: 'paystack',
    provider_transaction_id: PROVIDER_TXN_ID,
    amount: '250.00',
  };

  test('refunds the full payment amount to Paystack — no partial amount involved', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);
    paystackService.refundTransaction = jest.fn().mockResolvedValue({
      status: true,
      data: { id: 999 },
    });

    await RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'customer_cancellation');

    // The full payment amount (R250.00 -> 25000 cents), not any reduced figure.
    expect(paystackService.refundTransaction).toHaveBeenCalledWith(
      PROVIDER_TXN_ID,
      25000,
      'customer_cancellation',
    );
  });

  test('rejects when caller is not the order owner', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);

    await expect(RefundService.refundOrderPayment(ORDER_ID, 'someone-else', 'x'))
      .rejects.toThrow('Not your order');
  });

  test('returns the existing refund unchanged if one is already processing/completed (idempotent)', async () => {
    const existingRefund = { id: 'refund-uuid-existing', status: 'processing' };
    const client = makeClient({ order, existingRefund });
    db.connect = jest.fn().mockResolvedValue(client);

    const result = await RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'x');

    expect(result).toEqual(existingRefund);
    // Must not have attempted a second Paystack call for an already-refunding order.
    expect(paystackService.refundTransaction).not.toHaveBeenCalled();
  });

  test('rejects non-card payment methods', async () => {
    const cashOrder = { ...order, payment_method: 'cash' };
    const client = makeClient({ order: cashOrder, payment });
    db.connect = jest.fn().mockResolvedValue(client);

    await expect(RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'x'))
      .rejects.toThrow('Order payment method does not support automated refund');
  });

  test('rejects an order that is not in a refundable paid state', async () => {
    const unpaidOrder = { ...order, payment_status: 'pending' };
    const client = makeClient({ order: unpaidOrder, payment });
    db.connect = jest.fn().mockResolvedValue(client);

    await expect(RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'x'))
      .rejects.toThrow('Order is not in a refundable paid state');
  });

  test('marks the refund failed and rethrows if the provider call fails', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);
    paystackService.refundTransaction = jest.fn().mockResolvedValue({
      status: false,
      message: 'Provider rejected the refund',
    });

    await expect(RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'x'))
      .rejects.toThrow('Provider rejected the refund');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE payment_refunds\s+SET status = 'failed'/),
      expect.arrayContaining(['refund-uuid-001']),
    );
  });
});

describe('RefundService.refundOrderPayment — overrideAmount (returns feature)', () => {
  const order = {
    id: ORDER_ID,
    user_id: USER_ID,
    payment_method: 'card',
    payment_status: 'paid',
    total: '250.00',
  };
  const payment = {
    id: PAYMENT_ID,
    provider: 'paystack',
    provider_transaction_id: PROVIDER_TXN_ID,
    amount: '250.00',
  };

  test('refunds only the override amount when one is supplied (fee already netted out)', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);
    paystackService.refundTransaction = jest.fn().mockResolvedValue({
      status: true,
      data: { id: 1000 },
    });

    // R250 subtotal - R100 return fee = R150 net refund
    await RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'return_refund', 150.0);

    expect(paystackService.refundTransaction).toHaveBeenCalledWith(
      PROVIDER_TXN_ID,
      15000,
      'return_refund',
    );

    const insertCall = client.calls.find(([sql]) => /INSERT INTO payment_refunds/i.test(sql));
    expect(insertCall[1]).toContain(150);
  });

  test('rejects an override amount greater than what was actually paid', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);

    await expect(RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'return_refund', 999))
      .rejects.toThrow('Invalid refund amount');

    expect(paystackService.refundTransaction).not.toHaveBeenCalled();
  });

  test('rejects a zero or negative override amount', async () => {
    const client = makeClient({ order, payment });
    db.connect = jest.fn().mockResolvedValue(client);

    await expect(RefundService.refundOrderPayment(ORDER_ID, USER_ID, 'return_refund', 0))
      .rejects.toThrow('Invalid refund amount');
  });
});
