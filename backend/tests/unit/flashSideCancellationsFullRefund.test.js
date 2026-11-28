'use strict';
/**
 * tests/unit/flashSideCancellationsFullRefund.test.js
 *
 * PR G1 (#106), Terms A9: "Flash cancels and refunds you in full if no
 * driver is available within 30 minutes, an item is out of stock, a price is
 * wrong, or an order looks fraudulent." Every cancellation Flash (or the
 * store) makes records refund_mode 'full_refund' and refunds the WHOLE
 * payment: refundOrderPayment is called with no partial amount.
 *   - no driver within 30 minutes: cancelNoDriverOrders;
 *   - out of stock / wrong price / store can't fulfil: the store (or an admin)
 *     rejects it, rejectPendingAcceptance;
 *   - the store never marks it ready: cancelStalePreparingOrders;
 *   - fraud after acceptance: the admin refund action (adminRefund.test.js).
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/refundService');
jest.mock('../../src/services/operatingHoursService');

const pool = require('../../src/config/database');
const notificationService = require('../../src/services/notificationService');
const RefundService = require('../../src/services/refundService');
const {
  cancelNoDriverOrders, cancelStalePreparingOrders, rejectPendingAcceptance,
} = require('../../src/services/orderStateMachineService');

function makeClient(row) {
  const state = { ...row };
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([String(sql), params]);
    const s = String(sql).trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
    if (/SELECT \* FROM orders WHERE id = \$1\s+FOR UPDATE/i.test(s)) return { rows: [{ ...state }] };
    if (/INSERT INTO order_cancellations/i.test(s)) return { rows: [{ id: 'c-1' }] };
    if (/^UPDATE orders\s+SET status = \$1/i.test(s)) { state.status = params[0]; return { rows: [{ ...state }] }; }
    if (/^UPDATE orders/i.test(s)) return { rows: [{ ...state }] };
    return { rows: [] };
  });
  return { query, release: jest.fn(), calls, state };
}

const paidCard = { user_id: 'u-1', payment_method: 'card', payment_status: 'paid', subtotal: '100.00', delivery_fee: '30.00' };

beforeEach(() => {
  jest.clearAllMocks();
  notificationService.notifyUserOrderUpdate = jest.fn().mockResolvedValue();
  RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });
});

function expectFullRefund(client, orderId, reason) {
  const cancellation = client.calls.find(([s]) => /INSERT INTO order_cancellations/i.test(s));
  expect(cancellation[0]).toMatch(/full_refund/);
  // Exactly three arguments: no partial amount, so the whole payment.
  expect(RefundService.refundOrderPayment).toHaveBeenCalledWith(orderId, 'u-1', reason);
  expect(RefundService.refundOrderPayment.mock.calls[0]).toHaveLength(3);
}

test('no driver within 30 minutes: full refund', async () => {
  pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-1', ...paidCard }] });
  const client = makeClient({ id: 'o-1', status: 'waiting_for_driver', ...paidCard });
  pool.connect = jest.fn().mockResolvedValue(client);
  await cancelNoDriverOrders({});
  expectFullRefund(client, 'o-1', 'no_driver_available_timeout');
});

test('the store never marked it ready: full refund', async () => {
  pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-2', order_number: 'FL-2', ...paidCard }] });
  const client = makeClient({ id: 'o-2', status: 'preparing', ...paidCard });
  pool.connect = jest.fn().mockResolvedValue(client);
  await cancelStalePreparingOrders({});
  expectFullRefund(client, 'o-2', 'store_preparation_timeout');
});

test('the store (or an admin) rejects it, e.g. out of stock or a wrong price: full refund', async () => {
  const client = makeClient({ id: 'o-3', status: 'pending_store_acceptance', ...paidCard });
  pool.connect = jest.fn().mockResolvedValue(client);
  pool.query = jest.fn().mockResolvedValue({ rows: [] });
  await rejectPendingAcceptance('o-3', { actorId: 'store-user-1', actorRole: 'store', reason: 'Item out of stock' });
  expectFullRefund(client, 'o-3', 'Item out of stock');
  const cancellation = client.calls.find(([s]) => /INSERT INTO order_cancellations/i.test(s));
  // customer_item_refund = the whole item value, delivery_fee_refunded = the whole fee
  expect(cancellation[1]).toEqual(expect.arrayContaining([100, 30]));
});

// PR G1 (#106), race found in review: the timer scans, then the customer
// cancels a ready order (10% charge) or a driver accepts, before the timer's
// own transaction. Under the row lock the timer re-checks and backs off, so
// it never records a second, full_refund cancellation over the customer's.
describe('the timers re-check the order under the lock', () => {
  test.each([
    ['the customer already cancelled it', { status: 'cancelled', driver_id: null }],
    ['a driver accepted it meanwhile', { status: 'driver_assigned', driver_id: 'driver-1' }],
  ])('no driver timer: %s, so nothing is recorded or refunded', async (_label, now) => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-4', ...paidCard }] });
    const client = makeClient({ id: 'o-4', ...paidCard, ...now });
    pool.connect = jest.fn().mockResolvedValue(client);
    const result = await cancelNoDriverOrders({});
    expect(result).toEqual(expect.objectContaining({ cancelled: 0 }));
    expect(client.calls.some(([s]) => /INSERT INTO order_cancellations/i.test(s))).toBe(false);
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
    expect(client.calls.some(([s]) => /^ROLLBACK/.test(s.trim()))).toBe(true);
  });

  test('preparation timer: the store marked it ready meanwhile, so nothing is recorded or refunded', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-5', order_number: 'FL-5', ...paidCard }] });
    const client = makeClient({ id: 'o-5', ...paidCard, status: 'waiting_for_driver' });
    pool.connect = jest.fn().mockResolvedValue(client);
    await cancelStalePreparingOrders({});
    expect(client.calls.some(([s]) => /INSERT INTO order_cancellations/i.test(s))).toBe(false);
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
  });
});
