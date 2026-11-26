/**
 * tests/unit/orderStoreAttribution.test.js
 *
 * Phase 1 — per-order store attribution.
 *
 * Attribution used to be "the first active store" (the controller's
 * resolveDefaultStoreId). That is correct only while exactly one store exists;
 * with two, every order is attributed to whichever store sorts first, and once
 * store payouts exist that misroutes real money. Attribution is now derived
 * inside Order.create from the same FOR UPDATE-locked flash_inventory reads the
 * order is actually built from.
 *
 * These tests call the REAL Order.create against a mocked pg client and assert
 * on the store_id actually bound into the real INSERT -- deliberately not a
 * re-implementation of the logic in the test file, which would pass even if the
 * production code were deleted.
 */
const pool = require('../../src/config/database');
const Order = require('../../src/models/Order');

jest.mock('../../src/config/database');

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
// Product ids are real UUIDs: Order.create refuses anything else (C3, #94).
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

// Builds a fake pg client whose responses depend on the SQL issued, mirroring
// the real query sequence inside Order.create closely enough that the code path
// under test is the production one.
function makeClient({ inventory }) {
  const captured = { insertOrderParams: null };

  const client = {
    query: jest.fn(async (sql, params) => {
      const text = String(sql);

      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };

      // Best active promotion lookup (none, so prices are untouched).
      if (text.includes('FROM store_promotions')) return { rows: [] };

      // The locked per-item inventory read that attribution is derived from.
      if (text.includes('FROM flash_inventory') && text.includes('FOR UPDATE')) {
        const row = inventory[params[0]];
        return { rows: row ? [row] : [] };
      }

      if (text.includes('UPDATE flash_inventory')) return { rows: [] };

      // Premium subscription check -> not premium.
      if (text.includes('premium_subscriptions')) return { rows: [] };

      if (text.includes('INSERT INTO orders')) {
        captured.insertOrderParams = params;
        return { rows: [{ id: 'order-1', order_number: 'FL-TEST', store_id: params[9] }] };
      }

      if (text.includes('INSERT INTO order_items')) return { rows: [] };

      return { rows: [] };
    }),
    release: jest.fn(),
  };

  pool.connect.mockResolvedValue(client);
  return { client, captured };
}

// store_id is the 10th bind param of the real INSERT INTO orders (1-indexed
// $10), immediately after premium_discount_applied.
const STORE_ID_PARAM_INDEX = 9;

const baseArgs = {
  userId: 'user-1',
  delivery_mode: 'fleet',
  subtotal: 100,
  pickup_address: 'a',
  dropoff_address: 'b',
  pickup_lat: -33.96,
  pickup_lng: 25.6,
  dropoff_lat: -33.95,
  dropoff_lng: 25.61,
};

afterEach(() => jest.clearAllMocks());

describe('per-order store attribution', () => {
  test('a basket of one store\'s products is attributed to that store', async () => {
    const { captured } = makeClient({
      inventory: {
        [P1]: { id: P1, price: '50.00', product_name: 'A', stock_by_size: { M: 5 }, store_id: STORE_A },
        [P2]: { id: P2, price: '25.00', product_name: 'B', stock_by_size: { M: 5 }, store_id: STORE_A },
      },
    });

    await Order.create({
      ...baseArgs,
      items: [
        { productId: P1, name: 'A', size: 'M', quantity: 1 },
        { productId: P2, name: 'B', size: 'M', quantity: 1 },
      ],
    });

    expect(captured.insertOrderParams[STORE_ID_PARAM_INDEX]).toBe(STORE_A);
  });

  // The whole point of the change: this case used to be silently attributed to
  // whichever store sorted first, sending one store's money to another.
  test('a basket spanning two stores is REJECTED, never silently misattributed', async () => {
    const { captured } = makeClient({
      inventory: {
        [P1]: { id: P1, price: '50.00', product_name: 'A', stock_by_size: { M: 5 }, store_id: STORE_A },
        [P2]: { id: P2, price: '25.00', product_name: 'B', stock_by_size: { M: 5 }, store_id: STORE_B },
      },
    });

    await expect(
      Order.create({
        ...baseArgs,
        items: [
          { productId: P1, name: 'A', size: 'M', quantity: 1 },
          { productId: P2, name: 'B', size: 'M', quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/more than one store/);

    // No order row may be written for a basket we refused to attribute.
    expect(captured.insertOrderParams).toBeNull();
  });

  // C3 (#94): there are no "external" items any more. A basket with an item
  // that isn't a real product is refused outright, never attributed to no
  // store (or to the other items' store) at a client price.
  test('a basket with no real product is refused, never attributed to no store', async () => {
    const { captured } = makeClient({ inventory: {} });

    await expect(Order.create({
      ...baseArgs,
      items: [{ name: 'External item', price: 80, quantity: 1 }],
    })).rejects.toThrow(/is no longer available/);

    expect(captured.insertOrderParams).toBeNull();
  });

  test("one store's product plus a non-product item is refused, not attributed", async () => {
    const { captured } = makeClient({
      inventory: {
        [P1]: { id: P1, price: '50.00', product_name: 'A', stock_by_size: { M: 5 }, store_id: STORE_A },
      },
    });

    await expect(Order.create({
      ...baseArgs,
      items: [
        { productId: P1, name: 'A', size: 'M', quantity: 1 },
        { name: 'External item', price: 30, quantity: 1 },
      ],
    })).rejects.toThrow(/is no longer available/);

    expect(captured.insertOrderParams).toBeNull();
  });

  // Attribution must come from the server's own locked row, never from the
  // client, and never from a caller-supplied override.
  test('a client-supplied store_id cannot override the derived attribution', async () => {
    const { captured } = makeClient({
      inventory: {
        [P1]: { id: P1, price: '50.00', product_name: 'A', stock_by_size: { M: 5 }, store_id: STORE_A },
      },
    });

    await Order.create({
      ...baseArgs,
      store_id: STORE_B, // attacker / stale caller value
      items: [{ productId: P1, name: 'A', size: 'M', quantity: 1 }],
    });

    expect(captured.insertOrderParams[STORE_ID_PARAM_INDEX]).toBe(STORE_A);
    expect(captured.insertOrderParams[STORE_ID_PARAM_INDEX]).not.toBe(STORE_B);
  });
});
