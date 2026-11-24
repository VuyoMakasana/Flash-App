'use strict';
/**
 * tests/unit/realMoneyRecovery.test.js
 *
 * H1 (#94): the no-driver timeout must cancel CASH orders too. Cash orders sit
 *   at payment_status 'pending_cash' (they're paid at the door), and the old
 *   query only selected payment_status = 'paid', so a cash order with no
 *   driver waited forever (HANDOFF's known launch-blocking bug).
 * H6 (#94): an order whose payment succeeded (payment_status = 'paid') but
 *   whose status change after it failed was left at 'payment_pending', which
 *   none of the recovery jobs selected.
 *
 * Same mock pattern as stuckOrderRecovery.test.js, with an order row that
 * remembers its status so two transitions in a row are checked for real.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/refundService');
jest.mock('../../src/services/operatingHoursService');
jest.mock('@sentry/node');

const pool = require('../../src/config/database');
const notificationService = require('../../src/services/notificationService');
const RefundService = require('../../src/services/refundService');
const operatingHours = require('../../src/services/operatingHoursService');
const Sentry = require('@sentry/node');
const {
  cancelNoDriverOrders,
  recoverPaidOrdersStuckAtPaymentPending,
} = require('../../src/services/orderStateMachineService');

// An order row that remembers status changes made by updateOrderStatus.
function makeClient(row) {
  const state = { ...row };
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([sql, params]);
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
const io = () => ({ to: jest.fn().mockReturnThis(), emit: jest.fn() });

beforeEach(() => {
  jest.clearAllMocks();
  notificationService.notifyUserOrderUpdate = jest.fn().mockResolvedValue();
  operatingHours.isClosedNow.mockReturnValue(false);
});

describe('H1: cancelNoDriverOrders handles cash orders', () => {
  test('selects card orders that are paid AND cash orders that are pending_cash, with no driver, past the threshold', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await cancelNoDriverOrders({});
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'waiting_for_driver'/);
    expect(sql).toMatch(/driver_id IS NULL/);
    expect(sql).toMatch(/payment_status = 'paid'/);
    expect(sql).toMatch(/payment_method = 'cash' AND payment_status = 'pending_cash'/);
    expect(params).toEqual([30]);
  });

  test('a cash order is cancelled, with no refund attempt, and the customer is told they were not charged', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-cash', user_id: 'u-1', payment_method: 'cash', payment_status: 'pending_cash' }] });
    const client = makeClient({ id: 'o-cash', status: 'waiting_for_driver', user_id: 'u-1', payment_method: 'cash' });
    pool.connect = jest.fn().mockResolvedValue(client);
    const sock = io();

    const result = await cancelNoDriverOrders({ io: sock });

    expect(result).toEqual({ cancelled: 1, total: 1 });
    expect(client.state.status).toBe('cancelled');
    expect(client.calls.find(([sql]) => /INSERT INTO order_cancellations/i.test(sql))[0]).toMatch(/no_driver_available_timeout/);
    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
    expect(sock.emit).toHaveBeenCalledWith('order_update', expect.objectContaining({
      orderId: 'o-cash', status: 'cancelled', message: expect.stringMatching(/not been charged/),
    }));
  });

  test('a paid card order is cancelled and refunded in full, as before', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-card', user_id: 'u-2', payment_method: 'card', payment_status: 'paid' }] });
    pool.connect = jest.fn().mockResolvedValue(makeClient({ id: 'o-card', status: 'waiting_for_driver', user_id: 'u-2', payment_method: 'card' }));
    RefundService.refundOrderPayment.mockResolvedValue({ status: 'processing' });

    await cancelNoDriverOrders({ io: io() });

    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith('o-card', 'u-2', 'no_driver_available_timeout');
  });

  test('one order failing does not stop the rest', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [
      { id: 'o-bad', user_id: 'u-1', payment_method: 'cash', payment_status: 'pending_cash' },
      { id: 'o-ok', user_id: 'u-2', payment_method: 'cash', payment_status: 'pending_cash' },
    ] });
    const bad = { query: jest.fn().mockRejectedValue(new Error('boom')), release: jest.fn() };
    const ok = makeClient({ id: 'o-ok', status: 'waiting_for_driver', user_id: 'u-2', payment_method: 'cash' });
    pool.connect = jest.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);

    expect(await cancelNoDriverOrders({})).toEqual({ cancelled: 1, total: 2 });
  });

  test('server.js no longer carries its own copy of the no-driver query', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/server.js'), 'utf8');
    expect(src).toMatch(/cancelNoDriverOrders/);
    expect(src).not.toMatch(/stuckPaidOrders/);
  });
});

describe('H6: recoverPaidOrdersStuckAtPaymentPending', () => {
  test('selects only payment_pending orders whose payment_status is already paid, past the threshold (default 10 minutes)', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await recoverPaidOrdersStuckAtPaymentPending({});
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'payment_pending'/);
    expect(sql).toMatch(/payment_status = 'paid'/);
    expect(params).toEqual([10]);
  });

  test('advances a stuck paid order to pending_store_acceptance (through paid) and alerts admin', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-1' }] });
    const client = makeClient({ id: 'o-1', order_number: 'FLASH-1', status: 'payment_pending', payment_status: 'paid', user_id: 'u-1' });
    pool.connect = jest.fn().mockResolvedValue(client);
    const sock = io();

    const result = await recoverPaidOrdersStuckAtPaymentPending({ io: sock });

    expect(result).toEqual({ recovered: 1, total: 1 });
    const statuses = client.calls.filter(([sql]) => /^\s*UPDATE orders\s+SET status = \$1/i.test(sql)).map(([, p]) => p[0]);
    expect(statuses).toEqual(['paid', 'pending_store_acceptance']);
    expect(sock.emit).toHaveBeenCalledWith('fleet_alert', expect.objectContaining({ type: 'new_order_pending_acceptance', orderId: 'o-1' }));
  });

  test('outside operating hours it parks the order for the morning, exactly like the webhook does', async () => {
    operatingHours.isClosedNow.mockReturnValue(true);
    operatingHours.getNextOpenTime.mockReturnValue(new Date('2026-11-25T05:00:00Z'));
    pool.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 'o-2' }] }).mockResolvedValue({ rows: [] });
    const client = makeClient({ id: 'o-2', status: 'payment_pending', payment_status: 'paid', user_id: 'u-1' });
    pool.connect = jest.fn().mockResolvedValue(client);

    await recoverPaidOrdersStuckAtPaymentPending({});

    expect(client.state.status).toBe('scheduled_for_morning');
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/SET scheduled_for = \$1/), [new Date('2026-11-25T05:00:00Z'), 'o-2']);
  });

  test('a failure is reported to Sentry, never swallowed', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 'o-3' }] });
    pool.connect = jest.fn().mockResolvedValue({ query: jest.fn().mockRejectedValue(new Error('still broken')), release: jest.fn() });

    expect(await recoverPaidOrdersStuckAtPaymentPending({})).toEqual({ recovered: 0, total: 1 });
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('o-3') }));
  });

  test('the recover-stuck-paid cron runs it', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/server.js'), 'utf8');
    expect(src).toMatch(/recoverPaidOrdersStuckAtPaymentPending/);
  });
});
