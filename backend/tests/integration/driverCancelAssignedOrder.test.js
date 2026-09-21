'use strict';
/**
 * tests/integration/driverCancelAssignedOrder.test.js
 *
 * Coverage-remediation Phase 3 — DriverController.cancelAssignedOrder, the
 * real "I accepted this by mistake / can't do this delivery" self-cancel
 * flow. Unlike acceptOrder (a thin wrapper around the well-tested
 * assignDriver service), this controller hand-rolls its own real
 * transaction directly (cancel_count increment + wallet reversal +
 * penalty insert + order requeue, all sharing one commit) -- exactly the
 * kind of real, multi-table transactional correctness a mocked pool can
 * only assert the right SQL strings were called, not that the actual
 * sequence produces the right end state. Real, unmocked integration test
 * against the isolated test DB, same reasoning as
 * tests/integration/driverAutoSuspension.test.js and
 * tests/integration/orderCreation.test.js's concurrency test.
 *
 * Real-world scenarios this file protects:
 *   - a driver accepts an order, then realizes they can't do it and cancels
 *     before pickup -> the order goes back to the pool, their pending
 *     wallet credit for it is reversed, and they take a real, fixed R20
 *     penalty
 *   - a driver tries to cancel an order that isn't theirs -> rejected
 *   - a driver tries to cancel after they've already picked the item up ->
 *     rejected (this requires an admin override past this point, not a
 *     driver self-cancel)
 *   - an order id that doesn't exist -> a clean 404
 */

const db = require('../../src/config/database');
const DriverController = require('../../src/controllers/driverController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function mockReq(driverId, orderId) {
  return { userId: driverId, params: { orderId }, app: { get: () => null } };
}

async function makeTestUser(tag) {
  const email = `cancel-assigned-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Cancel-Assigned Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestDriver(tag) {
  const email = `cancel-assigned-test-driver-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO drivers (name, email, password_hash, status, cancel_count) VALUES ($1, $2, 'x', 'approved', 0) RETURNING id`,
    [`Cancel-Assigned Test Driver (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeAssignedOrder({ userId, driverId, status = 'driver_assigned', driverPayout = 90 }) {
  const orderNumber = `CANCELASSIGN-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await db.query(
    `INSERT INTO orders (order_number, user_id, driver_id, status, subtotal, delivery_fee, total, driver_payout)
     VALUES ($1, $2, $3, $4, 100, 90, 190, $5) RETURNING id`,
    [orderNumber, userId, driverId, status, driverPayout],
  );
  return result.rows[0].id;
}

async function makeWallet(driverId, pendingBalance) {
  await db.query(`INSERT INTO driver_wallets (driver_id, wallet_balance, pending_balance) VALUES ($1, 0, $2)`, [driverId, pendingBalance]);
}

async function cleanup({ orderIds = [], userIds = [], driverIds = [] }) {
  for (const driverId of driverIds) {
    if (driverId) {
      await db.query('DELETE FROM driver_penalties WHERE driver_id = $1', [driverId]);
      await db.query('DELETE FROM driver_wallet_ledger WHERE driver_id = $1', [driverId]);
      await db.query('DELETE FROM driver_wallets WHERE driver_id = $1', [driverId]);
    }
  }
  for (const orderId of orderIds) {
    if (orderId) await db.query('DELETE FROM orders WHERE id = $1', [orderId]);
  }
  for (const userId of userIds) {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  for (const driverId of driverIds) {
    if (driverId) await db.query('DELETE FROM drivers WHERE id = $1', [driverId]);
  }
}

describe('DriverController.cancelAssignedOrder (integration, real DB)', () => {
  afterAll(async () => {
    await db.end();
  });

  test('a real self-cancel before pickup: requeues the order, penalises the driver, reverses their wallet credit', async () => {
    const userId = await makeTestUser('success');
    const driverId = await makeTestDriver('success');
    const orderId = await makeAssignedOrder({ userId, driverId, driverPayout: 90 });
    await makeWallet(driverId, 200);

    try {
      const req = mockReq(driverId, orderId);
      const res = mockRes();
      await DriverController.cancelAssignedOrder(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, status: 'waiting_for_driver', penaltyApplied: 20 });

      const order = await db.query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('waiting_for_driver');
      expect(order.rows[0].driver_id).toBeNull();

      const driver = await db.query('SELECT cancel_count FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(1);

      const wallet = await db.query('SELECT pending_balance FROM driver_wallets WHERE driver_id = $1', [driverId]);
      expect(parseFloat(wallet.rows[0].pending_balance)).toBe(110); // 200 - 90

      const penalty = await db.query(
        'SELECT amount, reason FROM driver_penalties WHERE driver_id = $1 AND order_id = $2',
        [driverId, orderId],
      );
      expect(penalty.rows).toHaveLength(1);
      expect(parseFloat(penalty.rows[0].amount)).toBe(20);
      expect(penalty.rows[0].reason).toBe('driver_cancelled_before_pickup');
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  test('returns 404 for an order that does not exist', async () => {
    const driverId = await makeTestDriver('404');
    try {
      const req = mockReq(driverId, '00000000-0000-0000-0000-000000000000');
      const res = mockRes();
      await DriverController.cancelAssignedOrder(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    } finally {
      await cleanup({ driverIds: [driverId] });
    }
  });

  test('a driver cannot cancel an order that is not theirs', async () => {
    const userId = await makeTestUser('idor');
    const realDriverId = await makeTestDriver('idor-real');
    const attackerDriverId = await makeTestDriver('idor-attacker');
    const orderId = await makeAssignedOrder({ userId, driverId: realDriverId });

    try {
      const req = mockReq(attackerDriverId, orderId);
      const res = mockRes();
      await DriverController.cancelAssignedOrder(req, res);

      expect(res.status).toHaveBeenCalledWith(403);

      // Untouched -- no penalty, no cancel_count change, order still assigned.
      const order = await db.query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('driver_assigned');
      expect(order.rows[0].driver_id).toBe(realDriverId);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [realDriverId, attackerDriverId] });
    }
  });

  test('rejects cancelling an order that has already been picked up', async () => {
    const userId = await makeTestUser('too-late');
    const driverId = await makeTestDriver('too-late');
    const orderId = await makeAssignedOrder({ userId, driverId, status: 'picked_up' });

    try {
      const req = mockReq(driverId, orderId);
      const res = mockRes();
      await DriverController.cancelAssignedOrder(req, res);

      expect(res.status).toHaveBeenCalledWith(409);

      const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('picked_up'); // untouched

      const driver = await db.query('SELECT cancel_count FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(0); // no penalty applied
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });
});
