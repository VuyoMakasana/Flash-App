'use strict';
/**
 * tests/unit/storeInventoryController.test.js
 *
 * The Store Admin Portal's Inventory backend. Four properties matter here, and
 * all four sit upstream of money:
 *
 *   1. Cross-tenant writes are impossible. Every write is scoped by store_id in
 *      the SQL itself, so targeting another store's product changes zero rows
 *      and reports 404 -- not 403, which would confirm the product exists.
 *   2. Stock updates take a FOR UPDATE row lock inside a transaction. Stock is
 *      decremented concurrently by Order.create at checkout; an unlocked
 *      read-modify-write here would lose updates under concurrency.
 *   3. Uploaded images are validated by real magic bytes, not the client's
 *      declared mimetype.
 *   4. The public customer catalog cache is invalidated on every mutation --
 *      otherwise a store's price or stock change stays invisible to real
 *      customers for up to 60 seconds.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/s3Service', () => ({ uploadPublicFile: jest.fn() }));
jest.mock('../../src/models/StoreAction', () => ({ log: jest.fn() }));
jest.mock('../../src/middleware/cache', () => ({ clearCache: jest.fn(), cache: () => (req, res, next) => next() }));
jest.mock('../../src/utils/fileSignature', () => ({ detectRealMimeType: jest.fn() }));

const db = require('../../src/config/database');
const s3Service = require('../../src/services/s3Service');
const StoreAction = require('../../src/models/StoreAction');
const { clearCache } = require('../../src/middleware/cache');
const { detectRealMimeType } = require('../../src/utils/fileSignature');
const StoreInventoryController = require('../../src/controllers/storeInventoryController');

const MY_STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const mockReq = (o = {}) => ({ storeId: MY_STORE, storeUserId: 'u1', query: {}, params: {}, body: {}, ...o });

// A stand-in pg client for the transactional updateStock path.
function mockClient(responses) {
  const client = {
    query: jest.fn(async (sql) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))) return { rows: [] };
      if (String(sql).includes('FOR UPDATE')) return responses.lockedRead;
      if (String(sql).includes('UPDATE flash_inventory')) return responses.update || { rows: [{ id: PRODUCT_ID }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => jest.clearAllMocks());

describe('listProducts / getProduct', () => {
  test('list is scoped to the token\'s store', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await StoreInventoryController.listProducts(mockReq({ query: { storeId: OTHER_STORE } }), mockRes());

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE store_id = \$1/);
    expect(params[0]).toBe(MY_STORE);
  });

  test('getProduct hides another store\'s product behind a 404', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID, store_id: OTHER_STORE, price: '99.00' }] });
    const res = mockRes();
    await StoreInventoryController.getProduct(mockReq({ params: { productId: PRODUCT_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].product).toBeUndefined();
  });

  test('getProduct returns our own product', async () => {
    const product = { id: PRODUCT_ID, store_id: MY_STORE };
    db.query.mockResolvedValue({ rows: [product] });
    const res = mockRes();
    await StoreInventoryController.getProduct(mockReq({ params: { productId: PRODUCT_ID } }), res);

    expect(res.json).toHaveBeenCalledWith({ product });
  });
});

describe('addProduct', () => {
  test('rejects a product with no name or price before touching the database', async () => {
    const res = mockRes();
    await StoreInventoryController.addProduct(mockReq({ body: { product_name: 'x' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('always attributes the new product to the token\'s store', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });
    await StoreInventoryController.addProduct(
      mockReq({ body: { product_name: 'Jacket', price: '450.00', storeId: OTHER_STORE } }),
      mockRes(),
    );

    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(MY_STORE);
    expect(params).not.toContain(OTHER_STORE);
  });

  // A .png extension and an image/png mimetype prove nothing; the bytes do.
  test('rejects a file whose real content is not a permitted image', async () => {
    detectRealMimeType.mockReturnValue('application/x-msdownload');
    const res = mockRes();
    await StoreInventoryController.addProduct(
      mockReq({ body: { product_name: 'x', price: '1' }, file: { buffer: Buffer.from('MZ') } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(s3Service.uploadPublicFile).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('uploads and stores the URL when the bytes really are an image', async () => {
    detectRealMimeType.mockReturnValue('image/png');
    s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example/p.png' });
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });

    await StoreInventoryController.addProduct(
      mockReq({ body: { product_name: 'x', price: '1' }, file: { buffer: Buffer.from('\x89PNG') } }),
      mockRes(),
    );

    expect(db.query.mock.calls[0][1][8]).toBe('https://cdn.example/p.png');
  });

  test('invalidates the public catalog cache and audit-logs the creation', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });
    await StoreInventoryController.addProduct(
      mockReq({ body: { product_name: 'x', price: '1' } }), mockRes(),
    );

    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
    expect(StoreAction.log).toHaveBeenCalledWith(
      'u1', MY_STORE, 'product_create', 'flash_inventory', PRODUCT_ID,
    );
  });

  test('malformed JSON in sizes falls back to a default instead of throwing', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });
    const res = mockRes();
    await StoreInventoryController.addProduct(
      mockReq({ body: { product_name: 'x', price: '1', sizes: '{not json' } }), res,
    );

    expect(db.query.mock.calls[0][1][6]).toBe(JSON.stringify([]));
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});

describe('updateStock — concurrency-sensitive', () => {
  test('takes a FOR UPDATE lock inside a transaction, scoped to this store', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID }] } });

    await StoreInventoryController.updateStock(
      mockReq({ params: { productId: PRODUCT_ID }, body: { stock_by_size: { M: 4 } } }), mockRes(),
    );

    const issued = client.query.mock.calls.map(([sql]) => String(sql));
    expect(issued[0]).toMatch(/BEGIN/);
    const locked = issued.find((s) => s.includes('FOR UPDATE'));
    expect(locked).toMatch(/WHERE id = \$1 AND store_id = \$2/);
    expect(issued.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('another store\'s product is 404 and is never updated', async () => {
    const client = mockClient({ lockedRead: { rows: [] } }); // scoped lock matched nothing
    const res = mockRes();

    await StoreInventoryController.updateStock(
      mockReq({ params: { productId: PRODUCT_ID }, body: { stock_by_size: { M: 4 } } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    const issued = client.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((s) => s.includes('UPDATE flash_inventory'))).toBe(false);
    expect(issued.some((s) => s.includes('ROLLBACK'))).toBe(true);
  });

  test('rejects a missing or non-object stock payload before opening a transaction', async () => {
    const res = mockRes();
    await StoreInventoryController.updateStock(
      mockReq({ params: { productId: PRODUCT_ID }, body: { stock_by_size: 'lots' } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('a mid-transaction failure rolls back and releases the client', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/BEGIN|ROLLBACK/i.test(String(sql))) return { rows: [] };
        throw new Error('deadlock detected');
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(client);
    const res = mockRes();

    await StoreInventoryController.updateStock(
      mockReq({ params: { productId: PRODUCT_ID }, body: { stock_by_size: { M: 1 } } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(client.query.mock.calls.some(([s]) => String(s).includes('ROLLBACK'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('updateImage', () => {
  test('requires a file', async () => {
    const res = mockRes();
    await StoreInventoryController.updateImage(mockReq({ params: { productId: PRODUCT_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(s3Service.uploadPublicFile).not.toHaveBeenCalled();
  });

  test('rejects a file whose real bytes are not an allowed image, before uploading', async () => {
    detectRealMimeType.mockReturnValue('text/html');
    const res = mockRes();

    await StoreInventoryController.updateImage(
      mockReq({ params: { productId: PRODUCT_ID }, file: { buffer: Buffer.from('<html>') } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(s3Service.uploadPublicFile).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('scopes the update to this store and refreshes the public catalog', async () => {
    detectRealMimeType.mockReturnValue('image/jpeg');
    s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example/new.jpg' });
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });

    await StoreInventoryController.updateImage(
      mockReq({ params: { productId: PRODUCT_ID }, file: { buffer: Buffer.from('\xFF\xD8\xFF') } }), mockRes(),
    );

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$2 AND store_id = \$3/);
    expect(params).toEqual(['https://cdn.example/new.jpg', PRODUCT_ID, MY_STORE]);
    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
    expect(StoreAction.log).toHaveBeenCalledWith(
      'u1', MY_STORE, 'product_update_image', 'flash_inventory', PRODUCT_ID,
    );
  });

  test('another store\'s product is 404 and is not audit-logged', async () => {
    detectRealMimeType.mockReturnValue('image/png');
    s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example/x.png' });
    db.query.mockResolvedValue({ rows: [] }); // scoped UPDATE matched nothing
    const res = mockRes();

    await StoreInventoryController.updateImage(
      mockReq({ params: { productId: PRODUCT_ID }, file: { buffer: Buffer.from('\x89PNG') } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(StoreAction.log).not.toHaveBeenCalled();
  });

  test('an upload failure is a 500 and leaves the product row untouched', async () => {
    detectRealMimeType.mockReturnValue('image/png');
    s3Service.uploadPublicFile.mockRejectedValue(new Error('storage unavailable'));
    const res = mockRes();

    await StoreInventoryController.updateImage(
      mockReq({ params: { productId: PRODUCT_ID }, file: { buffer: Buffer.from('\x89PNG') } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('deactivateProduct', () => {
  test('is a soft delete scoped to this store, never a DELETE', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID }] });
    await StoreInventoryController.deactivateProduct(
      mockReq({ params: { productId: PRODUCT_ID } }), mockRes(),
    );

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET is_active = false/);
    expect(sql).not.toMatch(/DELETE/);
    expect(sql).toMatch(/WHERE id = \$1 AND store_id = \$2/);
    expect(params).toEqual([PRODUCT_ID, MY_STORE]);
    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
  });

  test('another store\'s product is 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreInventoryController.deactivateProduct(
      mockReq({ params: { productId: PRODUCT_ID } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(StoreAction.log).not.toHaveBeenCalled();
  });
});
