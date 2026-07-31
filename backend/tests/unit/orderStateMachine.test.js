'use strict';
/**
 * tests/unit/orderStateMachine.test.js
 *
 * Unit coverage for orderStateMachineService.js — the order lifecycle's
 * source of truth (per CLAUDE.md, do not update orders.status directly
 * anywhere else). H-1 flagged this file at ~4% statement coverage, only
 * exercised indirectly and thinly by tests/integration/productionStateMachine
 * .test.js's 4 end-to-end HTTP tests. This file drives the module's own
 * exported functions directly against a mocked pg client, covering the
 * correctness properties that actually matter here: illegal transitions
 * are rejected, a driver can't touch an order it doesn't own or cancel
 * after pickup, cash orders can't complete unpaid, and double-assignment
 * is prevented atomically.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/models/DriverWallet');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/services/emailService');

const pool = require('../../src/config/database');
const DriverWallet = require('../../src/models/DriverWallet');
const notificationService = require('../../src/services/notificationService');
const emailService = require('../../src/services/emailService');
const {
  canTransition,
  normalizeState,
  updateOrderStatus,
  assignDriver,
  requeueOrderForDriverSearch,
} = require('../../src/services/orderStateMachineService');

// Builds a pg client mock whose .query() inspects the SQL text and returns
// context-appropriate results, rather than hand-sequencing
// mockResolvedValueOnce() chains against every BEGIN/SELECT/UPDATE/ledger
// write this service and DriverWallet issue - the same shared client
// object is used throughout a real transaction, so this mirrors that.
function makeClient(orderRow, overrides = {}) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push([sql, params]);
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (overrides.driverCheck && /FROM drivers\b/i.test(s)) {
      return overrides.driverCheck(params);
    }
    if (/SELECT \* FROM orders WHERE id = \$1\s+FOR UPDATE/i.test(s)) {
      return { rows: orderRow ? [orderRow] : [] };
    }
    if (/UPDATE orders\b/i.test(s)) {
      const updated = overrides.applyUpdate
        ? overrides.applyUpdate(orderRow, params)
        : { ...orderRow };
      return { rows: [updated] };
    }
    return { rows: [] };
  });
  return { query, release: jest.fn(), calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  DriverWallet.addPending = jest.fn().mockResolvedValue();
  DriverWallet.releasePending = jest.fn().mockResolvedValue();
  // notifyUserOrderUpdate's result is chained with .catch() in the real
  // code (a backgrounded push-notification failure must never fail the
  // state transition itself) - the automock's default undefined return
  // would throw on that .catch() call, so give it a real resolved promise.
  notificationService.notifyUserOrderUpdate = jest.fn().mockResolvedValue();
  emailService.sendReturnAwaitingReviewEmail = jest.fn().mockResolvedValue();
  pool.query = jest.fn().mockResolvedValue({ rows: [] });
});

// ─── Pure transition logic ─────────────────────────────────────────────────

describe('canTransition / normalizeState', () => {
  test('allows a valid forward transition', () => {
    expect(canTransition('waiting_for_driver', 'driver_assigned')).toBe(true);
  });

  test('rejects skipping states', () => {
    expect(canTransition('waiting_for_driver', 'completed')).toBe(false);
  });

  test('rejects transitions out of terminal states', () => {
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'paid')).toBe(false);
  });

  test('normalizes the legacy en_route status to driver_arrived_store', () => {
    expect(normalizeState('en_route')).toBe('driver_arrived_store');
  });

  test('canTransition normalizes legacy states on both sides', () => {
    // en_route (legacy data) -> picked_up is really driver_arrived_store -> picked_up, which is allowed
    expect(canTransition('en_route', 'picked_up')).toBe(true);
  });
});

// ─── updateOrderStatus ──────────────────────────────────────────────────────

describe('updateOrderStatus', () => {
  test('rejects an illegal transition', async () => {
    const client = makeClient({ id: 'o1', status: 'waiting_for_driver', user_id: 'u1' });
    pool.connect.mockResolvedValue(client);

    await expect(updateOrderStatus('o1', 'completed')).rejects.toThrow(/Illegal transition/);
  });

  test('is idempotent when the order is already in the target state', async () => {
    const client = makeClient({ id: 'o1', status: 'paid', user_id: 'u1' });
    pool.connect.mockResolvedValue(client);

    const result = await updateOrderStatus('o1', 'paid');
    expect(result.status).toBe('paid');
    // No UPDATE should have run - nothing changed.
    expect(client.calls.some(([sql]) => /UPDATE orders/i.test(sql))).toBe(false);
  });

  test('sets delivered_at the first time an order transitions to delivered', async () => {
    const client = makeClient({ id: 'o1', status: 'in_transit', driver_id: 'driver-A', user_id: 'u1' });
    pool.connect.mockResolvedValue(client);

    await updateOrderStatus('o1', 'delivered', { actorRole: 'driver', actorId: 'driver-A' });

    const updateCall = client.calls.find(([sql]) => /UPDATE orders\b/i.test(sql));
    // params: [status, delivery_payment_status, driver_paid, orderId, deliveredAtParam]
    expect(updateCall[1][4]).toBeInstanceOf(Date);
  });

  test('does not pass a new delivered_at value on a later transition away from delivered', async () => {
    const client = makeClient({ id: 'o1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1', payment_method: 'card' });
    pool.connect.mockResolvedValue(client);

    await updateOrderStatus('o1', 'completed', { actorRole: 'driver', actorId: 'driver-A' });

    const updateCall = client.calls.find(([sql]) => /UPDATE orders\b/i.test(sql));
    // COALESCE(delivered_at, $5) — passing null here means "don't touch it",
    // preserving whatever was already set the first time delivered fired.
    expect(updateCall[1][4]).toBeNull();
  });

  test('emails the admin when a return\'s reverse-delivery order completes while still awaiting review', async () => {
    const client = makeClient({
      id: 'return-order-1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1',
      payment_method: 'store_account', is_return_order: true,
    });
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [{ id: 'return-1', refund_amount: '150.00', order_number: 'FLASH-ABC-RET-1' }],
    });

    await updateOrderStatus('return-order-1', 'completed', { actorRole: 'driver', actorId: 'driver-A' });

    expect(emailService.sendReturnAwaitingReviewEmail).toHaveBeenCalledWith({
      returnId: 'return-1',
      orderNumber: 'FLASH-ABC-RET-1',
      refundAmount: '150.00',
    });
  });

  test('does not email when a regular (non-return) order completes', async () => {
    const client = makeClient({
      id: 'o1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1',
      payment_method: 'card', is_return_order: false,
    });
    pool.connect.mockResolvedValue(client);

    await updateOrderStatus('o1', 'completed', { actorRole: 'driver', actorId: 'driver-A' });

    expect(emailService.sendReturnAwaitingReviewEmail).not.toHaveBeenCalled();
  });

  test('a driver cannot change an order assigned to a different driver', async () => {
    const client = makeClient({ id: 'o1', status: 'driver_assigned', driver_id: 'driver-A', user_id: 'u1' });
    pool.connect.mockResolvedValue(client);

    await expect(
      updateOrderStatus('o1', 'driver_arrived_store', { actorRole: 'driver', actorId: 'driver-B' }),
    ).rejects.toThrow(/Driver cannot change this order/);
  });

  test('a driver cannot self-cancel after pickup', async () => {
    const client = makeClient({ id: 'o1', status: 'in_transit', driver_id: 'driver-A', user_id: 'u1' });
    pool.connect.mockResolvedValue(client);

    // in_transit -> cancelled isn't even in ALLOWED_TRANSITIONS, so this
    // also proves the ownership/pickup guard isn't the only thing standing
    // between a driver and an illegal post-pickup cancellation.
    await expect(
      updateOrderStatus('o1', 'cancelled', { actorRole: 'driver', actorId: 'driver-A' }),
    ).rejects.toThrow(/Illegal transition/);
  });

  // NOTE (new observation, not fixed here - out of H-1's scope): the
  // `getStateRank(currentState) >= getStateRank('picked_up')` guard inside
  // updateOrderStatus (the one that would throw "Cannot cancel after
  // pickup without admin override") is dead code as currently written.
  // ALLOWED_TRANSITIONS never lists 'cancelled' as a valid target from
  // picked_up, in_transit, delivered, or completed, so canTransition()
  // always rejects with "Illegal transition" first, for every state the
  // rank guard would otherwise have caught - confirmed by checking every
  // post-pickup state's transition list contains no 'cancelled' entry.
  // Not a security gap (the outcome - rejection - is the same either way),
  // just redundant/unreachable code worth a cleanup pass sometime.

  test('rejects completing an unpaid cash order', async () => {
    const client = makeClient({
      id: 'o1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1',
      payment_method: 'cash', payment_status: 'pending',
    });
    pool.connect.mockResolvedValue(client);

    await expect(updateOrderStatus('o1', 'completed')).rejects.toThrow(/Cash orders require payment confirmation/);
  });

  test('completing a non-cash order releases the driver\'s pending wallet balance exactly once', async () => {
    const orderRow = {
      id: 'o1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1',
      payment_method: 'card', payment_status: 'paid',
      driver_payout: '135.00', driver_paid: false,
    };
    const client = makeClient(orderRow, {
      applyUpdate: (row, params) => ({ ...row, status: params[0], driver_paid: true }),
    });
    pool.connect.mockResolvedValue(client);

    const result = await updateOrderStatus('o1', 'completed');
    expect(result.status).toBe('completed');
    expect(DriverWallet.releasePending).toHaveBeenCalledTimes(1);
    expect(DriverWallet.releasePending).toHaveBeenCalledWith(
      client, 'driver-A', 135, 'o1', 'delivery_completed_release',
    );
  });

  test('does not double-pay a driver already marked driver_paid', async () => {
    const orderRow = {
      id: 'o1', status: 'delivered', driver_id: 'driver-A', user_id: 'u1',
      payment_method: 'card', payment_status: 'paid',
      driver_payout: '135.00', driver_paid: true,
    };
    const client = makeClient(orderRow, {
      applyUpdate: (row, params) => ({ ...row, status: params[0] }),
    });
    pool.connect.mockResolvedValue(client);

    await updateOrderStatus('o1', 'completed');
    expect(DriverWallet.releasePending).not.toHaveBeenCalled();
  });

  test('an externally-joined transaction does not issue its own BEGIN/COMMIT/ROLLBACK', async () => {
    // 'paid' no longer transitions directly to 'waiting_for_driver' -- the
    // store accept/reject/preparing gate (docs/audits/FLASH_STORE_ADMIN_DESIGN.md
    // §0) sits between them now. Starting from 'preparing' instead keeps
    // this test verifying what it actually tests (externalClient mechanics),
    // not a status pair that happens to be illegal after that change.
    const orderRow = { id: 'o1', status: 'preparing', user_id: 'u1' };
    const client = makeClient(orderRow, {
      applyUpdate: (row, params) => ({ ...row, status: params[0] }),
    });

    await updateOrderStatus('o1', 'waiting_for_driver', { externalClient: client });

    expect(client.calls.some(([sql]) => sql.trim().startsWith('BEGIN'))).toBe(false);
    expect(client.calls.some(([sql]) => sql.trim().startsWith('COMMIT'))).toBe(false);
    // Caller owns the client, so this function must not release it either.
    expect(client.release).not.toHaveBeenCalled();
  });
});

// ─── assignDriver (double-assignment race prevention) ──────────────────────

describe('assignDriver', () => {
  test('rejects assignment when the driver is no longer available', async () => {
    const client = makeClient(
      { id: 'o1', status: 'waiting_for_driver' },
      { driverCheck: () => ({ rows: [] }) }, // the FOR UPDATE + NOT EXISTS check found nothing
    );
    pool.connect.mockResolvedValue(client);

    await expect(assignDriver('o1', 'driver-A')).rejects.toThrow(/Driver no longer available/);
    // Must roll back, not silently swallow, so the row lock is released.
    expect(client.calls.some(([sql]) => sql.trim().startsWith('ROLLBACK'))).toBe(true);
  });

  test('rejects assignment when the order is not waiting_for_driver', async () => {
    const client = makeClient(
      { id: 'o1', status: 'driver_assigned' },
      { driverCheck: () => ({ rows: [{ id: 'driver-A' }] }) },
    );
    pool.connect.mockResolvedValue(client);

    await expect(assignDriver('o1', 'driver-A')).rejects.toThrow(/not ready for assignment/);
  });

  test('rejects assignment when the order already has a driver (second racer loses)', async () => {
    const client = makeClient(
      { id: 'o1', status: 'waiting_for_driver', driver_id: 'driver-EARLIER' },
      { driverCheck: () => ({ rows: [{ id: 'driver-A' }] }) },
    );
    pool.connect.mockResolvedValue(client);

    await expect(assignDriver('o1', 'driver-A')).rejects.toThrow(/already assigned/);
  });

  test('successfully assigns an available driver and credits their pending wallet', async () => {
    const orderRow = { id: 'o1', status: 'waiting_for_driver', driver_id: null, user_id: 'u1', driver_payout: '135.00' };
    const client = makeClient(orderRow, {
      driverCheck: () => ({ rows: [{ id: 'driver-A' }] }),
      applyUpdate: (row) => ({ ...row, driver_id: 'driver-A', status: 'driver_assigned' }),
    });
    pool.connect.mockResolvedValue(client);

    const result = await assignDriver('o1', 'driver-A');
    expect(result.status).toBe('driver_assigned');
    expect(result.driver_id).toBe('driver-A');
    expect(DriverWallet.addPending).toHaveBeenCalledWith(client, 'driver-A', 135, 'o1', 'driver_assigned_pending');
  });

  test('rejects a non-preferred driver during the trusted-driver exclusivity window', async () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const orderRow = {
      id: 'o1', status: 'waiting_for_driver', driver_id: null, user_id: 'u1',
      preferred_driver_id: 'driver-TRUSTED', preferred_driver_expires_at: futureExpiry,
    };
    const client = makeClient(orderRow, { driverCheck: () => ({ rows: [{ id: 'driver-A' }] }) });
    pool.connect.mockResolvedValue(client);

    await expect(
      assignDriver('o1', 'driver-A', { enforceTrustedDriverWindow: true }),
    ).rejects.toThrow(/reserved for the customer's trusted driver/);
  });

  test('allows the preferred driver themself during the exclusivity window', async () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const orderRow = {
      id: 'o1', status: 'waiting_for_driver', driver_id: null, user_id: 'u1',
      preferred_driver_id: 'driver-TRUSTED', preferred_driver_expires_at: futureExpiry, driver_payout: '90.00',
    };
    const client = makeClient(orderRow, {
      driverCheck: () => ({ rows: [{ id: 'driver-TRUSTED' }] }),
      applyUpdate: (row) => ({ ...row, driver_id: 'driver-TRUSTED', status: 'driver_assigned' }),
    });
    pool.connect.mockResolvedValue(client);

    const result = await assignDriver('o1', 'driver-TRUSTED', { enforceTrustedDriverWindow: true });
    expect(result.driver_id).toBe('driver-TRUSTED');
  });

  test('allows any driver once the exclusivity window has expired', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const orderRow = {
      id: 'o1', status: 'waiting_for_driver', driver_id: null, user_id: 'u1',
      preferred_driver_id: 'driver-TRUSTED', preferred_driver_expires_at: pastExpiry, driver_payout: '90.00',
    };
    const client = makeClient(orderRow, {
      driverCheck: () => ({ rows: [{ id: 'driver-A' }] }),
      applyUpdate: (row) => ({ ...row, driver_id: 'driver-A', status: 'driver_assigned' }),
    });
    pool.connect.mockResolvedValue(client);

    const result = await assignDriver('o1', 'driver-A', { enforceTrustedDriverWindow: true });
    expect(result.driver_id).toBe('driver-A');
  });
});

// ─── requeueOrderForDriverSearch ────────────────────────────────────────────

describe('requeueOrderForDriverSearch', () => {
  test('rejects requeuing from a state that was never assigned', async () => {
    const client = makeClient({ id: 'o1', status: 'waiting_for_driver' });
    pool.connect.mockResolvedValue(client);

    await expect(requeueOrderForDriverSearch('o1')).rejects.toThrow(/cannot be re-queued/);
  });

  test('a driver cannot re-queue an order assigned to someone else', async () => {
    const client = makeClient({ id: 'o1', status: 'driver_assigned', driver_id: 'driver-A' });
    pool.connect.mockResolvedValue(client);

    await expect(
      requeueOrderForDriverSearch('o1', { actorRole: 'driver', actorId: 'driver-B' }),
    ).rejects.toThrow(/cannot re-queue this order/);
  });

  test('clears the driver and returns the order to waiting_for_driver', async () => {
    const orderRow = { id: 'o1', status: 'driver_assigned', driver_id: 'driver-A', user_id: 'u1' };
    const client = makeClient(orderRow, {
      applyUpdate: (row) => ({ ...row, driver_id: null, status: 'waiting_for_driver' }),
    });
    pool.connect.mockResolvedValue(client);

    const result = await requeueOrderForDriverSearch('o1');
    expect(result.status).toBe('waiting_for_driver');
    expect(result.driver_id).toBeNull();
  });
});
