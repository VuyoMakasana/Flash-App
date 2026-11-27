'use strict';
/**
 * tests/integration/paymentRecording.test.js
 *
 * Step 1 (#102), against a REAL local Postgres (the unit tests mock SQL, so
 * only a real database proves the new queries are valid: FOR UPDATE OF pr,
 * the jsonb metadata, the COUNT caps). Paystack and email are mocked; no
 * network call is made. Every row is tagged and deleted in afterAll.
 * Skipped when DATABASE_URL is not set (tests/setup/testEnv.js refuses
 * anything that is not a local database).
 */
const crypto = require('crypto');

jest.mock('../../src/services/emailService', () => ({
  sendPaymentAlertEmail: jest.fn().mockResolvedValue(),
  sendOrderMissedEmail: jest.fn().mockResolvedValue(),
  sendOrderEscalationEmail: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/services/notificationService', () => ({
  notifyUserOrderUpdate: jest.fn().mockResolvedValue(),
  sendPushNotification: jest.fn().mockResolvedValue(),
}));

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

d('Step 1: every charge is recorded or refunded (real database)', () => {
  let pool;
  let paystackService;
  let RefundService;
  let applyOrderCharge;
  let jobs;
  const tag = `pay-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let userId;
  const orderIds = [];
  let n = 0;

  async function makeOrder(fields = {}) {
    n += 1;
    const id = crypto.randomUUID();
    const f = {
      status: 'payment_pending', payment_status: 'pending', payment_method: 'card', total: '180.00',
      paystack_reference: `flash_${id}_new${n}`, updated_at: 'NOW()', ...fields,
    };
    await pool.query(
      `INSERT INTO orders (id, user_id, order_number, subtotal, delivery_fee, total, status, payment_status,
                           payment_method, paystack_reference, updated_at)
       VALUES ($1, $2, $3, 150.00, 30.00, $4, $5, $6, $7, $8, ${f.updated_at})`,
      [id, userId, `${tag}-${n}`, f.total, f.status, f.payment_status, f.payment_method, f.paystack_reference],
    );
    orderIds.push(id);
    return id;
  }
  const order = async (id) => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
  const payments = async (id) => (await pool.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at', [id])).rows;
  const refunds = async (id) => (await pool.query('SELECT * FROM payment_refunds WHERE order_id = $1 ORDER BY created_at', [id])).rows;
  const tx = () => String(1000000 + Math.floor(Math.random() * 8999999));

  beforeAll(async () => {
    pool = require('../../src/config/database');
    paystackService = require('../../src/services/paystackService');
    RefundService = require('../../src/services/refundService');
    ({ applyOrderCharge } = require('../../src/services/orderChargeService'));
    jobs = require('../../src/services/paymentReconciliationJob');
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [tag, `${tag}@example.test`],
    );
    userId = u.rows[0].id;
  });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(paystackService, 'refundTransaction').mockResolvedValue({ status: true, data: { id: `rf_${crypto.randomBytes(4).toString('hex')}` } });
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (!pool) return;
    const ids = orderIds;
    for (const sql of [
      'DELETE FROM payment_refunds WHERE order_id = ANY($1::uuid[])',
      'DELETE FROM payments WHERE order_id = ANY($1::uuid[])',
      'DELETE FROM order_cancellations WHERE order_id = ANY($1::uuid[])',
      'DELETE FROM orders WHERE id = ANY($1::uuid[])',
    ]) {
      await pool.query(sql, [ids]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  test('paying an OLDER payment page is recorded against the order', async () => {
    const id = await makeOrder();
    const oldRef = `flash_${id}_old`;
    const result = await applyOrderCharge({ orderId: id, reference: oldRef, transactionId: tx(), amount: 18000, currency: 'ZAR' });
    expect(result.outcome).toBe('paid');
    const o = await order(id);
    expect(o.payment_status).toBe('paid');
    expect(o.paystack_reference).toBe(oldRef);
    const p = await payments(id);
    expect(p).toHaveLength(1);
    expect(p[0].status).toBe('paid');
    expect(parseFloat(p[0].amount)).toBe(180);
  });

  test('a second payment for a paid order is recorded as stray, refunded, and finalized without touching the order', async () => {
    const id = await makeOrder();
    await applyOrderCharge({ orderId: id, reference: `flash_${id}_a`, transactionId: tx(), amount: 18000, currency: 'ZAR' });
    const second = await applyOrderCharge({ orderId: id, reference: `flash_${id}_b`, transactionId: tx(), amount: 18000, currency: 'ZAR' });
    expect(second).toEqual(expect.objectContaining({ outcome: 'stray', reason: 'duplicate_charge' }));

    const p = await payments(id);
    expect(p.map((r) => r.status).sort()).toEqual(['paid', 'stray']);
    const stray = p.find((r) => r.status === 'stray');
    expect(stray.metadata.strayReason).toBe('duplicate_charge');

    const r = await refunds(id);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('processing');
    expect(r[0].payment_id).toBe(stray.id);

    // Paystack confirms the refund (refund.processed): real SQL, incl. FOR UPDATE OF pr.
    const fin = await RefundService.finalizeRefund(r[0].refund_reference, null, 'completed', {});
    expect(fin).toEqual(expect.objectContaining({ stray: true, alreadyFinalized: false }));
    expect((await payments(id)).find((x) => x.id === stray.id).status).toBe('stray_refunded');
    expect((await order(id)).payment_status).toBe('paid'); // the genuine payment stands
  });

  test('a late charge.success on a cancelled order is refunded in full', async () => {
    const id = await makeOrder({ status: 'cancelled' });
    const result = await applyOrderCharge({ orderId: id, reference: `flash_${id}_late`, transactionId: tx(), amount: 18000, currency: 'ZAR' });
    expect(result.reason).toBe('late_charge_cancelled_order');
    expect(paystackService.refundTransaction).toHaveBeenCalledWith(expect.any(String), null, 'stray_charge:late_charge_cancelled_order');
    expect((await refunds(id))[0].status).toBe('processing');
    expect((await order(id)).status).toBe('cancelled');
  });

  test('a stale unpaid order is cancelled on a definite answer, and left alone without one', async () => {
    const abandoned = await makeOrder({ updated_at: "NOW() - INTERVAL '2 hours'" });
    const unknown = await makeOrder({ updated_at: "NOW() - INTERVAL '2 hours'" });
    const ref = { [(await order(abandoned)).paystack_reference]: 'abandoned', [(await order(unknown)).paystack_reference]: null };
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockImplementation(async (reference) => (
      reference in ref
        ? (ref[reference] ? { definite: true, status: ref[reference] } : { definite: false, status: null, error: 'timeout' })
        : { definite: false, status: null }
    ));

    await jobs.cancelStalePendingPayments(null);

    expect((await order(abandoned)).status).toBe('cancelled');
    const oc = await pool.query('SELECT reason FROM order_cancellations WHERE order_id = $1', [abandoned]);
    expect(oc.rows[0].reason).toBe('payment_not_completed_timeout');
    expect((await order(unknown)).status).toBe('payment_pending');
  });

  test('refunds stop after 3 automatic failures; a manual retry still works', async () => {
    const id = await makeOrder({ status: 'cancelled', payment_status: 'paid', updated_at: "NOW() - INTERVAL '1 hour'" });
    const pay = await pool.query(
      `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
       VALUES ($1, $2, 180.00, 'card', 'paystack', $3, 'paid', 'store') RETURNING id`,
      [id, userId, tx()],
    );
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason)
         VALUES ($1, $2, $3, 180.00, 'paystack', 'failed', 'test')`,
        [id, userId, pay.rows[0].id],
      );
    }
    expect(await RefundService.countFailedOrderRefunds(pool, id)).toBe(3);

    await jobs.reconcileMissingRefunds(null);
    expect(paystackService.refundTransaction).not.toHaveBeenCalled();

    await jobs.manualRetryOrderRefund(id);
    expect(paystackService.refundTransaction).toHaveBeenCalledTimes(1);
    expect((await order(id)).payment_status).toBe('refund_pending');
  });

  // On main before #102 this always threw on real Postgres (FOR UPDATE on a
  // LEFT JOIN's nullable side, and an untyped $2), so refund.processed never
  // marked any order refunded.
  test.each([
    ['completed', 'refunded'],
    ['failed', 'refund_failed'],
  ])('an order refund is finalized by Paystack\'s answer (%s → %s)', async (outcome, expected) => {
    const id = await makeOrder({ status: 'cancelled', payment_status: 'paid' });
    await pool.query(
      `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
       VALUES ($1, $2, 180.00, 'card', 'paystack', $3, 'paid', 'store')`,
      [id, userId, tx()],
    );
    const refund = await RefundService.refundOrderPayment(id, userId, 'customer_cancellation');
    expect((await order(id)).payment_status).toBe('refund_pending');

    const fin = await RefundService.finalizeRefund(refund.refund_reference, null, outcome, { data: {} });
    expect(fin).toEqual(expect.objectContaining({ orderId: id, alreadyFinalized: false, stray: false }));
    expect((await order(id)).payment_status).toBe(expected);
    const [row] = await refunds(id);
    expect(row.status).toBe(outcome);
    if (outcome === 'completed') expect(row.completed_at).not.toBeNull();
  });

  test('the stray-refund retry job runs on real SQL', async () => {
    await expect(jobs.reconcileStrayRefunds()).resolves.toBeUndefined();
  });
});
