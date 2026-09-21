'use strict';
/**
 * tests/integration/orderCreation.test.js
 *
 * Coverage-remediation Phase 1 — Order.create is the single most important
 * write path in the app ("a customer places an order") and, before this
 * file, had zero real test coverage: the previous tests/unit/orders.test.js
 * "Order price validation" block asserted hardcoded literals
 * (`expect(serverPrice).toBe(299.99)`) without ever importing or calling
 * the real model — it proved nothing about the actual code.
 *
 * This is a REAL integration test, not a mocked unit test, and deliberately
 * so: Order.create's core guarantee (no oversold stock under concurrent
 * checkouts) rests on a real Postgres row lock (`SELECT ... FOR UPDATE`
 * inside a real transaction — see Order.js). A mocked pg Pool has no real
 * locking semantics, so it cannot prove or disprove that guarantee — only
 * two genuinely concurrent connections against a real database can. Runs
 * against the isolated Supabase test project (DATABASE_URL from .env /
 * process.env), never production. src/config/database is NOT mocked here.
 *
 * Every test creates its own throwaway user/product rows and deletes them
 * (and the orders/order_items it created) afterward — no shared fixtures,
 * no dependency on whatever else happens to be seeded in the test project.
 */

const db = require('../../src/config/database');
const Order = require('../../src/models/Order');
const Store = require('../../src/models/Store');

const FLASH_STORE_LAT = -33.8842210;
const FLASH_STORE_LNG = 25.5853185;
// Inside the NMB bounding box (backend/src/utils/geoBoundary.js) AND within
// calculateDeliveryFee's 5km "nearby" radius of FLASH_STORE_LOCATION — a
// customer a couple of streets over, R90 delivery tier.
const NEARBY_DROPOFF = { lat: -33.8860, lng: 25.5870 };

async function makeTestUser(tag) {
  const email = `order-create-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Order Creation Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestProduct({ storeId, stock, price = 299.99 }) {
  const result = await db.query(
    `INSERT INTO flash_inventory (product_name, category, price, sizes, stock_by_size, is_active, store_id)
     VALUES ('Order Creation Test Product', 'test', $1, '["M"]', $2, true, $3)
     RETURNING id`,
    [price, JSON.stringify(stock), storeId],
  );
  return result.rows[0].id;
}

async function cleanupOrder(orderId) {
  if (!orderId) return;
  // order_items cascades on orders delete (ON DELETE CASCADE) — one delete
  // is enough, but being explicit costs nothing and doesn't rely on that
  // constraint being what it looks like.
  await db.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
  await db.query('DELETE FROM orders WHERE id = $1', [orderId]);
}

async function cleanupProduct(productId) {
  if (productId) await db.query('DELETE FROM flash_inventory WHERE id = $1', [productId]);
}

async function cleanupUser(userId) {
  if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

function baseOrderInput(overrides = {}) {
  return {
    delivery_mode: 'standard',
    time_slot: 'ASAP',
    subtotal: 0,
    store_id: null, // real code path always resolves this itself; see below
    preferred_driver_id: null,
    pickup_address: '12B Mkele Street, Kwazakhele',
    dropoff_address: 'Test dropoff address',
    pickup_lat: FLASH_STORE_LAT,
    pickup_lng: FLASH_STORE_LNG,
    dropoff_lat: NEARBY_DROPOFF.lat,
    dropoff_lng: NEARBY_DROPOFF.lng,
    ...overrides,
  };
}

describe('Order.create — real order placement (integration, real DB)', () => {
  let userId;
  let productId;
  let defaultStoreId;
  let createdOrderId;

  beforeAll(async () => {
    // Order.create resolves store_id itself via Store.getDefaultStoreId()
    // when the controller calls it — captured once here so assertions
    // don't hardcode a UUID that only happens to be right today.
    defaultStoreId = await Store.getDefaultStoreId();
  });

  afterEach(async () => {
    await cleanupOrder(createdOrderId);
    createdOrderId = null;
    await cleanupProduct(productId);
    productId = null;
    await cleanupUser(userId);
    userId = null;
  });

  afterAll(async () => {
    await db.end();
  });

  // ─── Real-world scenario: a customer buys one real item, checkout succeeds ──
  test('a valid order for a real inventory item persists correctly end to end', async () => {
    userId = await makeTestUser('success');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 5 } });

    const order = await Order.create(baseOrderInput({
      userId,
      items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 2, price: 0.01 }],
      store_id: defaultStoreId,
    }));
    createdOrderId = order.id;

    // Real store attribution (storefront/store-portal audit Piece 4's
    // whole premise depends on this being a real, non-null UUID).
    expect(order.store_id).toBe(defaultStoreId);
    expect(order.status).toBe('payment_pending');
    expect(order.order_number).toMatch(/^FLASH-/);

    // Server price (299.99), not the attacker-supplied 0.01, times qty 2.
    expect(parseFloat(order.subtotal)).toBeCloseTo(299.99 * 2, 2);
    // Nearby dropoff -> R90 delivery tier (calculateDeliveryFee).
    expect(parseFloat(order.delivery_fee)).toBe(90);
    expect(parseFloat(order.total)).toBeCloseTo(299.99 * 2 + 90, 2);

    // The real row in the DB, not just the returned object — proves the
    // INSERT actually committed what create() claims it did.
    const persisted = await db.query('SELECT * FROM orders WHERE id = $1', [order.id]);
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].store_id).toBe(defaultStoreId);

    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0].product_id).toBe(productId);
    expect(items.rows[0].quantity).toBe(2);
    expect(parseFloat(items.rows[0].unit_price)).toBeCloseTo(299.99, 2);

    // Stock actually decremented by the real quantity bought.
    const product = await db.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [productId]);
    expect(product.rows[0].stock_by_size.M).toBe(3);
  });

  // ─── Real-world scenario: an attacker tries to buy at a price they made up ──
  test('server price wins over a client-supplied price for a real inventory item', async () => {
    userId = await makeTestUser('price-override');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 5 }, price: 150 });

    const order = await Order.create(baseOrderInput({
      userId,
      items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 1, price: 0.01 }],
    }));
    createdOrderId = order.id;

    expect(parseFloat(order.subtotal)).toBeCloseTo(150, 2);
    const items = await db.query('SELECT unit_price FROM order_items WHERE order_id = $1', [order.id]);
    expect(parseFloat(items.rows[0].unit_price)).toBeCloseTo(150, 2);
  });

  // ─── Real-world scenario: cart says "2 left" but someone else just bought them ──
  test('rejects an order that requests more than available stock, and leaves stock untouched', async () => {
    userId = await makeTestUser('oversell');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 1 } });

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 5, price: 299.99 }],
      })),
    ).rejects.toThrow(/out of stock/);

    // Transaction rolled back -- no order row, and stock is exactly what it
    // was before the rejected attempt (not partially decremented).
    const product = await db.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [productId]);
    expect(product.rows[0].stock_by_size.M).toBe(1);
  });

  // ─── Real-world scenario: a buggy or malicious client sends a bad quantity ──
  test('rejects a zero quantity', async () => {
    userId = await makeTestUser('qty-zero');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 5 } });

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 0, price: 299.99 }],
      })),
    ).rejects.toThrow(/Invalid quantity/);
  });

  test('rejects a negative quantity', async () => {
    userId = await makeTestUser('qty-negative');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 5 } });

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: -3, price: 299.99 }],
      })),
    ).rejects.toThrow(/Invalid quantity/);
  });

  test('rejects a non-integer quantity', async () => {
    userId = await makeTestUser('qty-fractional');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 5 } });

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 1.5, price: 299.99 }],
      })),
    ).rejects.toThrow(/Invalid quantity/);
  });

  // ─── Real-world scenario: a genuinely external/partner item (no Flash productId) ──
  test('rejects a non-positive client price for an external item with no productId', async () => {
    userId = await makeTestUser('external-bad-price');

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ name: 'External Item', quantity: 1, price: 0 }],
      })),
    ).rejects.toThrow(/Invalid price/);
  });

  // FIXED BUG (found while writing this test, 2026-09-21; fixed the same
  // day on explicit instruction after being reported and confirmed):
  // order_items.product_id is NOT NULL (migrate.js), and a genuinely
  // external item (no productId, a valid positive price) used to pass
  // price validation and then hit that NOT NULL constraint in the second
  // (order_items) INSERT loop, which runs *after* all price/quantity
  // validation has already passed for every item -- an unhandled Postgres
  // constraint-violation error instead of the clean, intentional 400 the
  // rest of this validation gives for bad input. Order.create now rejects
  // this case itself, in the same place and the same way as its other
  // validation failures (see the BUG FIX comment on the EXTERNAL STORE
  // PATH branch in Order.js), so it maps to a plain 400 for the customer.
  // Confirmed this was never reachable from the real shipped user app
  // (every cart item in flash-user-app/context/FlashContext.js comes from
  // api.products.getAll() -- real flash_inventory rows, always a real id)
  // -- this test protects currently-unreachable-but-real code, the same
  // as it did before the fix.
  test('rejects a valid-priced external item with no productId at all, cleanly', async () => {
    userId = await makeTestUser('external-no-productid-fixed');

    await expect(
      Order.create(baseOrderInput({
        userId,
        items: [{ name: 'External Item', quantity: 1, price: 50 }],
      })),
    ).rejects.toThrow(/a productId is required/);

    // No half-written order left behind.
    const orphaned = await db.query(
      `SELECT id FROM orders WHERE user_id = $1`,
      [userId],
    );
    expect(orphaned.rows).toHaveLength(0);
  });

  // ─── Real-world scenario: two customers race for the last unit of stock ──
  //
  // This is the test a mocked pool cannot give you: it proves Order.create's
  // `SELECT ... FOR UPDATE` (Order.js) actually serializes two concurrent
  // checkouts against the same real Postgres row, rather than both reading
  // stock=1 before either writes and both succeeding (the classic
  // check-then-act race). Two real connections, two real users, fired at
  // the same time with Promise.allSettled.
  test('two concurrent orders against one unit of stock: exactly one succeeds, stock never goes negative', async () => {
    const userA = await makeTestUser('race-a');
    const userB = await makeTestUser('race-b');
    productId = await makeTestProduct({ storeId: defaultStoreId, stock: { M: 1 } });

    try {
      const [resultA, resultB] = await Promise.allSettled([
        Order.create(baseOrderInput({
          userId: userA,
          items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 1, price: 299.99 }],
        })),
        Order.create(baseOrderInput({
          userId: userB,
          items: [{ productId, name: 'Order Creation Test Product', size: 'M', quantity: 1, price: 299.99 }],
        })),
      ]);

      const outcomes = [resultA, resultB];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.message).toMatch(/out of stock/);

      createdOrderId = fulfilled[0].value.id;

      // Stock landed at exactly 0 -- never negative, never still 1 (i.e.
      // the winning order really did decrement it).
      const product = await db.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [productId]);
      expect(product.rows[0].stock_by_size.M).toBe(0);

      // Exactly one order_items row exists for this product across both
      // attempts -- no double-fulfillment, no phantom second row.
      const items = await db.query('SELECT * FROM order_items WHERE product_id = $1', [productId]);
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0].quantity).toBe(1);
    } finally {
      // Order first -- it FK-references whichever user won, so deleting
      // that user first would violate orders_user_id_fkey. afterEach's own
      // cleanupOrder(createdOrderId) below is then a harmless no-op.
      await cleanupOrder(createdOrderId);
      createdOrderId = null;
      await cleanupUser(userA);
      await cleanupUser(userB);
    }
  });
});
