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

// ─────────────────────────────────────────────────────────────────────────────
// A1 — updateProduct. Correcting a product after creation.
//
// Price is the reason this exists: commission is a percentage OF price, so a
// value reaching the column unvalidated is a money bug, not a cosmetic one.
// The whitelist is the other half — the SET list is built from a fixed field
// map, never from the request body, so extra keys cannot reach store_id or
// is_active.
// ─────────────────────────────────────────────────────────────────────────────

describe('updateProduct — tenant isolation', () => {
  test('another store product is 404 and nothing is written', async () => {
    mockClient({ lockedRead: { rows: [] } });
    const res = mockRes();

    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(StoreAction.log).not.toHaveBeenCalled();
    expect(clearCache).not.toHaveBeenCalled();
  });

  test('the locked read and the write are both scoped by store_id', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), mockRes(),
    );

    const locked = client.query.mock.calls.find(([s]) => String(s).includes('FOR UPDATE'));
    expect(locked[0]).toMatch(/WHERE id = \$1 AND store_id = \$2/);
    expect(locked[1]).toEqual([PRODUCT_ID, MY_STORE]);

    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[0]).toMatch(/AND store_id = \$\d+/);
    expect(update[1]).toContain(MY_STORE);
  });

  test('takes a FOR UPDATE lock, like updateStock', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), mockRes(),
    );
    expect(client.query.mock.calls.some(([s]) => String(s).includes('FOR UPDATE'))).toBe(true);
  });
});

describe('updateProduct — the field whitelist', () => {
  test('store_id, is_active and id in the body are ignored, not written', async () => {
    // The attack this blocks: moving a product into another store, or
    // reactivating it, through a field the edit form never shows.
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });

    await StoreInventoryController.updateProduct(mockReq({
      params: { productId: PRODUCT_ID },
      body: { price: 50, store_id: OTHER_STORE, is_active: true, id: 'other-id' },
    }), mockRes());

    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[0]).not.toMatch(/is_active =/);
    expect(update[1]).not.toContain('other-id');
    // OTHER_STORE must never appear as a value: the only store_id bound is the
    // token's own, in the WHERE clause.
    expect(update[1].filter((v) => v === OTHER_STORE)).toHaveLength(0);
  });

  test('only the fields actually supplied are written', async () => {
    // A partial PATCH must not blank a column the caller never mentioned.
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });

    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), mockRes(),
    );

    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[0]).toMatch(/price = \$1/);
    expect(update[0]).not.toMatch(/product_name|description|brand|category|cost_price/);
  });

  test('an empty body is rejected rather than issuing a no-op UPDATE', async () => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: {} }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('a body containing ONLY non-editable fields is rejected', async () => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { store_id: OTHER_STORE, is_active: true } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('updateProduct — price validation, because price drives commission', () => {
  test.each([
    ['zero', 0], ['negative', -10], ['not a number', 'free'],
    ['NaN', NaN], ['above the sanity cap', 100001], ['null', null],
  ])('rejects a %s price without writing', async (_label, price) => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('rounds to whole cents rather than letting the column truncate', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 12.345 } }), mockRes(),
    );
    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[1]).toContain(12.35);
  });

  test('accepts a numeric string, since form inputs submit strings', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: '149.99' } }), res,
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[1]).toContain(149.99);
  });

  // The portal's api.js normalizes { errors: [{ path, msg }] } into per-field
  // messages for the form to render. That is express-validator's shape, and
  // this handler validates by hand — so nothing but this test stops the two
  // drifting apart, at which point the portal would show a blank error.
  test('validation errors use express-validator\'s { path, msg } wire shape', async () => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: -1 } }), res,
    );

    expect(res.json).toHaveBeenCalledWith({
      errors: [expect.objectContaining({ path: 'price', msg: expect.any(String) })],
    });
  });

  test('every invalid field is reported at once, not just the first', async () => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: -1, product_name: 'x' } }), res,
    );

    const { errors } = res.json.mock.calls[0][0];
    expect(errors.map((e) => e.path).sort()).toEqual(['price', 'product_name']);
  });

  test('a too-short product_name is rejected', async () => {
    const res = mockRes();
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { product_name: 'x' } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('optional text fields can be cleared with an empty string', async () => {
    const client = mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { description: '' } }), mockRes(),
    );
    const update = client.query.mock.calls.find(([s]) => String(s).includes('UPDATE flash_inventory'));
    expect(update[1]).toContain(null);
  });
});

describe('updateProduct — cache and audit', () => {
  test('invalidates the customer catalog cache', async () => {
    // Without this a price change stays invisible to real customers for up to
    // 60 seconds — and they could still check out at the old price.
    mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), mockRes(),
    );
    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
  });

  test('records the PREVIOUS price in the audit metadata', async () => {
    // "Why does this order's commission not match the current price" is only
    // answerable if the prior price is recoverable.
    mockClient({ lockedRead: { rows: [{ id: PRODUCT_ID, price: '99.00' }] } });
    await StoreInventoryController.updateProduct(
      mockReq({ params: { productId: PRODUCT_ID }, body: { price: 50 } }), mockRes(),
    );
    expect(StoreAction.log).toHaveBeenCalledWith(
      'u1', MY_STORE, 'product_update', 'flash_inventory', PRODUCT_ID,
      expect.objectContaining({ previous_price: '99.00', fields: ['price'] }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — reactivateProduct
// ─────────────────────────────────────────────────────────────────────────────

describe('reactivateProduct', () => {
  test('sets is_active true, scoped by store', async () => {
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID, is_active: true }] });
    await StoreInventoryController.reactivateProduct(
      mockReq({ params: { productId: PRODUCT_ID } }), mockRes(),
    );
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET is_active = true/);
    expect(sql).toMatch(/WHERE id = \$1 AND store_id = \$2/);
    expect(params).toEqual([PRODUCT_ID, MY_STORE]);
  });

  test('another store product is 404, nothing reactivated', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreInventoryController.reactivateProduct(
      mockReq({ params: { productId: PRODUCT_ID } }), res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(StoreAction.log).not.toHaveBeenCalled();
  });

  test('clears the catalog cache, so the product actually reappears', async () => {
    // A reactivated product that stays cached out looks like a broken button.
    db.query.mockResolvedValue({ rows: [{ id: PRODUCT_ID, is_active: true }] });
    await StoreInventoryController.reactivateProduct(
      mockReq({ params: { productId: PRODUCT_ID } }), mockRes(),
    );
    expect(clearCache).toHaveBeenCalledWith('cache:*/inventory*');
    expect(StoreAction.log).toHaveBeenCalledWith(
      'u1', MY_STORE, 'product_reactivate', 'flash_inventory', PRODUCT_ID,
    );
  });
});
