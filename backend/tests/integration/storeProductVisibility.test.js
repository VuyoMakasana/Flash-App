'use strict';
/**
 * tests/integration/storeProductVisibility.test.js
 *
 * H4 + C3 (#94), against a REAL local Postgres (the SQL filter is the thing
 * under test, so a mock would prove nothing):
 *   - customers only see products whose store is active AND approved, the
 *     same rule the storefront already applies to stores (Store.listActive);
 *   - Order.create refuses any other product, and never charges a client
 *     price.
 * Every row this test creates is tagged with a random suffix and deleted in
 * afterAll. Skipped when DATABASE_URL is not set (tests/setup/testEnv.js
 * refuses anything that is not a local database).
 */
const crypto = require('crypto');

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

d('H4/C3: only products of active, approved stores can be seen and ordered', () => {
  let pool;
  let Inventory;
  let Order;
  const tag = `vis-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const stores = {};
  const products = {};
  let userId;
  const orderIds = [];

  const order = (items) => Order.create({
    userId,
    items,
    delivery_mode: 'fleet',
    pickup_lat: -33.884221,
    pickup_lng: 25.5853185,
    dropoff_lat: -33.95,
    dropoff_lng: 25.61,
  });

  beforeAll(async () => {
    pool = require('../../src/config/database');
    Inventory = require('../../src/models/Inventory');
    Order = require('../../src/models/Order');

    const cases = {
      approved: { status: 'approved', is_active: true },
      approvedInactive: { status: 'approved', is_active: false },
      suspended: { status: 'suspended', is_active: true },
      rejected: { status: 'rejected', is_active: true },
      pending: { status: 'pending', is_active: true },
    };
    for (const [key, s] of Object.entries(cases)) {
      const r = await pool.query(
        'INSERT INTO stores (name, status, is_active) VALUES ($1, $2, $3) RETURNING id',
        [`${tag}-${key}`, s.status, s.is_active],
      );
      stores[key] = r.rows[0].id;
      const p = await pool.query(
        `INSERT INTO flash_inventory (product_name, category, price, sizes, stock_by_size, store_id, is_active)
         VALUES ($1, $2, 50.00, '["M"]', '{"M": 5}', $3, true) RETURNING id`,
        [`${tag}-${key}-tee`, tag, stores[key]],
      );
      products[key] = p.rows[0].id;
    }
    const inactive = await pool.query(
      `INSERT INTO flash_inventory (product_name, category, price, sizes, stock_by_size, store_id, is_active)
       VALUES ($1, $2, 50.00, '["M"]', '{"M": 5}', $3, false) RETURNING id`,
      [`${tag}-inactive-product`, tag, stores.approved],
    );
    products.inactiveProduct = inactive.rows[0].id;
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [tag, `${tag}@flash.invalid`],
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    if (orderIds.length) {
      await pool.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await pool.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds]);
    }
    await pool.query('DELETE FROM flash_inventory WHERE category = $1', [tag]);
    await pool.query('DELETE FROM stores WHERE name LIKE $1', [`${tag}-%`]);
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  test('the product list shows only the approved, active store\'s active product', async () => {
    const listed = await Inventory.getProducts(tag, 1, 100);
    expect(listed.map((p) => p.id)).toEqual([products.approved]);
  });

  test('a single product is visible only when its store is approved and active', async () => {
    expect((await Inventory.getProduct(products.approved))?.id).toBe(products.approved);
    for (const key of ['approvedInactive', 'suspended', 'rejected', 'pending', 'inactiveProduct']) {
      expect(await Inventory.getProduct(products[key])).toBeUndefined();
    }
  });

  test('an approved store\'s product can be ordered, at the server price', async () => {
    const created = await order([{ productId: products.approved, name: 'Tee', price: 1, size: 'M', quantity: 2 }]);
    orderIds.push(created.id);
    expect(Number(created.subtotal)).toBe(100);
    expect(created.store_id).toBe(stores.approved);
    // FI-113: the real jsonb stock was decremented for the chosen size.
    const stock = await pool.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [products.approved]);
    expect(stock.rows[0].stock_by_size).toEqual({ M: 3 });
  });

  test('FI-113: a sized product ordered with no size, or an unknown size, is refused and stock is untouched', async () => {
    await expect(order([{ productId: products.approved, name: 'Tee', quantity: 1 }]))
      .rejects.toThrow(/Please choose a size for/);
    await expect(order([{ productId: products.approved, name: 'Tee', size: 'XXL', quantity: 1 }]))
      .rejects.toThrow(/isn't available in size XXL/);
    await expect(order([{ productId: products.approved, name: 'Tee', size: 'M', quantity: 4 }]))
      .rejects.toThrow(/size M is out of stock/);
    const stock = await pool.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [products.approved]);
    expect(stock.rows[0].stock_by_size).toEqual({ M: 3 });
  });

  test.each(['approvedInactive', 'suspended', 'rejected', 'pending', 'inactiveProduct'])(
    'a product of a %s store (or an inactive product) is refused, and its stock is untouched',
    async (key) => {
      await expect(order([{ productId: products[key], name: 'Tee', price: 1, size: 'M', quantity: 1 }]))
        .rejects.toThrow(/is no longer available/);
      const stock = await pool.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [products[key]]);
      expect(stock.rows[0].stock_by_size).toEqual({ M: 5 });
    },
  );

  test('an item with no productId is refused (no client price, ever)', async () => {
    await expect(order([{ name: 'External', price: 1, quantity: 1 }])).rejects.toThrow(/is no longer available/);
  });
});
