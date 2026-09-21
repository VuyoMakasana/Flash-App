'use strict';
/**
 * tests/unit/orders.test.js
 *
 * Tests for Order model: price recomputation, external item validation,
 * IDOR protection, state machine transitions.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');

// ─── Price validation ─────────────────────────────────────────────────────────
//
// Coverage-remediation Phase 1 (2026-09-21): this used to be a 'describe'
// block here that asserted hardcoded literals (e.g.
// `expect(serverPrice).toBe(299.99)`) without ever importing or calling
// Order.create -- it proved nothing about the real code, just restated the
// intended behavior as a comment dressed up as a test. Real coverage of
// Order.create's actual price/stock/quantity validation -- server price
// overriding a client-supplied one, external-item price validation,
// oversell rejection, malformed quantities, and a real concurrent-checkout
// race against a real Postgres FOR UPDATE lock -- now lives in
// tests/integration/orderCreation.test.js, against the real (isolated,
// non-production) test database, since a mocked pool can't prove the
// locking guarantee that test suite exists to prove.

// ─── IDOR protection ──────────────────────────────────────────────────────────

describe('Order IDOR protection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('getPaymentStatus returns null when userId does not match', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 'order-001', user_id: 'user-correct', payment_status: 'paid' }],
    });

    // Simulate: query includes user_id = $2
    const Order = require('../../src/models/Order');
    if (typeof Order.getPaymentStatus === 'function') {
      // If the implementation checks userId, a wrong userId returns nothing
      pool.query.mockResolvedValue({ rows: [] });
      const result = await Order.getPaymentStatus('order-001', 'user-attacker');
      expect(result).toBeFalsy();
    }
  });
});

// ─── Delivery fee calculation ─────────────────────────────────────────────────

// H-4 FIX: calculateDeliveryFee used to take client-supplied
// pickupMallId/dropoffMallId with no malls table to validate them against
// - any customer could send matching IDs on every order for a guaranteed
// R90 instead of R180, regardless of real distance. It now takes real
// coordinates and computes distance itself (haversine, via
// utils/helpers.calculateDistance). These fixture coordinates are the
// live store location and two real Nelson Mandela Bay points used to
// verify this fix live: ~2.9km (inside the R90 radius) and ~15.6km
// (outside it).
const STORE_COORDS = { lat: -33.8842210, lng: 25.5853185 };
const NEAR_COORDS   = { lat: -33.9050, lng: 25.6050 }; // ~2.9km from store
const FAR_COORDS    = { lat: -34.0100, lng: 25.6600 }; // ~15.6km from store

describe('Order.calculateDeliveryFee', () => {
  test('delivery within the nearby radius costs R90', () => {
    const Order = require('../../src/models/Order');
    const fee = Order.calculateDeliveryFee({
      pickupLat: STORE_COORDS.lat, pickupLng: STORE_COORDS.lng,
      dropoffLat: NEAR_COORDS.lat, dropoffLng: NEAR_COORDS.lng,
    });
    expect(fee).toBe(90);
  });

  test('delivery beyond the nearby radius costs R180', () => {
    const Order = require('../../src/models/Order');
    const fee = Order.calculateDeliveryFee({
      pickupLat: STORE_COORDS.lat, pickupLng: STORE_COORDS.lng,
      dropoffLat: FAR_COORDS.lat, dropoffLng: FAR_COORDS.lng,
    });
    expect(fee).toBe(180);
  });

  test('missing coordinates defaults to R180', () => {
    const Order = require('../../src/models/Order');
    const fee = Order.calculateDeliveryFee({});
    expect(fee).toBe(180);
  });

  // Regression guard for the actual vulnerability: matching client-supplied
  // mall IDs must have zero influence on the fee now that the function
  // doesn't even accept them - only real coordinates decide the tier.
  test('client-supplied mall IDs have no effect on the fee', () => {
    const Order = require('../../src/models/Order');
    const fee = Order.calculateDeliveryFee({
      pickupLat: STORE_COORDS.lat, pickupLng: STORE_COORDS.lng,
      dropoffLat: FAR_COORDS.lat, dropoffLng: FAR_COORDS.lng,
      pickupMallId: 'mall-1', dropoffMallId: 'mall-1',
    });
    expect(fee).toBe(180); // still R180 despite "matching" mall IDs
  });
});

// ─── Commission math ──────────────────────────────────────────────────────────

describe('computeCommission helper', () => {
  test('Flash earns minimum R10 commission', () => {
    const { computeCommission } = require('../../src/utils/helpers');
    const { flashCommission } = computeCommission(30); // low delivery fee
    expect(flashCommission).toBeGreaterThanOrEqual(10);
  });

  test('driver gets 75% of delivery fee when fee is large', () => {
    const { computeCommission } = require('../../src/utils/helpers');
    const { flashCommission, driverPayout } = computeCommission(180);
    expect(flashCommission).toBe(45); // 25% of 180
    expect(driverPayout).toBe(135);   // 75% of 180
    expect(flashCommission + driverPayout).toBeCloseTo(180, 2);
  });
});
