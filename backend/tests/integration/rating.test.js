'use strict';
/**
 * tests/integration/rating.test.js
 *
 * Coverage-remediation Phase 2 — Rating.submitRating, the driver-rating/
 * feedback write path (POST /api/orders/:orderId/rate-driver). Zero test
 * coverage existed before this file, despite it being a real, multi-step
 * transaction: it locks the order row, checks ownership/assignment/
 * completion, enforces "one rating per order", inserts the rating, and
 * recomputes the driver's aggregate rating from every rating they've ever
 * received -- exactly the kind of real DB-dependent aggregate logic a
 * mocked pool can't meaningfully prove (a scripted mock would just be
 * asserting the arithmetic I write in the test, not the real SQL AVG()).
 * Real, unmocked integration test against the isolated test DB.
 *
 * Real-world scenarios this file protects:
 *   - a customer rates their driver after a real completed delivery -> the
 *     rating is stored and the driver's public rating updates correctly
 *   - the same customer rates a second completed delivery by the same
 *     driver -> the driver's rating becomes a real average of both, not
 *     just the latest value
 *   - a customer tries to rate an order that isn't theirs (IDOR) -> rejected
 *   - a customer tries to rate a driver who wasn't actually assigned to
 *     that order -> rejected
 *   - a customer tries to rate a delivery that hasn't completed yet -> rejected
 *   - a customer tries to submit a second rating for the same order -> rejected
 *   - garbage rating values (0, 6, non-integer) -> rejected before any DB write
 */

const db = require('../../src/config/database');
const Rating = require('../../src/models/Rating');

async function makeTestUser(tag) {
  const email = `rating-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Rating Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestDriver(tag) {
  const email = `rating-test-driver-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO drivers (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Rating Test Driver (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestOrder({ userId, driverId, status }) {
  const orderNumber = `RATING-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await db.query(
    `INSERT INTO orders (order_number, user_id, driver_id, status, subtotal, delivery_fee, total)
     VALUES ($1, $2, $3, $4, 100, 90, 190) RETURNING id`,
    [orderNumber, userId, driverId, status],
  );
  return result.rows[0].id;
}

async function cleanup({ orderIds = [], userIds = [], driverIds = [] }) {
  for (const orderId of orderIds) {
    if (orderId) await db.query('DELETE FROM driver_ratings WHERE order_id = $1', [orderId]);
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

describe('Rating.submitRating — real driver rating/feedback (integration, real DB)', () => {
  afterAll(async () => {
    await db.end();
  });

  // ─── Real-world scenario: a customer rates their driver after delivery ──
  test('a customer can rate a real completed delivery, and the driver\'s rating updates', async () => {
    const userId = await makeTestUser('success');
    const driverId = await makeTestDriver('success');
    const orderId = await makeTestOrder({ userId, driverId, status: 'completed' });

    try {
      const result = await Rating.submitRating(orderId, userId, driverId, 5, 'Great service!');

      expect(result.rating).toBe(5);
      expect(result.driverAvgRating).toBe(5);
      expect(result.driverRatingCount).toBe(1);

      const stored = await db.query('SELECT * FROM driver_ratings WHERE order_id = $1', [orderId]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].rating).toBe(5);
      expect(stored.rows[0].comment).toBe('Great service!');

      const driver = await db.query('SELECT rating FROM drivers WHERE id = $1', [driverId]);
      expect(parseFloat(driver.rows[0].rating)).toBe(5);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  // ─── Real-world scenario: the same driver gets rated across two real deliveries ──
  test('a second rating for the same driver produces a real average, not just the latest value', async () => {
    const userId = await makeTestUser('average');
    const driverId = await makeTestDriver('average');
    const orderA = await makeTestOrder({ userId, driverId, status: 'completed' });
    const orderB = await makeTestOrder({ userId, driverId, status: 'completed' });

    try {
      await Rating.submitRating(orderA, userId, driverId, 5, null);
      const second = await Rating.submitRating(orderB, userId, driverId, 3, null);

      expect(second.driverRatingCount).toBe(2);
      expect(second.driverAvgRating).toBe(4); // (5 + 3) / 2

      const driver = await db.query('SELECT rating FROM drivers WHERE id = $1', [driverId]);
      expect(parseFloat(driver.rows[0].rating)).toBe(4);
    } finally {
      await cleanup({ orderIds: [orderA, orderB], userIds: [userId], driverIds: [driverId] });
    }
  });

  // ─── Real-world scenario: garbage input never reaches the database ──
  test('rejects a rating of 0', async () => {
    await expect(Rating.submitRating('any-order-id', 'any-user', 'any-driver', 0, null))
      .rejects.toThrow(/Rating must be an integer between 1 and 5/);
  });

  test('rejects a rating of 6', async () => {
    await expect(Rating.submitRating('any-order-id', 'any-user', 'any-driver', 6, null))
      .rejects.toThrow(/Rating must be an integer between 1 and 5/);
  });

  // Caught a real bug writing this test (fixed the same day, see Rating.js's
  // own BUG FIX comment): the original code used parseInt(rating, 10),
  // which truncates rather than rejects -- parseInt(3.5, 10) is 3, a valid
  // in-range integer, so this fractional rating was silently being
  // recorded as a 3-star rating instead of rejected as the error message
  // always claimed. Number.isInteger(Number(rating)) now correctly
  // distinguishes 3 from 3.5.
  test('rejects a non-integer (fractional) rating', async () => {
    await expect(Rating.submitRating('any-order-id', 'any-user', 'any-driver', 3.5, null))
      .rejects.toThrow(/Rating must be an integer between 1 and 5/);
  });

  test('rejects a non-numeric rating', async () => {
    await expect(Rating.submitRating('any-order-id', 'any-user', 'any-driver', 'five', null))
      .rejects.toThrow(/Rating must be an integer between 1 and 5/);
  });

  // Confirms the fix (Number(rating) instead of parseInt(rating, 10))
  // didn't break the legitimate case it was explicitly meant to keep
  // working: req.body.rating isn't guaranteed to be a JS number by any
  // validator upstream, so a numeric string must still be accepted.
  test('accepts a rating sent as a numeric string, same as a real number', async () => {
    const userId = await makeTestUser('string-rating');
    const driverId = await makeTestDriver('string-rating');
    const orderId = await makeTestOrder({ userId, driverId, status: 'completed' });

    try {
      const result = await Rating.submitRating(orderId, userId, driverId, '4', null);
      expect(result.rating).toBe(4);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  // ─── Real-world scenario: the order genuinely doesn't exist ──
  test('rejects rating a nonexistent order', async () => {
    await expect(
      Rating.submitRating('00000000-0000-0000-0000-000000000000', 'any-user', 'any-driver', 5, null),
    ).rejects.toThrow(/Order not found/);
  });

  // ─── Real-world scenario: IDOR -- someone tries to rate an order that isn't theirs ──
  test('rejects when the caller is not the order\'s own customer', async () => {
    const realOwnerId = await makeTestUser('idor-owner');
    const attackerId = await makeTestUser('idor-attacker');
    const driverId = await makeTestDriver('idor');
    const orderId = await makeTestOrder({ userId: realOwnerId, driverId, status: 'completed' });

    try {
      await expect(Rating.submitRating(orderId, attackerId, driverId, 5, null))
        .rejects.toThrow(/Not your order/);

      const stored = await db.query('SELECT * FROM driver_ratings WHERE order_id = $1', [orderId]);
      expect(stored.rows).toHaveLength(0);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [realOwnerId, attackerId], driverIds: [driverId] });
    }
  });

  // ─── Real-world scenario: rating a driver who was never actually assigned ──
  test('rejects when the given driver was not the one assigned to the order', async () => {
    const userId = await makeTestUser('wrong-driver');
    const realDriverId = await makeTestDriver('wrong-driver-real');
    const otherDriverId = await makeTestDriver('wrong-driver-other');
    const orderId = await makeTestOrder({ userId, driverId: realDriverId, status: 'completed' });

    try {
      await expect(Rating.submitRating(orderId, userId, otherDriverId, 5, null))
        .rejects.toThrow(/This driver was not assigned to this order/);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [realDriverId, otherDriverId] });
    }
  });

  test('rejects when the order has no driver assigned at all', async () => {
    const userId = await makeTestUser('no-driver');
    const someDriverId = await makeTestDriver('no-driver-target');
    const orderId = await makeTestOrder({ userId, driverId: null, status: 'completed' });

    try {
      await expect(Rating.submitRating(orderId, userId, someDriverId, 5, null))
        .rejects.toThrow(/This driver was not assigned to this order/);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [someDriverId] });
    }
  });

  // ─── Real-world scenario: trying to rate before the delivery is actually done ──
  test('rejects rating a delivery that has not completed yet', async () => {
    const userId = await makeTestUser('not-completed');
    const driverId = await makeTestDriver('not-completed');
    const orderId = await makeTestOrder({ userId, driverId, status: 'in_transit' });

    try {
      await expect(Rating.submitRating(orderId, userId, driverId, 5, null))
        .rejects.toThrow(/only rate a delivery after it is completed/);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });

  // ─── Real-world scenario: a customer tries to rate the same delivery twice ──
  test('rejects a second rating attempt for the same order', async () => {
    const userId = await makeTestUser('duplicate');
    const driverId = await makeTestDriver('duplicate');
    const orderId = await makeTestOrder({ userId, driverId, status: 'completed' });

    try {
      await Rating.submitRating(orderId, userId, driverId, 4, 'First rating');

      await expect(Rating.submitRating(orderId, userId, driverId, 1, 'Trying again'))
        .rejects.toThrow(/already rated this delivery/);

      // Still exactly one rating row, and it's still the original.
      const stored = await db.query('SELECT rating FROM driver_ratings WHERE order_id = $1', [orderId]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].rating).toBe(4);
    } finally {
      await cleanup({ orderIds: [orderId], userIds: [userId], driverIds: [driverId] });
    }
  });
});
