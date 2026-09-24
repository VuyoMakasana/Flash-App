'use strict';
/**
 * tests/unit/storefrontController.test.js
 *
 * Storefront port, Piece 2 — StorefrontController.listStores/getStore, the
 * new public, unauthenticated store-directory/detail endpoints mounted at
 * /api/stores (ported from multi-tenant-stage7-customer-storefront).
 * Mirrors inventoryController.js's own error-handling shape: 500 on a
 * thrown model error, 404 when the model returns no match.
 */

jest.mock('../../src/models/Store');

const Store = require('../../src/models/Store');
const StorefrontController = require('../../src/controllers/storefrontController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('StorefrontController.listStores', () => {
  test('returns the stores from Store.listActive with default pagination', async () => {
    const stores = [{ id: 's1', name: 'Flash Closet' }];
    Store.listActive.mockResolvedValue(stores);
    const req = { query: {} };
    const res = mockRes();

    await StorefrontController.listStores(req, res);

    expect(Store.listActive).toHaveBeenCalledWith(1, 20);
    expect(res.json).toHaveBeenCalledWith({ stores });
  });

  test('passes through page/limit query params', async () => {
    Store.listActive.mockResolvedValue([]);
    const req = { query: { page: '2', limit: '5' } };
    const res = mockRes();

    await StorefrontController.listStores(req, res);

    expect(Store.listActive).toHaveBeenCalledWith('2', '5');
  });

  test('returns 500 when the model throws', async () => {
    Store.listActive.mockRejectedValue(new Error('db down'));
    const req = { query: {} };
    const res = mockRes();

    await StorefrontController.listStores(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to fetch stores' });
  });
});

describe('StorefrontController.getStore', () => {
  test('returns the store when found', async () => {
    const store = { id: 's1', name: 'Flash Closet' };
    Store.findPublicById.mockResolvedValue(store);
    const req = { params: { storeId: 's1' } };
    const res = mockRes();

    await StorefrontController.getStore(req, res);

    expect(Store.findPublicById).toHaveBeenCalledWith('s1');
    expect(res.json).toHaveBeenCalledWith({ store });
  });

  test('returns 404 when the store does not exist', async () => {
    Store.findPublicById.mockResolvedValue(null);
    const req = { params: { storeId: 'missing' } };
    const res = mockRes();

    await StorefrontController.getStore(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Store not found' });
  });

  test('returns 500 when the model throws', async () => {
    Store.findPublicById.mockRejectedValue(new Error('db down'));
    const req = { params: { storeId: 's1' } };
    const res = mockRes();

    await StorefrontController.getStore(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to fetch store' });
  });
});
