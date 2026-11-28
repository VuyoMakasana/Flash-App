'use strict';
/**
 * tests/integration/adminRefund.test.js
 *
 * PR G1 (#106), audit H7, against a REAL local Postgres (the unit tests mock
 * SQL; only a real database proves the SUM, the locks and the finalize
 * statement work). Paystack and email are mocked; no network call is made.
 * Every row is tagged and deleted in afterAll. Skipped without DATABASE_URL
 * (tests/setup/testEnv.js refuses anything that isn't a local database).
 */
const crypto = require('crypto');

jest.mock('../../src/services/emailService', () => ({ sendPaymentAlertEmail: jest.fn().mockResolvedValue() }));

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

d('PR G1: admin full and partial refunds (real database)', () => {
  let pool;
  let paystackService;
  let RefundService;
  const tag = `adm-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let userId;
  const orderIds = [];
  let n = 0;

  async function deliveredOrderPaid(total = '130.00') {
    n += 1;
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (id, user_id, order_number, subtotal, delivery_fee, total, status, payment_status, payment_method)
       VALUES ($1, $2, $3, 100.00, 30.00, $4, 'delivered', 'paid', 'card')`,
      [id, userId, `${tag}-${n}`, total],
    );
    await pool.query(
      `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
       VALUES ($1, $2, $3, 'card', 'paystack', $4, 'paid', 'store')`,
      [id, userId, total, String(2000000 + Math.floor(Math.random() * 7999999))],
    );
    orderIds.push(id);
    return id;
  }
  const order = async (id) => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    pool = require('../../src/config/database');
    paystackService = require('../../src/services/paystackService');
    RefundService = require('../../src/services/refundService');
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [tag, `${tag}@example.test`],
    );
    userId = u.rows[0].id;
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let k = 0;
    jest.spyOn(paystackService, 'refundTransaction').mockImplementation(async () => {
      k += 1;
      return { status: true, data: { id: `rf_${tag}_${k}_${crypto.randomBytes(3).toString('hex')}` } };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (!pool) return;
    for (const sql of [
      'DELETE FROM payment_refunds WHERE order_id = ANY($1::uuid[])',
      'DELETE FROM payments WHERE order_id = ANY($1::uuid[])',
      'DELETE FROM orders WHERE id = ANY($1::uuid[])',
    ]) {
      await pool.query(sql, [orderIds]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  test('partial, refused over the rest, the rest, then refused when nothing is left', async () => {
    const id = await deliveredOrderPaid('130.00');

    // 1. Partial R30: recorded, the order stays paid, even once Paystack confirms.
    const first = await RefundService.adminRefund(id, { amount: '30', reason: 'One item damaged', adminId: 'admin-1' });
    expect(first.reason).toBe('admin_partial:One item damaged');
    expect(parseFloat(first.amount)).toBe(30);
    expect((await order(id)).payment_status).toBe('paid');

    // While it's in flight, a second refund is refused (no double refund).
    await expect(RefundService.adminRefund(id, { amount: '10', reason: 'again', adminId: 'admin-1' }))
      .rejects.toThrow(/still being processed/);

    await RefundService.finalizeRefund(first.refund_reference, null, 'completed', {});
    expect((await order(id)).payment_status).toBe('paid');

    // 2. More than what's left (R100) is refused.
    await expect(RefundService.adminRefund(id, { amount: '100.01', reason: 'too much', adminId: 'admin-1' }))
      .rejects.toThrow(/can't be more than R100\.00 \(what's left of the R130\.00 paid\)/);

    // 3. The rest (empty amount = everything left): a full refund, the order moves on.
    const second = await RefundService.adminRefund(id, { reason: 'Customer goodwill', adminId: 'admin-1' });
    expect(second.reason).toBe('admin_full:Customer goodwill');
    expect(parseFloat(second.amount)).toBe(100);
    expect((await order(id)).payment_status).toBe('refund_pending');
    await RefundService.finalizeRefund(second.refund_reference, null, 'completed', {});
    expect((await order(id)).payment_status).toBe('refunded');

    // 4. Nothing left.
    await expect(RefundService.adminRefund(id, { reason: 'once more', adminId: 'admin-1' }))
      .rejects.toThrow(/already been refunded in full/);

    // Paystack was asked for exactly R30 and R100, in cents.
    expect(paystackService.refundTransaction.mock.calls.map((c) => c[1])).toEqual([3000, 10000]);
    const total = await pool.query(
      `SELECT SUM(amount)::numeric AS s FROM payment_refunds WHERE order_id = $1 AND status = 'completed'`, [id],
    );
    expect(parseFloat(total.rows[0].s)).toBe(130);
  });

  // Review of #107: real SQL for the sweep (jsonb operators) and the
  // just-cancelled refusal (interval arithmetic).
  test('the orphan sweep adopts an accepted refund id and fails only a plain orphan', async () => {
    const { reconcileOrphanedProcessingRefunds } = require('../../src/services/paymentReconciliationJob');
    const id = await deliveredOrderPaid('50.00');
    const payId = (await pool.query('SELECT id FROM payments WHERE order_id = $1', [id])).rows[0].id;
    const insert = (response) => pool.query(
      `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason, provider_response, updated_at)
       VALUES ($1, $2, $3, 10.00, 'paystack', 'processing', 'test', $4::jsonb, NOW() - INTERVAL '10 minutes') RETURNING id`,
      [id, userId, payId, response],
    );
    const accepted = (await insert(JSON.stringify({ acceptedByPaystack: true, refundId: `rf_${tag}_adopt` }))).rows[0].id;
    const orphan = (await insert(null)).rows[0].id;

    await reconcileOrphanedProcessingRefunds();

    const rows = (await pool.query('SELECT id, status, refund_reference FROM payment_refunds WHERE id = ANY($1::uuid[])', [[accepted, orphan]])).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[accepted]).toEqual(expect.objectContaining({ status: 'processing', refund_reference: `rf_${tag}_adopt` }));
    expect(byId[orphan]).toEqual(expect.objectContaining({ status: 'failed', refund_reference: null }));
  });

  test('a just-cancelled order with no refund attempt yet is refused; an older one is allowed', async () => {
    const id = await deliveredOrderPaid('60.00');
    await pool.query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
    await expect(RefundService.adminRefund(id, { reason: 'x', adminId: 'admin-1' })).rejects.toThrow(/still being sent automatically/);
    await pool.query("UPDATE orders SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [id]);
    const refund = await RefundService.adminRefund(id, { reason: 'Fraud', adminId: 'admin-1' });
    expect(parseFloat(refund.amount)).toBe(60);
    expect((await order(id)).payment_status).toBe('refund_pending');
  });

  test('a refused Paystack call is recorded as failed, and the order is unchanged', async () => {
    const id = await deliveredOrderPaid('80.00');
    paystackService.refundTransaction.mockRejectedValueOnce(new Error('Paystack down'));
    await expect(RefundService.adminRefund(id, { reason: 'Fraud', adminId: 'admin-1' })).rejects.toThrow('Paystack down');
    const rows = (await pool.query('SELECT status FROM payment_refunds WHERE order_id = $1', [id])).rows;
    expect(rows.map((r) => r.status)).toEqual(['failed']);
    expect((await order(id)).payment_status).toBe('paid');
    // A failed attempt doesn't count as refunded: the full amount can still go back.
    const retry = await RefundService.adminRefund(id, { reason: 'Fraud', adminId: 'admin-1' });
    expect(parseFloat(retry.amount)).toBe(80);
  });
});
