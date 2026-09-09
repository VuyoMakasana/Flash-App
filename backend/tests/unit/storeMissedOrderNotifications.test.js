'use strict';
/**
 * tests/unit/storeMissedOrderNotifications.test.js
 *
 * Production-readiness audit §2.12 (store missed-order reliability). A new
 * order reaching pending_store_acceptance previously had ZERO proactive
 * admin-facing signal -- no io.to('admin') socket alert (every other real
 * admin alert in this codebase -- SOS, stuck-delivery, driver-connection-
 * lost, refund-failed -- has one; this transition never did), and no email
 * fallback (emailService.js already had the exact proven pattern for
 * "don't rely solely on a live socket connection", sendSosAlertEmail/
 * sendReturnAwaitingReviewEmail -- nothing equivalent existed here). Worse,
 * when the timeout cron actually auto-cancelled a genuinely missed order --
 * a real lost sale -- that produced nothing but a console.log.
 *
 * Covers the three-tier fix: an immediate socket alert on arrival, a
 * one-time escalation email if still unhandled past a threshold well short
 * of the real auto-cancel timeout, and the missed-order email when that
 * timeout actually fires.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/refundService');
jest.mock('../../src/services/notificationService');

const pool = require('../../src/config/database');
const emailService = require('../../src/services/emailService');
const notificationService = require('../../src/services/notificationService');
const {
  notifyAdminNewOrderPendingAcceptance,
  escalateStuckPendingAcceptanceOrders,
  escalateStuckPreparingOrders,
  rejectPendingAcceptance,
} = require('../../src/services/orderStateMachineService');

function makeIo() {
  return { to: jest.fn().mockReturnThis(), emit: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  notificationService.notifyUserOrderUpdate = jest.fn().mockResolvedValue();
});

describe('notifyAdminNewOrderPendingAcceptance', () => {
  test('emits a fleet_alert to the admin room with the order details', () => {
    const io = makeIo();
    notifyAdminNewOrderPendingAcceptance({ id: 'order-1', order_number: 'FLASH-1' }, io);

    expect(io.to).toHaveBeenCalledWith('admin');
    expect(io.emit).toHaveBeenCalledWith('fleet_alert', {
      type: 'new_order_pending_acceptance',
      orderId: 'order-1',
      orderNumber: 'FLASH-1',
      message: expect.stringContaining('FLASH-1'),
    });
  });

  test('does nothing when io is not available (no live connection to broadcast to)', () => {
    expect(() => notifyAdminNewOrderPendingAcceptance({ id: 'order-1', order_number: 'FLASH-1' }, null)).not.toThrow();
  });
});

describe('escalateStuckPendingAcceptanceOrders', () => {
  test('sends an escalation email for each stuck order and flags it idempotently', async () => {
    const order = { id: 'order-1', order_number: 'FLASH-1', total: '200.00' };
    pool.query = jest.fn().mockResolvedValue({ rows: [order] });

    const result = await escalateStuckPendingAcceptanceOrders({});

    expect(result).toEqual({ escalated: 1, total: 1 });
    expect(emailService.sendOrderEscalationEmail).toHaveBeenCalledWith(order, 'acceptance');
    const updateCall = pool.query.mock.calls.find(([sql]) => /UPDATE orders SET acceptance_escalated_at/i.test(sql));
    expect(updateCall[1]).toEqual(['order-1']);
  });

  test('only looks at orders where acceptance_escalated_at is still NULL (never re-escalates)', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await escalateStuckPendingAcceptanceOrders({});
    expect(pool.query.mock.calls[0][0]).toMatch(/acceptance_escalated_at IS NULL/);
  });

  test('defaults to a 5-minute threshold', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await escalateStuckPendingAcceptanceOrders({});
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [5]);
  });

  test('one order failing to escalate does not stop the rest', async () => {
    pool.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'order-1', order_number: 'A' }, { id: 'order-2', order_number: 'B' }] })
      .mockRejectedValueOnce(new Error('DB blip'))
      .mockResolvedValueOnce({ rows: [] });

    const result = await escalateStuckPendingAcceptanceOrders({});

    expect(result).toEqual({ escalated: 1, total: 2 });
  });
});

describe('escalateStuckPreparingOrders', () => {
  test('sends an escalation email and flags preparation_escalated_at', async () => {
    const order = { id: 'order-2', order_number: 'FLASH-2', total: '90.00' };
    pool.query = jest.fn().mockResolvedValue({ rows: [order] });

    const result = await escalateStuckPreparingOrders({});

    expect(result).toEqual({ escalated: 1, total: 1 });
    expect(emailService.sendOrderEscalationEmail).toHaveBeenCalledWith(order, 'preparation');
    const updateCall = pool.query.mock.calls.find(([sql]) => /UPDATE orders SET preparation_escalated_at/i.test(sql));
    expect(updateCall[1]).toEqual(['order-2']);
  });

  test('defaults to a 20-minute threshold (same 10-minute buffer ratio as the 30-minute preparing timeout)', async () => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] });
    await escalateStuckPreparingOrders({});
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [20]);
  });
});

describe('rejectPendingAcceptance — missed-order email (§2.12)', () => {
  function makeClient(orderRow) {
    const query = jest.fn(async (sql) => {
      const s = sql.trim();
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
      if (/SELECT \* FROM orders WHERE id = \$1\s+FOR UPDATE/i.test(s)) return { rows: [orderRow] };
      if (/UPDATE orders\b/i.test(s)) return { rows: [{ ...orderRow, status: 'cancelled' }] };
      if (/INSERT INTO order_cancellations/i.test(s)) return { rows: [] };
      return { rows: [] };
    });
    return { query, release: jest.fn() };
  }

  const baseOrder = {
    id: 'order-1', order_number: 'FLASH-1', user_id: 'user-1', status: 'pending_store_acceptance',
    payment_method: 'cash', payment_status: 'pending', subtotal: '100.00', delivery_fee: '30.00', total: '130.00',
  };

  test('sends a missed-order email when the system (timeout cron) cancels it', async () => {
    pool.query = jest.fn(); // unused directly; client.query does the work
    pool.connect = jest.fn().mockResolvedValue(makeClient(baseOrder));

    await rejectPendingAcceptance('order-1', {
      actorRole: 'system',
      cancelledByRole: 'system',
      reason: 'store_acceptance_timeout',
    });

    expect(emailService.sendOrderMissedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1' }), 'acceptance',
    );
  });

  test('does NOT send a missed-order email for a real store-initiated reject', async () => {
    pool.connect = jest.fn().mockResolvedValue(makeClient(baseOrder));

    await rejectPendingAcceptance('order-1', {
      actorRole: 'admin',
      cancelledByRole: 'store',
      reason: 'out of stock',
    });

    expect(emailService.sendOrderMissedEmail).not.toHaveBeenCalled();
  });
});
