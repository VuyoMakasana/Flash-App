'use strict';
/**
 * tests/unit/inventoryController.test.js
 *
 * The legacy admin REST inventory route (`POST /api/inventory`,
 * `requireRole('admin')`). **Scoped deliberately to addProduct's price gate**
 * — OPEN_FOLLOWUPS #21 — not to the whole controller. Further coverage of
 * this controller belongs in this file when it is written.
 *
 * Why it needed a gate of its own: the pre-existing check was
 * `if (!product_name || !price)`, which rejects 0 because it is falsy but
 * **accepts -5**, and this route writes the same `flash_inventory.price` that
 * feeds `store_commission`.
 *
 * The property worth protecting is not just "a negative is refused" — it is
 * refused with a **400**. Migration v40's `CHECK (price > 0)` would catch it
 * regardless, but only by raising inside the query, which this controller's
 * generic catch turns into a 500: a client error reported as a server fault,
 * with no indication of which field was wrong.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/models/Inventory', () => ({ addProduct: jest.fn() }));
jest.mock('../../src/models/AdminAction', () => ({ log: jest.fn() }));
jest.mock('../../src/middleware/cache', () => ({
  clearCache: jest.fn(),
  cache: () => (req, res, next) => next(),
}));

const Inventory = require('../../src/models/Inventory');
const AdminAction = require('../../src/models/AdminAction');
const { clearCache } = require('../../src/middleware/cache');
const InventoryController = require('../../src/controllers/inventoryController');

const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const mockReq = (o = {}) => ({ userId: 'admin-1', params: {}, body: {}, query: {}, ...o });

beforeEach(() => jest.clearAllMocks());

describe('addProduct — price validation (#21)', () => {
  test.each([
    ['negative', -5],
    ['non-numeric', 'free'],
    ['above the cap', 100001],
  ])('a %s price is a 400, not a 500, and never reaches the model', async (_label, price) => {
    const res = mockRes();
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(Inventory.addProduct).not.toHaveBeenCalled();
    expect(clearCache).not.toHaveBeenCalled();
    expect(AdminAction.log).not.toHaveBeenCalled();
  });

  // The pre-existing `!price` guard already rejected 0 as falsy. Pinned so the
  // shared validator's `> 0` rule is not mistaken for a behaviour change here.
  test('zero is still refused', async () => {
    const res = mockRes();
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 0 } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Inventory.addProduct).not.toHaveBeenCalled();
  });

  test('a negative cost_price is a 400', async () => {
    const res = mockRes();
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 450, cost_price: -1 } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Inventory.addProduct).not.toHaveBeenCalled();
  });

  test('passes the parsed, cent-rounded values to the model', async () => {
    Inventory.addProduct.mockResolvedValue({ id: PRODUCT_ID });
    const res = mockRes();

    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: '450.005', cost_price: '120.004' } }), res,
    );

    expect(Inventory.addProduct).toHaveBeenCalledWith(
      expect.objectContaining({ price: 450.01, cost_price: 120 }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // Same 0-is-not-NULL guarantee as the store portal path, so the two agree.
  test('a cost_price of 0 reaches the model as 0, not null', async () => {
    Inventory.addProduct.mockResolvedValue({ id: PRODUCT_ID });
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 450, cost_price: 0 } }), mockRes(),
    );

    expect(Inventory.addProduct).toHaveBeenCalledWith(
      expect.objectContaining({ cost_price: 0 }),
    );
  });

  test('an omitted cost_price reaches the model as null', async () => {
    Inventory.addProduct.mockResolvedValue({ id: PRODUCT_ID });
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 450 } }), mockRes(),
    );

    expect(Inventory.addProduct).toHaveBeenCalledWith(
      expect.objectContaining({ cost_price: null }),
    );
  });

  test('a valid product still invalidates the catalog cache and is audit-logged', async () => {
    Inventory.addProduct.mockResolvedValue({ id: PRODUCT_ID });
    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 450 } }), mockRes(),
    );

    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
    expect(AdminAction.log).toHaveBeenCalledWith(
      'admin-1', 'inventory_add_product', 'flash_inventory', PRODUCT_ID,
      { product_name: 'Jacket' },
    );
  });

  test('a genuine model failure is still a 500', async () => {
    Inventory.addProduct.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();

    await InventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: 450 } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
