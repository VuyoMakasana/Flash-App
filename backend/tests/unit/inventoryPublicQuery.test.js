'use strict';
/**
 * tests/unit/inventoryPublicQuery.test.js
 *
 * Storefront port, Piece 4 — the customer-facing public inventory query
 * (Inventory.getProducts) now joins stores and exposes store_id/store_name
 * on every row, plus an optional storeId filter for the storefront's
 * per-store page (StoreScreen.js, filtering FlashContext's already-loaded
 * products array by storeId). Ported from
 * multi-tenant-stage7-customer-storefront's own version of this query.
 * admin-platform's existing updateStock (already real BEGIN/SELECT...FOR
 * UPDATE/COMMIT-locked) is untouched by this port — see Piece 3.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const Inventory = require('../../src/models/Inventory');
const InventoryController = require('../../src/controllers/inventoryController');

beforeEach(() => jest.clearAllMocks());

describe('Inventory.getProducts — store_id/store_name exposure (Piece 4)', () => {
  test('joins stores and selects store_id + store_name', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts(null, 1, 20);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/JOIN stores ON stores\.id = flash_inventory\.store_id/);
    expect(sql).toMatch(/flash_inventory\.store_id/);
    expect(sql).toMatch(/stores\.name AS store_name/);
  });

  test('never selects cost_price', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts(null, 1, 20);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/cost_price/);
  });

  test('with no category/storeId, filters only is_active=true and uses limit/offset params', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts(null, 1, 20);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE flash_inventory\.is_active=true ORDER BY/);
    expect(params).toEqual([20, 0]);
  });

  test('adds a category condition as a positional param when category is given', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts('dresses', 1, 20);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/flash_inventory\.category=\$3/);
    expect(params).toEqual([20, 0, 'dresses']);
  });

  test('adds a store_id condition as a positional param when storeId is given', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts(null, 1, 20, 'store-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/flash_inventory\.store_id=\$3/);
    expect(params).toEqual([20, 0, 'store-1']);
  });

  test('combines category and storeId as independent positional params', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts('dresses', 1, 20, 'store-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/flash_inventory\.category=\$3/);
    expect(sql).toMatch(/flash_inventory\.store_id=\$4/);
    expect(params).toEqual([20, 0, 'dresses', 'store-1']);
  });

  test('a bogus storeId still only adds the store_id condition (no injection via table name etc.)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Inventory.getProducts(null, 1, 20, '00000000-0000-0000-0000-000000000000');
    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('InventoryController.getProducts — storeId query param passthrough (Piece 4)', () => {
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  test('passes storeId from the query string down to Inventory.getProducts', async () => {
    const resolvedProducts = [{ id: 'p1', store_id: 'store-1', store_name: 'Flash Closet' }];
    const spy = jest.spyOn(Inventory, 'getProducts').mockResolvedValue(resolvedProducts);
    const req = { query: { storeId: 'store-1' } };
    const res = mockRes();

    await InventoryController.getProducts(req, res);

    expect(spy).toHaveBeenCalledWith(undefined, 1, 20, 'store-1');
    expect(res.json).toHaveBeenCalledWith({ products: resolvedProducts, storeId: 'flash_closet' });
    spy.mockRestore();
  });

  test('passes null (not undefined) when no storeId query param is given', async () => {
    const spy = jest.spyOn(Inventory, 'getProducts').mockResolvedValue([]);
    const req = { query: {} };
    const res = mockRes();

    await InventoryController.getProducts(req, res);

    expect(spy).toHaveBeenCalledWith(undefined, 1, 20, null);
    spy.mockRestore();
  });
});
