'use strict';
/**
 * tests/unit/unrecordedCharges.test.js
 *
 * Step 1 (#102), founder rule: a successful Paystack charge for an order is
 * ALWAYS recorded against the order or refunded automatically. Never a
 * charge with nothing recorded (audit P0-3).
 *
 * The bug: charge.success only updated the order WHERE paystack_reference =
 * the charge's reference. After 2 minutes a second tap on Pay stores a new
 * reference, so paying the OLDER Paystack page matched nothing: rollback, no
 * log, 200 to Paystack (so no retry), customer charged, nothing recorded.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService', () => ({
  updateOrderStatus: jest.fn().mockResolvedValue({ id: 'order-1', user_id: 'user-1' }),
  notifyAdminNewOrderPendingAcceptance: jest.fn(),
}));
jest.mock('../../src/services/operatingHoursService', () => ({ isClosedNow: jest.fn(() => false), getNextOpenTime: jest.fn() }));
jest.mock('../../src/models/Payment', () => ({ saveCard: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/emailService', () => ({ sendPaymentAlertEmail: jest.fn().mockResolvedValue() }));

const pool = require('../../src/config/database');
const { sendPaymentAlertEmail } = require('../../src/services/emailService');
const { updateOrderStatus } = require('../../src/services/orderStateMachineService');
const WebhookController = require('../../src/controllers/webhookController');
const RefundService = require('../../src/services/refundService');
const { applyOrderCharge, referenceBelongsToOrder } = require('../../src/services/orderChargeService');

const OLD_REF = 'flash_order-1_old0000000000000';
const NEW_REF = 'flash_order-1_new1111111111111';

// A fake transaction client. `state` drives what the SQL returns.
function setup({ order, seenTransaction = false, duplicateEvent = false }) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      calls.push([s, params]);
      if (/INSERT INTO webhook_events/.test(s) && duplicateEvent) {
        const e = new Error('duplicate'); e.code = '23505'; throw e;
      }
      if (/SELECT 1 FROM payments WHERE provider_transaction_id/.test(s)) return { rows: seenTransaction ? [{ 1: 1 }] : [] };
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: order ? [{ ...order }] : [] };
      if (/INSERT INTO payments[\s\S]*RETURNING id/.test(s)) return { rows: [{ id: 'pay-stray-1' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect = jest.fn().mockResolvedValue(client);
  pool.query = jest.fn().mockResolvedValue({ rows: [] });
  return calls;
}

const sqlMatching = (calls, re) => calls.filter(([s]) => re.test(s));
const charge = (over = {}) => ({ orderId: 'order-1', reference: OLD_REF, transactionId: 555, amount: 18000, currency: 'ZAR', ...over });
const unpaid = { id: 'order-1', user_id: 'user-1', status: 'payment_pending', payment_status: 'pending', total: '180.00', paystack_reference: NEW_REF };

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(RefundService, 'refundStrayPayment').mockResolvedValue({ status: 'processing' });
});
afterEach(() => jest.restoreAllMocks());

describe('the audit P0-3 case: an OLDER Paystack page is paid', () => {
  test('the order is marked paid against the reference that was actually paid', async () => {
    const calls = setup({ order: unpaid });
    const result = await applyOrderCharge(charge());
    expect(result).toEqual({ outcome: 'paid', userId: 'user-1' });
    const [update] = sqlMatching(calls, /SET payment_status = 'paid'/);
    expect(update[1]).toEqual(['order-1', OLD_REF]); // paystack_reference becomes the paid one
    const [paymentInsert] = sqlMatching(calls, /INSERT INTO payments/);
    expect(paymentInsert[0]).toMatch(/'paid'/);
    expect(paymentInsert[1]).toEqual(['order-1', 'user-1', 180, '555']);
    expect(RefundService.refundStrayPayment).not.toHaveBeenCalled();
  });

  test('through the webhook: recorded, and the order moves on to the store', async () => {
    setup({ order: unpaid });
    await WebhookController.handleChargeSuccess({
      id: 9001, event: 'charge.success',
      data: { id: 555, reference: OLD_REF, amount: 18000, currency: 'ZAR', metadata: { orderId: 'order-1', userId: 'user-1' } },
    }, null);
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'paid', expect.any(Object));
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'pending_store_acceptance', expect.any(Object));
  });

  test('a saved-card reference for the order counts as the order\'s own', () => {
    expect(referenceBelongsToOrder('flash_sc_order-1_ab12', 'order-1')).toBe(true);
    expect(referenceBelongsToOrder('flash_order-1_ab12', 'order-1')).toBe(true);
    expect(referenceBelongsToOrder('flash_order-2_ab12', 'order-1')).toBe(false);
    expect(referenceBelongsToOrder('flash_driver_subscription_1', 'order-1')).toBe(false);
  });
});

describe('a charge that must not pay the order is recorded and refunded in full, with an admin alert', () => {
  test.each([
    ['the order was cancelled (a late charge.success)', { ...unpaid, status: 'cancelled' }, {}, 'late_charge_cancelled_order'],
    ['the order was already paid (a second payment)', { ...unpaid, status: 'pending_store_acceptance', payment_status: 'paid' }, {}, 'duplicate_charge'],
    ['the amount is wrong', unpaid, { amount: 9000 }, 'amount_mismatch'],
    ['the reference belongs to another order', unpaid, { reference: 'flash_order-9_zzz' }, 'reference_not_for_this_order'],
  ])('%s', async (_label, order, over, reason) => {
    const calls = setup({ order });
    const result = await applyOrderCharge(charge(over));

    expect(result.outcome).toBe('stray');
    expect(result.reason).toBe(reason);
    // The order itself is never changed.
    expect(sqlMatching(calls, /UPDATE orders/)).toHaveLength(0);
    // The money is recorded...
    const [insert] = sqlMatching(calls, /INSERT INTO payments/);
    expect(insert[1][4]).toBe('stray');
    expect(JSON.parse(insert[1][5])).toEqual(expect.objectContaining({ strayReason: reason }));
    expect(sqlMatching(calls, /^COMMIT/)).toHaveLength(1);
    // ...refunded automatically...
    expect(RefundService.refundStrayPayment).toHaveBeenCalledWith('pay-stray-1');
    // ...and an admin is alerted.
    expect(sendPaymentAlertEmail).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', amount: over.amount ? over.amount / 100 : 180 }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`CRITICAL.*${reason}`)));
  });

  test('a late charge on a cancelled order is refunded in FULL (no amount sent to Paystack)', async () => {
    RefundService.refundStrayPayment.mockRestore();
    const refundSpy = jest.spyOn(require('../../src/services/paystackService'), 'refundTransaction')
      .mockResolvedValue({ status: true, data: { id: 42 } });
    // The refund's own transaction reads the stray payment back.
    const calls = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        const s = String(sql); calls.push([s, params]);
        if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ ...unpaid, status: 'cancelled' }] };
        if (/INSERT INTO payments[\s\S]*RETURNING id/.test(s)) return { rows: [{ id: 'pay-stray-1' }] };
        if (/FROM payments WHERE id = \$1 FOR UPDATE/.test(s)) {
          return { rows: [{ id: 'pay-stray-1', order_id: 'order-1', user_id: 'user-1', amount: '180.00', provider: 'paystack', provider_transaction_id: '555', status: 'stray', metadata: { strayReason: 'late_charge_cancelled_order' } }] };
        }
        if (/COUNT\(\*\)/.test(s)) return { rows: [{ n: 0 }] };
        if (/INSERT INTO payment_refunds/.test(s)) return { rows: [{ id: 'ref-1', amount: '180.00', reason: 'stray_charge:late_charge_cancelled_order' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect = jest.fn().mockResolvedValue(client);
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'ref-1' }] });

    const result = await applyOrderCharge(charge());
    expect(result.reason).toBe('late_charge_cancelled_order');
    expect(refundSpy).toHaveBeenCalledWith('555', null, 'stray_charge:late_charge_cancelled_order');
    expect(sendPaymentAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/cancelled order was paid/),
    }));
  });

  test('if the automatic refund fails, the charge stays recorded and the alert says it will be retried', async () => {
    setup({ order: { ...unpaid, status: 'cancelled' } });
    RefundService.refundStrayPayment.mockRejectedValueOnce(new Error('Paystack unreachable'));
    const result = await applyOrderCharge(charge());
    expect(result.outcome).toBe('stray');
    expect(sendPaymentAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.arrayContaining([expect.stringMatching(/refund failed.*retried automatically/)]),
    }));
  });
});

describe('the same money is never handled twice', () => {
  test('a transaction already recorded changes nothing', async () => {
    const calls = setup({ order: unpaid, seenTransaction: true });
    const result = await applyOrderCharge(charge());
    expect(result).toEqual({ outcome: 'duplicate' });
    expect(sqlMatching(calls, /UPDATE orders|INSERT INTO payments/)).toHaveLength(0);
    expect(RefundService.refundStrayPayment).not.toHaveBeenCalled();
  });

  test('a repeated webhook event changes nothing', async () => {
    const calls = setup({ order: unpaid, duplicateEvent: true });
    const result = await applyOrderCharge(charge(), { eventId: 9001 });
    expect(result).toEqual({ outcome: 'duplicate' });
    expect(sqlMatching(calls, /^ROLLBACK/)).toHaveLength(1);
    expect(sqlMatching(calls, /UPDATE orders|INSERT INTO payments/)).toHaveLength(0);
  });
});

describe('money for an order that does not exist', () => {
  test('is still recorded (no order) and an admin is alerted', async () => {
    const calls = setup({ order: null });
    const result = await applyOrderCharge(charge());
    expect(result.outcome).toBe('unknown_order');
    const [insert] = sqlMatching(calls, /INSERT INTO payments/);
    expect(insert[0]).toMatch(/VALUES \(NULL, NULL/);
    expect(JSON.parse(insert[1][3])).toEqual(expect.objectContaining({ strayReason: 'unknown_order', orderId: 'order-1' }));
    expect(sendPaymentAlertEmail).toHaveBeenCalled();
  });
});
