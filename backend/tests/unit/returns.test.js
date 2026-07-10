'use strict';
/**
 * tests/unit/returns.test.js
 *
 * Unit coverage for the rebuilt item-level returns flow (Return.js):
 * request eligibility/validation, admin dispatch (approveReturn), admin
 * rejection, and refund finalization. Includes an explicit regression proof
 * for the locked-in build requirement: rejecting a return must never touch
 * driver_wallets/driver_wallet_ledger under any circumstance — a driver who
 * completes the reverse-delivery leg is paid through the ordinary
 * order-completion path (orderStateMachineService.js), fully decoupled from
 * whatever the admin later decides about the refund.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/refundService');

const pool = require('../../src/config/database');
const RefundService = require('../../src/services/refundService');
const Return = require('../../src/models/Return');

const ORDER_ID = 'order-uuid-001';
const USER_ID  = 'user-uuid-001';
const RETURN_ID = 'return-uuid-001';

function makeClient(overrides = {}) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([sql, params]);
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (overrides.onQuery) {
      const result = overrides.onQuery(s, params);
      if (result !== undefined) return result;
    }
    return { rows: [] };
  });
  return { query, release: jest.fn(), calls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── requestReturn ──────────────────────────────────────────────────────────

describe('Return.requestReturn', () => {
  const deliveredAt = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago — within 48h window

  function orderRow(overrides = {}) {
    return { id: ORDER_ID, status: 'completed', user_id: USER_ID, delivered_at: deliveredAt, ...overrides };
  }

  test('rejects when delivered_at is null (eligibility unverifiable)', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM orders WHERE id = \$1/.test(s)) return { rows: [orderRow({ delivered_at: null })] };
      },
    });
    pool.connect.mockResolvedValue(client);

    await expect(Return.requestReturn(ORDER_ID, USER_ID, [{ order_item_id: 'oi-1', quantity_returned: 1 }], null))
      .rejects.toThrow('Return eligibility cannot be verified for this order');
  });

  test('rejects once the 48-hour window has expired', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM orders WHERE id = \$1/.test(s)) return { rows: [orderRow()] };
        if (/within_window/.test(s)) return { rows: [{ within_window: false }] };
      },
    });
    pool.connect.mockResolvedValue(client);

    await expect(Return.requestReturn(ORDER_ID, USER_ID, [{ order_item_id: 'oi-1', quantity_returned: 1 }], null))
      .rejects.toThrow('Return window has expired');
  });

  test('rejects a quantity greater than what was originally purchased', async () => {
    const client = makeClient({
      onQuery: (s, params) => {
        if (/FROM orders WHERE id = \$1/.test(s)) return { rows: [orderRow()] };
        if (/within_window/.test(s)) return { rows: [{ within_window: true }] };
        if (/FROM order_items/.test(s)) return { rows: [{ id: 'oi-1', quantity: 2, unit_price: '500.00' }] };
      },
    });
    pool.connect.mockResolvedValue(client);

    await expect(
      Return.requestReturn(ORDER_ID, USER_ID, [{ order_item_id: 'oi-1', quantity_returned: 3 }], null),
    ).rejects.toThrow('Cannot return more than the originally purchased quantity');
  });

  test('rejects when selected items total less than the flat R100 fee', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM orders WHERE id = \$1/.test(s)) return { rows: [orderRow()] };
        if (/within_window/.test(s)) return { rows: [{ within_window: true }] };
        if (/FROM order_items/.test(s)) return { rows: [{ id: 'oi-1', quantity: 2, unit_price: '50.00' }] };
      },
    });
    pool.connect.mockResolvedValue(client);

    await expect(
      Return.requestReturn(ORDER_ID, USER_ID, [{ order_item_id: 'oi-1', quantity_returned: 1 }], null),
    ).rejects.toThrow('Selected items must total at least R100.00 to submit a return');
  });

  test('computes fee/refund correctly and inserts one return_request_items row per selected line', async () => {
    const client = makeClient({
      onQuery: (s, params) => {
        if (/FROM orders WHERE id = \$1/.test(s)) return { rows: [orderRow()] };
        if (/within_window/.test(s)) return { rows: [{ within_window: true }] };
        if (/FROM order_items/.test(s)) {
          return {
            rows: [
              { id: 'oi-1', quantity: 2, unit_price: '150.00' },
              { id: 'oi-2', quantity: 1, unit_price: '80.00' },
            ],
          };
        }
        if (/INSERT INTO return_requests/.test(s)) {
          return { rows: [{ id: RETURN_ID, order_id: ORDER_ID, user_id: USER_ID, fee_amount: params[3], refund_amount: params[4] }] };
        }
      },
    });
    pool.connect.mockResolvedValue(client);

    const result = await Return.requestReturn(
      ORDER_ID, USER_ID,
      [{ order_item_id: 'oi-1', quantity_returned: 2 }, { order_item_id: 'oi-2', quantity_returned: 1 }],
      'changed my mind',
    );

    // (150*2 + 80*1) - 100 fee = 300 + 80 - 100 = 280
    expect(result.refund_amount).toBe(280);
    expect(result.fee_amount).toBe(100);

    const itemInserts = client.calls.filter(([sql]) => /INSERT INTO return_request_items/.test(sql));
    expect(itemInserts).toHaveLength(2);
  });
});

// ─── rejectReturn — the payout-decoupling proof ────────────────────────────

describe('Return.rejectReturn — driver payout decoupling', () => {
  test('rejects a return already delivered by the driver WITHOUT touching driver_wallets/driver_wallet_ledger', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM return_requests WHERE id = \$1 FOR UPDATE/.test(s)) {
          return { rows: [{ id: RETURN_ID, status: 'approved', order_id: ORDER_ID, user_id: USER_ID }] };
        }
        if (/UPDATE return_requests/.test(s)) {
          return { rows: [{ id: RETURN_ID, status: 'rejected' }] };
        }
      },
    });
    pool.connect.mockResolvedValue(client);

    const result = await Return.rejectReturn(RETURN_ID, 'admin-uuid', 'Item was damaged, not eligible');

    expect(result.status).toBe('rejected');

    // The explicit proof: not one query issued during rejection references
    // driver_wallets or driver_wallet_ledger in any form.
    const touchedWallet = client.calls.some(
      ([sql]) => /driver_wallet/i.test(sql),
    );
    expect(touchedWallet).toBe(false);
  });

  test('rejects from the requested state too (never dispatched)', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM return_requests WHERE id = \$1 FOR UPDATE/.test(s)) {
          return { rows: [{ id: RETURN_ID, status: 'requested', order_id: ORDER_ID, user_id: USER_ID }] };
        }
        if (/UPDATE return_requests/.test(s)) {
          return { rows: [{ id: RETURN_ID, status: 'rejected' }] };
        }
      },
    });
    pool.connect.mockResolvedValue(client);

    const result = await Return.rejectReturn(RETURN_ID, 'admin-uuid', 'Outside policy');
    expect(result.status).toBe('rejected');
  });

  test('rejects rejection of an already-terminal return', async () => {
    const client = makeClient({
      onQuery: (s) => {
        if (/FROM return_requests WHERE id = \$1 FOR UPDATE/.test(s)) {
          return { rows: [{ id: RETURN_ID, status: 'refunded' }] };
        }
      },
    });
    pool.connect.mockResolvedValue(client);

    await expect(Return.rejectReturn(RETURN_ID, 'admin-uuid', 'too late'))
      .rejects.toThrow('Return request is not in a rejectable state');
  });
});

// ─── finalizeRefund ─────────────────────────────────────────────────────────

describe('Return.finalizeRefund', () => {
  test('refuses to finalize before the reverse-delivery order is completed', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: RETURN_ID, status: 'approved', return_order_status: 'in_transit', order_id: ORDER_ID, user_id: USER_ID, refund_amount: '150.00' }],
    });

    await expect(Return.finalizeRefund(RETURN_ID, 'admin-uuid'))
      .rejects.toThrow('Reverse-delivery order has not been completed yet');

    expect(RefundService.refundOrderPayment).not.toHaveBeenCalled();
  });

  test('finalizes the refund with the pre-computed fee-netted amount once delivered', async () => {
    pool.query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{ id: RETURN_ID, status: 'approved', return_order_status: 'completed', order_id: ORDER_ID, user_id: USER_ID, refund_amount: '280.00' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: RETURN_ID, status: 'refunded' }] });

    RefundService.refundOrderPayment = jest.fn().mockResolvedValue({ id: 'refund-uuid', status: 'processing' });

    const result = await Return.finalizeRefund(RETURN_ID, 'admin-uuid');

    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith(ORDER_ID, USER_ID, 'return_refund', 280);
    expect(result.status).toBe('refunded');
  });

  test('rejects finalizing a return not currently awaiting final review', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [{ id: RETURN_ID, status: 'rejected', return_order_status: 'completed' }],
    });

    await expect(Return.finalizeRefund(RETURN_ID, 'admin-uuid'))
      .rejects.toThrow('Return request is not awaiting final review');
  });
});

// ─── getPendingForAdmin ─────────────────────────────────────────────────────

describe('Return.getPendingForAdmin', () => {
  test('returns both requested (not yet dispatched) and approved returns, distinguishing in-transit from awaiting-final-review via return_order_status', async () => {
    pool.query = jest.fn().mockResolvedValue({
      rows: [
        { id: 'ret-0', status: 'requested', return_order_status: null, order_number: 'FLASH-0' },
        { id: 'ret-1', status: 'approved', return_order_status: 'in_transit', order_number: 'FLASH-1' },
        { id: 'ret-2', status: 'approved', return_order_status: 'completed', order_number: 'FLASH-2' },
      ],
    });

    const result = await Return.getPendingForAdmin();

    expect(result).toHaveLength(3);
    expect(result[0].status).toBe('requested');
    expect(result[2].return_order_status).toBe('completed');
    expect(pool.query.mock.calls[0][0]).toMatch(/WHERE rr\.status IN \('requested', 'approved'\)/);
  });
});
