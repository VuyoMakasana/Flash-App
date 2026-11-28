'use strict';
/**
 * tests/unit/adminRefund.test.js
 *
 * PR G1 (#106), audit H7: an admin refunds a delivered or cancelled card
 * order, in full or in part, from the admin panel, with a typed reason.
 *   - It goes through RefundService.adminRefund: a payment_refunds row for
 *     every attempt, never more than what's left of what was paid, no
 *     second refund while one is still in flight (a double click can't
 *     refund twice), failures counted for the 3-failure alert.
 *   - Every attempt is written to admin_actions (adminRefundAction.js).
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService', () => ({ sendPaymentAlertEmail: jest.fn().mockResolvedValue() }));
jest.mock('../../src/models/AdminAction', () => ({ log: jest.fn().mockResolvedValue() }));

const db = require('../../src/config/database');
const paystackService = require('../../src/services/paystackService');
const RefundService = require('../../src/services/refundService');
const AdminAction = require('../../src/models/AdminAction');
const { refundOrderAction } = require('../../src/adminRefundAction');

const delivered = { id: 'order-1', user_id: 'user-1', status: 'delivered', payment_method: 'card', payment_status: 'paid' };
const payment = { id: 'pay-1', provider: 'paystack', provider_transaction_id: '555', amount: '130.00' };

// A fake transaction client. `refundedSoFar` = completed refunds on the payment.
function setup({ order = delivered, pay = payment, inFlight = false, refundedSoFar = 0 } = {}) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql); calls.push([s, params]);
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: order ? [{ ...order }] : [] };
      if (/FROM payments\s+WHERE order_id/.test(s)) return { rows: pay ? [{ ...pay }] : [] };
      if (/status = 'processing'/.test(s) && /payment_refunds/.test(s)) return { rows: inFlight ? [{ id: 'busy' }] : [] };
      if (/SUM\(amount\)/.test(s)) return { rows: [{ refunded: String(refundedSoFar) }] };
      if (/INSERT INTO payment_refunds/.test(s)) return { rows: [{ id: 'ref-1', amount: params[3], reason: params[5] }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect = jest.fn().mockResolvedValue(client);
  db.query = jest.fn(async (sql) => (/COUNT/.test(String(sql)) ? { rows: [{ n: 0 }] } : { rows: [{ id: 'ref-1', status: 'processing' }] }));
  return calls;
}

let refundSpy;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  refundSpy = jest.spyOn(paystackService, 'refundTransaction').mockResolvedValue({ status: true, data: { id: 9001 } });
});
afterEach(() => jest.restoreAllMocks());

describe('RefundService.adminRefund', () => {
  test('full refund (no amount): everything still left, and the order moves to refund_pending', async () => {
    const calls = setup();
    await RefundService.adminRefund('order-1', { reason: 'Fraudulent order', adminId: 'admin-1' });
    const insert = calls.find(([s]) => /INSERT INTO payment_refunds/.test(s));
    expect(insert[1][3]).toBe(130);
    expect(insert[1][5]).toBe('admin_full:Fraudulent order');
    expect(refundSpy).toHaveBeenCalledWith('555', 13000, 'admin_full:Fraudulent order');
    expect(db.query.mock.calls.some(([s]) => /SET payment_status = 'refund_pending'/.test(String(s)))).toBe(true);
  });

  test('partial refund: only that amount, and the order stays paid', async () => {
    const calls = setup();
    await RefundService.adminRefund('order-1', { amount: '30', reason: 'One item damaged', adminId: 'admin-1' });
    const insert = calls.find(([s]) => /INSERT INTO payment_refunds/.test(s));
    expect(insert[1][3]).toBe(30);
    expect(insert[1][5]).toBe('admin_partial:One item damaged');
    expect(refundSpy).toHaveBeenCalledWith('555', 3000, 'admin_partial:One item damaged');
    expect(db.query.mock.calls.some(([s]) => /refund_pending/.test(String(s)))).toBe(false);
  });

  test('never more than what is left: R130 paid, R100 already refunded, R31 refused', async () => {
    setup({ refundedSoFar: 100 });
    await expect(RefundService.adminRefund('order-1', { amount: '31', reason: 'x', adminId: 'a' }))
      .rejects.toThrow(/can't be more than R30\.00/);
    expect(refundSpy).not.toHaveBeenCalled();
  });

  test('refunding exactly what is left counts as the full refund', async () => {
    const calls = setup({ refundedSoFar: 100 });
    await RefundService.adminRefund('order-1', { amount: '30.00', reason: 'Rest of it', adminId: 'a' });
    expect(calls.find(([s]) => /INSERT INTO payment_refunds/.test(s))[1][5]).toBe('admin_full:Rest of it');
  });

  test('already refunded in full: refused', async () => {
    setup({ refundedSoFar: 130 });
    await expect(RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' })).rejects.toThrow(/already been refunded in full/);
    expect(refundSpy).not.toHaveBeenCalled();
  });

  test('a refund still in flight blocks a second one (a double click cannot refund twice)', async () => {
    setup({ inFlight: true });
    await expect(RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' })).rejects.toThrow(/still being processed/);
    expect(refundSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['no reason', { reason: '   ' }, /reason/],
    ['a zero amount', { amount: '0', reason: 'x' }, /more than R0/],
    ['a negative amount', { amount: '-5', reason: 'x' }, /more than R0/],
    ['not a number', { amount: 'abc', reason: 'x' }, /more than R0/],
    ['fractions of a cent', { amount: '10.005', reason: 'x' }, /cents/],
  ])('%s: refused before anything is written', async (_l, input, msg) => {
    const calls = setup();
    await expect(RefundService.adminRefund('order-1', { adminId: 'a', ...input })).rejects.toThrow(msg);
    expect(calls.some(([s]) => /INSERT INTO payment_refunds/.test(s))).toBe(false);
    expect(refundSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['an order still in progress', { ...delivered, status: 'in_transit' }, payment, /delivered or cancelled/],
    ['a cash order', { ...delivered, payment_method: 'cash' }, payment, /card/],
    ['no card payment on record', delivered, null, /No card payment/],
  ])('%s: refused', async (_l, order, pay, msg) => {
    setup({ order, pay });
    await expect(RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' })).rejects.toThrow(msg);
    expect(refundSpy).not.toHaveBeenCalled();
  });

  test.each(['cancelled', 'completed'])('a %s order can be refunded', async (status) => {
    setup({ order: { ...delivered, status } });
    await RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' });
    expect(refundSpy).toHaveBeenCalled();
  });

  test('Paystack refusing it: the attempt is recorded as failed and checked for the 3-failure alert', async () => {
    setup();
    refundSpy.mockRejectedValue(new Error('Paystack down'));
    const alertSpy = jest.spyOn(RefundService, 'alertIfRefundRetriesExhausted').mockResolvedValue(false);
    await expect(RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' })).rejects.toThrow('Paystack down');
    expect(db.query.mock.calls.some(([s]) => /SET status = 'failed'/.test(String(s)))).toBe(true);
    expect(alertSpy).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1' }));
  });
});

describe('finalizeRefund and admin refunds', () => {
  function finalizeClient(row) {
    const calls = [];
    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql); calls.push(s);
        if (/FROM payment_refunds pr/.test(s)) return { rows: [row] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db.connect = jest.fn().mockResolvedValue(client);
    return calls;
  }
  const base = { id: 'ref-1', order_id: 'order-1', status: 'processing', amount: '30.00', payment_id: 'pay-1', payment_status: 'paid' };

  test('a partial admin refund, once confirmed, leaves the order paid', async () => {
    const calls = finalizeClient({ ...base, reason: 'admin_partial:One item damaged' });
    await RefundService.finalizeRefund('9001', null, 'completed', {});
    expect(calls.some((s) => /UPDATE payment_refunds/.test(s))).toBe(true);
    expect(calls.some((s) => /UPDATE orders/.test(s))).toBe(false);
  });

  test('a full admin refund, once confirmed, marks the order refunded', async () => {
    const calls = finalizeClient({ ...base, reason: 'admin_full:Fraud' });
    await RefundService.finalizeRefund('9001', null, 'completed', {});
    expect(calls.some((s) => /UPDATE orders SET payment_status/.test(s))).toBe(true);
  });
});

describe('the admin panel action (audited in admin_actions)', () => {
  const action = refundOrderAction(null);
  const record = { id: () => 'order-1', param: (k) => ({ status: 'delivered', payment_method: 'card' })[k], toJSON: () => ({}) };
  const context = { record, currentAdmin: { id: 'admin-1' } };

  test('shown for delivered, completed and cancelled card orders only', () => {
    const rec = (status, method = 'card') => ({ record: { param: (k) => ({ status, payment_method: method })[k] } });
    expect(action.isAccessible(rec('delivered'))).toBe(true);
    expect(action.isAccessible(rec('completed'))).toBe(true);
    expect(action.isAccessible(rec('cancelled'))).toBe(true);
    expect(action.isAccessible(rec('in_transit'))).toBe(false);
    expect(action.isAccessible(rec('delivered', 'cash'))).toBe(false);
  });

  test('opening the form changes nothing', async () => {
    const spy = jest.spyOn(RefundService, 'adminRefund');
    await action.handler({ method: 'get' }, {}, context);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a refund is submitted and audited with the amount, kind and reason', async () => {
    jest.spyOn(RefundService, 'adminRefund').mockResolvedValue({ id: 'ref-1', amount: '30.00', reason: 'admin_partial:Damaged' });
    const out = await action.handler({ method: 'post', payload: { amount: '30', reason: '  Damaged  ' } }, {}, context);
    expect(RefundService.adminRefund).toHaveBeenCalledWith('order-1', { amount: '30', reason: 'Damaged', adminId: 'admin-1' });
    expect(AdminAction.log).toHaveBeenCalledWith('admin-1', 'order_refund_admin', 'orders', 'order-1',
      expect.objectContaining({ amount: '30.00', refundId: 'ref-1', kind: 'partial', reason: 'Damaged' }));
    expect(out.notice.type).toBe('success');
  });

  test('an empty amount means a full refund', async () => {
    jest.spyOn(RefundService, 'adminRefund').mockResolvedValue({ id: 'ref-2', amount: '130.00', reason: 'admin_full:Fraud' });
    await action.handler({ method: 'post', payload: { amount: '', reason: 'Fraud' } }, {}, context);
    expect(RefundService.adminRefund).toHaveBeenCalledWith('order-1', { amount: null, reason: 'Fraud', adminId: 'admin-1' });
  });

  test('no reason: refused, nothing submitted', async () => {
    const spy = jest.spyOn(RefundService, 'adminRefund');
    const out = await action.handler({ method: 'post', payload: { amount: '', reason: ' ' } }, {}, context);
    expect(spy).not.toHaveBeenCalled();
    expect(out.notice.type).toBe('error');
  });

  test('a refused refund is audited too, with the reason it failed', async () => {
    jest.spyOn(RefundService, 'adminRefund').mockRejectedValue(new Error("The refund can't be more than R30.00"));
    const out = await action.handler({ method: 'post', payload: { amount: '99', reason: 'x' } }, {}, context);
    expect(AdminAction.log).toHaveBeenCalledWith('admin-1', 'order_refund_admin_failed', 'orders', 'order-1',
      expect.objectContaining({ error: "The refund can't be more than R30.00" }));
    expect(out.notice.type).toBe('error');
  });
});

// Found in review (PR G1, #106).
describe('review fixes', () => {
  test('an amount that rounds to 0 cents is refused', async () => {
    const calls = setup();
    await expect(RefundService.adminRefund('order-1', { amount: '0.000000001', reason: 'x', adminId: 'a' }))
      .rejects.toThrow(/more than R0/);
    expect(calls.some(([s]) => /INSERT INTO payment_refunds/.test(s))).toBe(false);
  });

  test('Paystack ACCEPTED the refund but saving it failed: never marked failed; admins alerted; "do not refund again"', async () => {
    setup();
    const { sendPaymentAlertEmail } = require('../../src/services/emailService');
    db.query = jest.fn(async (sql) => {
      if (/SET refund_reference/.test(String(sql))) throw new Error('connection reset');
      return { rows: [] };
    });
    await expect(RefundService.adminRefund('order-1', { reason: 'Fraud', adminId: 'a' }))
      .rejects.toMatchObject({ code: 'REFUND_ACCEPTED_NOT_SAVED', message: expect.stringMatching(/Don't refund again/) });
    expect(db.query.mock.calls.some(([s]) => /SET status = 'failed'/.test(String(s)))).toBe(false);
    expect(sendPaymentAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      title: "A refund was sent but couldn't be saved",
      details: expect.arrayContaining(['Paystack refund id: 9001']),
    }));
  });

  test('marking a full refund pending never overwrites an order already marked refunded', async () => {
    setup();
    await RefundService.adminRefund('order-1', { reason: 'Fraud', adminId: 'a' });
    const update = db.query.mock.calls.find(([s]) => /SET payment_status = 'refund_pending'/.test(String(s)));
    expect(update[0]).toMatch(/payment_status <> 'refunded'/);
  });

  test('the customer-cancellation refund uses the same guard', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql);
        if (/FROM orders\s+WHERE id = \$1\s+FOR UPDATE/.test(s)) return { rows: [{ id: 'order-1', user_id: 'user-1', payment_method: 'card', payment_status: 'paid', total: '130.00' }] };
        if (/COUNT\(\*\)::int AS n/.test(s)) return { rows: [{ n: 0 }] };
        if (/FROM payments\s+WHERE order_id/.test(s)) return { rows: [{ ...payment }] };
        if (/INSERT INTO payment_refunds/.test(s)) return { rows: [{ id: 'ref-9', amount: '130.00' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db.connect = jest.fn().mockResolvedValue(client);
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await RefundService.refundOrderPayment('order-1', 'user-1', 'customer_cancellation');
    const update = db.query.mock.calls.find(([s]) => /refund_pending/.test(String(s)));
    expect(update[0]).toMatch(/payment_status <> 'refunded'/);
  });
});

// Second review pass on #107.
describe('review fixes, second pass', () => {
  test('saving the refund id never replaces a final answer Paystack already gave', async () => {
    setup();
    await RefundService.adminRefund('order-1', { reason: 'Fraud', adminId: 'a' });
    const save = db.query.mock.calls.find(([s]) => /SET refund_reference = \$2/.test(String(s)));
    expect(save[0]).toMatch(/CASE WHEN status = 'processing' THEN \$3::jsonb ELSE provider_response END/);
  });

  test('accepted but not saved: a durable "accepted, refund id X" marker is written for the sweep', async () => {
    setup();
    db.query = jest.fn(async (sql) => {
      if (/SET refund_reference/.test(String(sql))) throw new Error('connection reset');
      return { rows: [] };
    });
    await expect(RefundService.adminRefund('order-1', { reason: 'Fraud', adminId: 'a' })).rejects.toMatchObject({ code: 'REFUND_ACCEPTED_NOT_SAVED' });
    const marker = db.query.mock.calls.find(([s]) => /acceptedByPaystack/.test(String(s)));
    expect(marker[0]).toMatch(/jsonb_build_object\('acceptedByPaystack', true, 'refundId', \$2::text\)/);
    expect(marker[1]).toEqual(['ref-1', '9001']);
  });

  test('refund_pending is written only while that attempt is still processing', async () => {
    setup();
    await RefundService.adminRefund('order-1', { reason: 'Fraud', adminId: 'a' });
    const update = db.query.mock.calls.find(([s]) => /SET payment_status = 'refund_pending'/.test(String(s)));
    expect(update[0]).toMatch(/EXISTS \(SELECT 1 FROM payment_refunds WHERE id = \$2 AND status = 'processing'\)/);
    expect(update[1]).toEqual(['order-1', 'ref-1']);
  });

  test('a just-cancelled order whose own refund has not been attempted yet: refused, try again shortly', async () => {
    const calls = setup({ order: { ...delivered, status: 'cancelled', changed_recently: true } });
    await expect(RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' }))
      .rejects.toThrow(/still being sent automatically/);
    expect(calls.some(([s]) => /INSERT INTO payment_refunds/.test(s))).toBe(false);
  });

  test('a cancelled order whose refund was already attempted can be refunded', async () => {
    const calls = setup({ order: { ...delivered, status: 'cancelled', changed_recently: true } });
    const client = await db.connect();
    const original = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, params) => (
      /SELECT 1 FROM payment_refunds WHERE order_id/.test(String(sql)) ? { rows: [{ 1: 1 }] } : original(sql, params)));
    await RefundService.adminRefund('order-1', { reason: 'x', adminId: 'a' });
    expect(calls.some(([s]) => /INSERT INTO payment_refunds/.test(s))).toBe(true);
  });

  test('a customer cannot type a server-owned reason prefix', async () => {
    expect(RefundService.userReason('admin_partial: please')).toBe('note:admin_partial: please');
    expect(RefundService.userReason('  ADMIN_full:x')).toBe('note:  ADMIN_full:x');
    expect(RefundService.userReason('stray_charge:x')).toBe('note:stray_charge:x');
    expect(RefundService.userReason('Wrong size')).toBe('Wrong size');

    const client = {
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        if (/FROM orders\s+WHERE id = \$1\s+FOR UPDATE/.test(s)) return { rows: [{ id: 'order-1', user_id: 'user-1', payment_method: 'card', payment_status: 'paid', total: '130.00' }] };
        if (/COUNT\(\*\)::int AS n/.test(s)) return { rows: [{ n: 0 }] };
        if (/FROM payments\s+WHERE order_id/.test(s)) return { rows: [{ ...payment }] };
        if (/INSERT INTO payment_refunds/.test(s)) return { rows: [{ id: 'ref-9', amount: '130.00', reason: params[5] }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db.connect = jest.fn().mockResolvedValue(client);
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await RefundService.refundOrderPayment('order-1', 'user-1', 'admin_partial:sneaky');
    const insert = client.query.mock.calls.find(([s]) => /INSERT INTO payment_refunds/.test(String(s)));
    expect(insert[1][5]).toBe('note:admin_partial:sneaky');
    expect(refundSpy).toHaveBeenCalledWith('555', 13000, 'note:admin_partial:sneaky');
  });
});

describe('the orphan sweep keeps accepted refunds reserved', () => {
  test('it adopts the marked refund id first, and never fails an accepted attempt', async () => {
    const { reconcileOrphanedProcessingRefunds } = require('../../src/services/paymentReconciliationJob');
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await reconcileOrphanedProcessingRefunds();
    const [adopt, fail] = db.query.mock.calls.map(([s]) => String(s));
    expect(adopt).toMatch(/SET refund_reference = provider_response->>'refundId'/);
    expect(adopt).toMatch(/provider_response->>'acceptedByPaystack' = 'true'/);
    expect(fail).toMatch(/SET status = 'failed'/);
    expect(fail).toMatch(/COALESCE\(provider_response->>'acceptedByPaystack', ''\) <> 'true'/);
  });
});
