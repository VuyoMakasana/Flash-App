'use strict';
/**
 * tests/unit/paymentAmountCheck.test.js
 *
 * M8 (#94): an order is only marked paid when Paystack's amount and currency
 * match the order. Two paths mark a card order paid: the charge.success
 * webhook, and the reconciliation job (a missed webhook). Both are checked:
 * if only the webhook checked, a refused mismatch would be marked paid by the
 * job five minutes later.
 *
 * Step 1 (#102): a mismatch is still never marked paid, but the money is no
 * longer left with nothing recorded: it is recorded as a stray payment and
 * refunded in full automatically (orderChargeService). Both paths share it.
 *
 * M4 (#94): Paystack transfer recipients (stores, and drivers later) are
 * South African bank accounts, which Paystack's Transfer Recipient API calls
 * type 'basa'. The code sent 'nuban', Nigeria's type.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService', () => ({
  updateOrderStatus: jest.fn().mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'pending_store_acceptance' }),
  notifyAdminNewOrderPendingAcceptance: jest.fn(),
}));
jest.mock('../../src/services/operatingHoursService', () => ({
  isClosedNow: jest.fn(() => false),
  getNextOpenTime: jest.fn(),
}));
jest.mock('../../src/models/Payment', () => ({ saveCard: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/emailService', () => ({ sendPaymentAlertEmail: jest.fn().mockResolvedValue() }));

const pool = require('../../src/config/database');
const { updateOrderStatus } = require('../../src/services/orderStateMachineService');
const WebhookController = require('../../src/controllers/webhookController');
const paystackService = require('../../src/services/paystackService');
const RefundService = require('../../src/services/refundService');
const { reconcilePendingPayments } = require('../../src/services/paymentReconciliationJob');

const PAID_UPDATE = /SET payment_status = 'paid'/;
const REF = 'flash_order-1_abc123';

function makeClient(orderRow) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push([String(sql), params]);
      const s = String(sql);
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: orderRow ? [{ ...orderRow }] : [] };
      if (/INSERT INTO payments[\s\S]*RETURNING id/.test(s)) return { rows: [{ id: 'pay-stray-1' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect = jest.fn().mockResolvedValue(client);
  pool.query = jest.fn().mockResolvedValue({ rows: [] });
  return calls;
}

const event = (data) => ({
  id: 9001,
  event: 'charge.success',
  data: { id: 555, reference: REF, metadata: { orderId: 'order-1', userId: 'user-1' }, ...data },
});

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(RefundService, 'refundStrayPayment').mockResolvedValue({ status: 'processing' });
});
afterEach(() => jest.restoreAllMocks()); // console spies and every service spy

describe('M8: the webhook checks amount and currency before marking an order paid', () => {
  const order = { id: 'order-1', user_id: 'user-1', status: 'payment_pending', payment_status: 'pending', total: '180.00', paystack_reference: REF };

  test('matching amount (cents) and ZAR: the order is marked paid', async () => {
    const calls = makeClient(order);
    await WebhookController.handleChargeSuccess(event({ amount: 18000, currency: 'ZAR' }), null);
    expect(calls.some(([sql]) => PAID_UPDATE.test(sql))).toBe(true);
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'paid', expect.any(Object));
    expect(RefundService.refundStrayPayment).not.toHaveBeenCalled();
  });

  test.each([
    ['a lower amount', { amount: 100, currency: 'ZAR' }],
    ['a higher amount', { amount: 18001, currency: 'ZAR' }],
    ['another currency', { amount: 18000, currency: 'NGN' }],
    ['a missing currency', { amount: 18000 }],
    ['a missing amount', { currency: 'ZAR' }],
  ])('%s: NOT marked paid; recorded as stray, refunded automatically, logged as CRITICAL', async (_label, data) => {
    const calls = makeClient(order);
    await WebhookController.handleChargeSuccess(event(data), null);
    expect(calls.some(([sql]) => PAID_UPDATE.test(sql))).toBe(false);
    expect(updateOrderStatus).not.toHaveBeenCalled();
    const strayInsert = calls.find(([sql]) => /INSERT INTO payments/.test(sql));
    expect(strayInsert[1]).toContain(RefundService.STRAY);
    expect(JSON.parse(strayInsert[1][5]).strayReason).toBe('amount_mismatch');
    expect(RefundService.refundStrayPayment).toHaveBeenCalledWith('pay-stray-1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL.*amount_mismatch.*order-1/));
  });
});

describe('M8: the reconciliation job applies the same check', () => {
  const pending = { id: 'order-1', user_id: 'user-1', payment_status: 'pending', paystack_reference: REF, total: '180.00' };
  const lockedOrder = { id: 'order-1', user_id: 'user-1', status: 'payment_pending', payment_status: 'pending', total: '180.00', paystack_reference: REF };

  test('the job reads the order total and skips cancelled orders', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await reconcilePendingPayments(null);
    expect(pool.query.mock.calls[0][0]).toMatch(/\btotal\b/);
    expect(pool.query.mock.calls[0][0]).toMatch(/status <> 'cancelled'/);
  });

  test('Paystack says success with the right amount: marked paid', async () => {
    const calls = makeClient(lockedOrder);
    pool.query = jest.fn().mockResolvedValueOnce({ rows: [pending] }).mockResolvedValue({ rows: [] });
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockResolvedValue({ definite: true, status: 'success', transactionId: 777, amount: 18000, currency: 'ZAR' });
    await reconcilePendingPayments(null);
    expect(calls.some(([sql]) => PAID_UPDATE.test(sql))).toBe(true);
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'paid', expect.any(Object));
  });

  test('Paystack says success with the wrong amount: NOT marked paid; recorded and refunded', async () => {
    const calls = makeClient(lockedOrder);
    pool.query = jest.fn().mockResolvedValueOnce({ rows: [pending] }).mockResolvedValue({ rows: [] });
    jest.spyOn(paystackService, 'fetchTransactionStatus').mockResolvedValue({ definite: true, status: 'success', transactionId: 777, amount: 100, currency: 'ZAR' });
    await reconcilePendingPayments(null);
    expect(calls.some(([sql]) => PAID_UPDATE.test(sql))).toBe(false);
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(RefundService.refundStrayPayment).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL.*amount_mismatch.*order-1/));
  });

  test('verifyPayment reports Paystack\'s amount and currency', async () => {
    jest.spyOn(paystackService, 'request').mockResolvedValue({
      status: true, data: { status: 'success', amount: 18000, currency: 'ZAR', metadata: { orderId: 'order-1' } },
    });
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'order-1', user_id: 'user-1', payment_status: 'pending', paystack_reference: REF }] });
    const result = await paystackService.verifyPayment(REF, null, 'user-1');
    expect(result).toEqual(expect.objectContaining({ providerAmount: 18000, providerCurrency: 'ZAR' }));
  });
});

describe('M4: transfer recipients are South African (basa)', () => {
  test('createTransferRecipient sends type basa in ZAR', async () => {
    const spy = jest.spyOn(paystackService, 'request').mockResolvedValue({ status: true, data: { recipient_code: 'RCP_x' } });
    await paystackService.createTransferRecipient({ name: 'Store', accountNumber: '1234567890', bankCode: '632005' });
    expect(spy).toHaveBeenCalledWith('POST', '/transferrecipient', expect.objectContaining({ type: 'basa', currency: 'ZAR' }));
    expect(spy.mock.calls[0][2].type).not.toBe('nuban');
  });
});
