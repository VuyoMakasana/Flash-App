'use strict';
/**
 * tests/unit/orderClientPriceTrust.test.js
 *
 * C3 (#94): a client price is never trusted. Order.create used to accept an
 * item with no productId, or with a productId that matched no active product
 * (unknown, inactive, or a suspended store's), at whatever price the app sent
 * (anything from R0.01 to R100,000). Now every item must be a real, active
 * product whose store is active and approved, and its price always comes from
 * the server.
 *
 * Calls the REAL Order.create against a mocked pg client, like
 * orderStoreAttribution.test.js. The store-status SQL filter itself is proven
 * against a real Postgres in tests/integration/storeProductVisibility.test.js.
 */
jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const Order = require('../../src/models/Order');

const STORE_A = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const UNKNOWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
const SUBTOTAL_PARAM_INDEX = 4; // $5 of the INSERT INTO orders

function makeClient({ inventory }) {
  const captured = { insertOrderParams: null, inventoryLookups: [] };
  const client = {
    query: jest.fn(async (sql, params) => {
      const text = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (text.includes('FROM store_promotions')) return { rows: [] };
      if (text.includes('FROM flash_inventory') && text.includes('FOR UPDATE')) {
        captured.inventoryLookups.push({ text, params });
        const row = inventory[params[0]];
        return { rows: row ? [row] : [] };
      }
      if (text.includes('premium_subscriptions')) return { rows: [] };
      if (text.includes('INSERT INTO orders')) {
        captured.insertOrderParams = params;
        return { rows: [{ id: 'order-1', order_number: 'FL-TEST' }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return captured;
}

const baseArgs = {
  userId: 'user-1',
  delivery_mode: 'fleet',
  pickup_lat: -33.96,
  pickup_lng: 25.6,
  dropoff_lat: -33.95,
  dropoff_lng: 25.61,
};
const realProduct = { id: P1, price: '50.00', product_name: 'Tee', stock_by_size: { M: 5 }, store_id: STORE_A };

afterEach(() => jest.clearAllMocks());

describe('C3: Order.create never trusts a client price', () => {
  test('an item with no productId is refused, and no order is written', async () => {
    const captured = makeClient({ inventory: {} });
    await expect(Order.create({ ...baseArgs, items: [{ name: 'Anything', price: 1, quantity: 1 }] }))
      .rejects.toThrow(/is no longer available/);
    expect(captured.insertOrderParams).toBeNull();
  });

  test('a productId that matches no active product (unknown, inactive or a non-approved store) is refused', async () => {
    const captured = makeClient({ inventory: {} });
    await expect(Order.create({ ...baseArgs, items: [{ productId: UNKNOWN, name: 'Gone', price: 1, size: 'M', quantity: 1 }] }))
      .rejects.toThrow(/"Gone" is no longer available/);
    expect(captured.insertOrderParams).toBeNull();
  });

  test('a productId that is not a UUID is refused before any database lookup', async () => {
    const captured = makeClient({ inventory: {} });
    await expect(Order.create({ ...baseArgs, items: [{ productId: 'p1', name: 'Demo', price: 1299, quantity: 1 }] }))
      .rejects.toThrow(/is no longer available/);
    expect(captured.inventoryLookups).toHaveLength(0);
    expect(captured.insertOrderParams).toBeNull();
  });

  test('one bad item refuses the whole basket, even next to a real product', async () => {
    const captured = makeClient({ inventory: { [P1]: realProduct } });
    await expect(Order.create({
      ...baseArgs,
      items: [
        { productId: P1, name: 'Tee', size: 'M', quantity: 1 },
        { name: 'External item', price: 30, quantity: 1 },
      ],
    })).rejects.toThrow(/is no longer available/);
    expect(captured.insertOrderParams).toBeNull();
  });

  test('a real product is charged at the server price, whatever price the client sends', async () => {
    const captured = makeClient({ inventory: { [P1]: realProduct } });
    await Order.create({ ...baseArgs, subtotal: 1, items: [{ productId: P1, name: 'Tee', price: 1, size: 'M', quantity: 2 }] });
    expect(Number(captured.insertOrderParams[SUBTOTAL_PARAM_INDEX])).toBe(100);
  });

  test("the locked product lookup also requires the product's store to be active and approved", async () => {
    const captured = makeClient({ inventory: { [P1]: realProduct } });
    await Order.create({ ...baseArgs, items: [{ productId: P1, name: 'Tee', size: 'M', quantity: 1 }] });
    const { text } = captured.inventoryLookups[0];
    expect(text).toMatch(/is_active\s*=\s*true/);
    expect(text).toMatch(/FROM stores s/);
    expect(text).toMatch(/s\.is_active\s*=\s*true/);
    expect(text).toMatch(/s\.status\s*=\s*'approved'/);
  });

  test('the old client-price path is gone from Order.js', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/models/Order.js'), 'utf8');
    expect(src).not.toMatch(/validateExternalItemPrice/);
  });
});

describe('C3: the API answers a refused item with 400, not 500', () => {
  test('createOrder maps "is no longer available" to a 400 with the message', async () => {
    const OrderController = require('../../src/controllers/orderController');
    const spy = jest.spyOn(Order, 'create').mockRejectedValue(new Error('"Tee" is no longer available. Please remove it from your cart.'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await OrderController.createOrder({
      userId: 'user-1',
      body: { items: [{ productId: P1, quantity: 1 }], dropoff_lat: -33.95, dropoff_lng: 25.61 },
    }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: '"Tee" is no longer available. Please remove it from your cart.' });
    spy.mockRestore();
  });
});
