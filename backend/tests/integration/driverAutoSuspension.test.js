'use strict';
/**
 * tests/integration/driverAutoSuspension.test.js
 *
 * Coverage-remediation Phase 3 — reassignStuckDriverOrders
 * (src/services/driverAutoSuspensionService.js), newly extracted from a
 * ~130-line inline cron.schedule callback in server.js:430 specifically so
 * it could be tested at all. This is the "a driver accepted an order and
 * then went unavailable" safety net: a driver can go offline, lose their
 * phone, or simply ignore an accepted order, and without this cron the
 * order (and the customer) would be stuck forever with no resolution.
 *
 * Real, unmocked integration test against the isolated test DB -- this
 * touches a real transaction (order requeue + wallet reversal sharing one
 * commit), a real UPDATE-then-SELECT-then-conditionally-UPDATE sequence
 * for the cancel_count/auto-suspend threshold, and a real driver_penalties
 * insert, all of which a mocked pool would only be able to assert I wired
 * the right SQL strings, not that the real sequence produces the right
 * end state.
 *
 * Real-world scenarios this file protects:
 *   - a driver accepts an order, then goes dark for 45+ minutes -> the
 *     order is released back to waiting_for_driver, the driver's pending
 *     wallet credit for it is reversed, and they're penalised once
 *     (cancel_count+1)
 *   - the same driver has now done this 5 times -> they're auto-suspended
 *     (is_online=false, status='suspended') and a real, dated,
 *     admin-visible penalty record explains why
 *   - an order that's merely a few minutes old, or already past the
 *     pre-pickup stage (in_transit/picked_up), is never touched by this
 *     job -- it must not punish a driver who's actively delivering, and it
 *     must not act before the real 45-minute grace period has elapsed
 */

const db = require('../../src/config/database');
const { reassignStuckDriverOrders } = require('../../src/services/driverAutoSuspensionService');

async function makeTestUser(tag) {
  const email = `auto-suspend-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Auto-Suspend Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestDriver(tag, cancelCount = 0) {
  const email = `auto-suspend-test-driver-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO drivers (name, email, password_hash, status, is_online, cancel_count)
     VALUES ($1, $2, 'x', 'approved', true, $3) RETURNING id`,
    [`Auto-Suspend Test Driver (${tag})`, email, cancelCount],
  );
  return result.rows[0].id;
}

async function makeStuckOrder({ userId, driverId, status = 'driver_assigned', minutesAgo = 50, deliveryMode = 'standalone', driverPayout = 90 }) {
  const orderNumber = `AUTOSUSP-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await db.query(
    `INSERT INTO orders (order_number, user_id, driver_id, status, delivery_mode, subtotal, delivery_fee, total, driver_payout, updated_at)
     VALUES ($1, $2, $3, $4, $5, 100, 90, 190, $6, NOW() - ($7 || ' minutes')::interval)
     RETURNING id`,
    [orderNumber, userId, driverId, status, deliveryMode, driverPayout, minutesAgo],
  );
  return result.rows[0].id;
}

async function makeWallet(driverId, pendingBalance) {
  await db.query(
    `INSERT INTO driver_wallets (driver_id, wallet_balance, pending_balance) VALUES ($1, 0, $2)`,
    [driverId, pendingBalance],
  );
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

describe('reassignStuckDriverOrders — driver-timeout reassignment + auto-suspension (integration, real DB)', () => {
  afterAll(async () => {
    await db.end();
  });

  test('reassigns a real stuck order: requeued, driver penalised once, wallet reversed', async () => {
    const userId = await makeTestUser('reassign');
    const driverId = await makeTestDriver('reassign', 0);
    const orderId = await makeStuckOrder({ userId, driverId, driverPayout: 90 });
    await makeWallet(driverId, 200);

    try {
      await reassignStuckDriverOrders({ io: null });

      const order = await db.query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('waiting_for_driver');
      expect(order.rows[0].driver_id).toBeNull();

      const driver = await db.query('SELECT cancel_count, status, is_online FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(1);
      expect(driver.rows[0].status).toBe('approved'); // not suspended -- only one strike
      expect(driver.rows[0].is_online).toBe(true);

      const wallet = await db.query('SELECT pending_balance FROM driver_wallets WHERE driver_id = $1', [driverId]);
      expect(parseFloat(wallet.rows[0].pending_balance)).toBe(110); // 200 - 90

      const ledger = await db.query(
        `SELECT amount, entry_type FROM driver_wallet_ledger WHERE driver_id = $1 AND order_id = $2`,
        [driverId, orderId],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].entry_type).toBe('pending_debit');
      expect(parseFloat(ledger.rows[0].amount)).toBe(90);

      // Below the auto-suspend threshold -- no penalty row yet.
      const penalties = await db.query('SELECT id FROM driver_penalties WHERE driver_id = $1', [driverId]);
      expect(penalties.rows).toHaveLength(0);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  test('auto-suspends a driver whose cancel_count reaches 5, with a real, admin-visible penalty record', async () => {
    const userId = await makeTestUser('suspend');
    const driverId = await makeTestDriver('suspend', 4); // one more strike away
    const orderId = await makeStuckOrder({ userId, driverId, driverPayout: 90 });
    await makeWallet(driverId, 200);

    try {
      await reassignStuckDriverOrders({ io: null });

      const driver = await db.query('SELECT cancel_count, status, is_online FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(5);
      expect(driver.rows[0].status).toBe('suspended');
      expect(driver.rows[0].is_online).toBe(false);

      const penalties = await db.query(
        `SELECT amount, reason, status FROM driver_penalties WHERE driver_id = $1 AND order_id = $2`,
        [driverId, orderId],
      );
      expect(penalties.rows).toHaveLength(1);
      expect(parseFloat(penalties.rows[0].amount)).toBe(0); // not a financial penalty
      expect(penalties.rows[0].status).toBe('applied');
      expect(penalties.rows[0].reason).toMatch(/Auto-suspended by system/);
      expect(penalties.rows[0].reason).toMatch(/cancel_count reached 5/);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  test('does not touch an order that has not been stuck long enough yet (under 45 minutes)', async () => {
    const userId = await makeTestUser('too-recent');
    const driverId = await makeTestDriver('too-recent', 0);
    const orderId = await makeStuckOrder({ userId, driverId, minutesAgo: 5 });

    try {
      await reassignStuckDriverOrders({ io: null });

      const order = await db.query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('driver_assigned');
      expect(order.rows[0].driver_id).toBe(driverId);

      const driver = await db.query('SELECT cancel_count FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(0);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  test('does not touch an order already past the pre-pickup stage (in_transit), even if old', async () => {
    const userId = await makeTestUser('in-transit');
    const driverId = await makeTestDriver('in-transit', 0);
    const orderId = await makeStuckOrder({ userId, driverId, status: 'in_transit', minutesAgo: 90 });

    try {
      await reassignStuckDriverOrders({ io: null });

      const order = await db.query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('in_transit');
      expect(order.rows[0].driver_id).toBe(driverId);

      const driver = await db.query('SELECT cancel_count FROM drivers WHERE id = $1', [driverId]);
      expect(driver.rows[0].cancel_count).toBe(0);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  test('processes multiple real stuck orders for different drivers in one run', async () => {
    const userA = await makeTestUser('multi-a');
    const userB = await makeTestUser('multi-b');
    const driverA = await makeTestDriver('multi-a', 0);
    const driverB = await makeTestDriver('multi-b', 0);
    const orderA = await makeStuckOrder({ userId: userA, driverId: driverA, driverPayout: 50 });
    const orderB = await makeStuckOrder({ userId: userB, driverId: driverB, driverPayout: 70 });
    await makeWallet(driverA, 100);
    await makeWallet(driverB, 100);

    try {
      await reassignStuckDriverOrders({ io: null });

      const [statusA, statusB] = await Promise.all([
        db.query('SELECT status FROM orders WHERE id = $1', [orderA]),
        db.query('SELECT status FROM orders WHERE id = $1', [orderB]),
      ]);
      expect(statusA.rows[0].status).toBe('waiting_for_driver');
      expect(statusB.rows[0].status).toBe('waiting_for_driver');

      const [walletA, walletB] = await Promise.all([
        db.query('SELECT pending_balance FROM driver_wallets WHERE driver_id = $1', [driverA]),
        db.query('SELECT pending_balance FROM driver_wallets WHERE driver_id = $1', [driverB]),
      ]);
      expect(parseFloat(walletA.rows[0].pending_balance)).toBe(50); // 100 - 50
      expect(parseFloat(walletB.rows[0].pending_balance)).toBe(30); // 100 - 70
    } finally {
      await cleanup({ orderIds: [orderA, orderB], userIds: [userA, userB], driverIds: [driverA, driverB] });
    }
  });
});
