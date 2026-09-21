'use strict';
/**
 * tests/unit/inventoryGetProduct.test.js
 *
 * Coverage-remediation Phase 2 — "view a single product" (GET
 * /api/inventory/:productId), the product-detail-page read path. Zero test
 * coverage existed for either Inventory.getProduct (the model query) or
 * InventoryController.getProduct (the route handler) before this file.
 *
 * Real-world scenarios this file protects:
 *   - a customer taps a product from the browse grid and the app fetches
 *     its real detail -> the right public columns come back, no
 *     cost_price or other internal field leaked
 *   - a product id that doesn't exist (bad deep link, stale cache, typo)
 *     -> a clean 404, not a crash
 *   - an inactive/removed product -> treated the same as not found (the
 *     query's own `is_active=true` filter), not shown as if still on sale
 *   - the database itself fails -> a clean 500, not a leaked internal error
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const Inventory = require('../../src/models/Inventory');
const InventoryController = require('../../src/controllers/inventoryController');

beforeEach(() => jest.clearAllMocks());

describe('Inventory.getProduct (model)', () => {
  test('selects only public columns, filtered by id and is_active=true', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'p1', product_name: 'Test Shirt' }] });

    await Inventory.getProduct('p1');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id=\$1 AND is_active=true/);
    expect(sql).not.toMatch(/cost_price/);
    expect(params).toEqual(['p1']);
  });

  test('returns the single row when found', async () => {
    const row = { id: 'p1', product_name: 'Test Shirt' };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await Inventory.getProduct('p1');
    expect(result).toBe(row);
  });

  test('returns undefined when no matching (or inactive) product exists', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Inventory.getProduct('missing-id');
    expect(result).toBeUndefined();
  });
});

describe('InventoryController.getProduct (route handler)', () => {
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  test('returns the product with 200 when found', async () => {
    const product = { id: 'p1', product_name: 'Test Shirt' };
    jest.spyOn(Inventory, 'getProduct').mockResolvedValue(product);

    const req = { params: { productId: 'p1' } };
    const res = mockRes();
    await InventoryController.getProduct(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product }));
  });

  test('returns 404 when the product does not exist', async () => {
    jest.spyOn(Inventory, 'getProduct').mockResolvedValue(undefined);

    const req = { params: { productId: 'missing-id' } };
    const res = mockRes();
    await InventoryController.getProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Product not found' });
  });

  test('returns 500 when the model throws, without leaking the internal error', async () => {
    jest.spyOn(Inventory, 'getProduct').mockRejectedValue(new Error('connection terminated'));

    const req = { params: { productId: 'p1' } };
    const res = mockRes();
    await InventoryController.getProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('Failed to fetch product');
    expect(body.error).not.toMatch(/connection terminated/);
  });
});
