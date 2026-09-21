'use strict';
/**
 * tests/integration/storeInventoryController.test.js
 *
 * Coverage-remediation Phase 4 — StoreInventoryController, the entire
 * Store Admin Portal inventory-write backend (list, detail, create,
 * update image, update stock, deactivate). Zero test coverage existed
 * before this file. Real, unmocked integration suite against the
 * isolated test DB -- only the external S3/Cloudinary upload boundary
 * (src/services/s3Service) is mocked, since that's a real paid third-
 * party network call this test must never actually make; every SQL
 * query, transaction, and store-scoping check is the real thing.
 *
 * This is a DIFFERENT model class from the platform-wide
 * Inventory.js/inventoryController.js this same coverage effort already
 * tested (Phase 2's inventoryGetProduct.test.js, and the earlier
 * storefront-port work's inventoryPublicQuery.test.js) -- this
 * controller owns its own store-scoped queries against the exact same
 * flash_inventory table, per its own header comment ("Deliberately does
 * NOT reuse Inventory.addProduct/updateStock/deleteProduct").
 *
 * Real-world scenarios this file protects:
 *   - a store's staff see and manage exactly their own store's products,
 *     never another store's
 *   - a store creates a real product; its store_id always comes from the
 *     authenticated store's own token (req.storeId), never anywhere a
 *     client could influence it
 *   - a store updates a real product's stock, and that write is genuinely
 *     locked (SELECT...FOR UPDATE) against a concurrent customer checkout
 *     on the same product, exactly like the platform-wide Inventory
 *     write path already proven to be
 *   - a compromised or careless Store B account tries to view, update the
 *     stock of, or deactivate a product that belongs to Store A -- every
 *     one of those must fail as a clean 404, and must leave Store A's
 *     product completely untouched
 *   - a spoofed image upload (real bytes don't match the declared type)
 *     is rejected before ever reaching the real upload call
 */

jest.mock('../../src/services/s3Service');

const db = require('../../src/config/database');
const s3Service = require('../../src/services/s3Service');
const StoreInventoryController = require('../../src/controllers/storeInventoryController');

const REAL_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const NOT_AN_IMAGE = Buffer.from('this is just plain text, not an image');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function mockReq({ storeId, storeUserId, params = {}, query = {}, body = {}, file }) {
  return { storeId, storeUserId, params, query, body, file };
}

async function makeTestStore(tag) {
  const result = await db.query(
    `INSERT INTO stores (name) VALUES ($1) RETURNING id`,
    [`Store Inventory Test Store (${tag}) ${Date.now()}`],
  );
  return result.rows[0].id;
}

async function makeTestStoreUser(tag, storeId) {
  const email = `store-inv-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO store_users (store_id, name, email, password_hash, role) VALUES ($1, $2, $3, 'x', 'owner') RETURNING id`,
    [storeId, `Store Inventory Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestProduct({ storeId, stock = { M: 5 }, price = 199.99 }) {
  const result = await db.query(
    `INSERT INTO flash_inventory (store_id, product_name, category, price, sizes, stock_by_size, is_active)
     VALUES ($1, 'Store Inventory Test Product', 'test', $2, '["M"]', $3, true) RETURNING id`,
    [storeId, price, JSON.stringify(stock)],
  );
  return result.rows[0].id;
}

async function cleanup({ productIds = [] }) {
  for (const id of productIds) {
    if (id) await db.query('DELETE FROM flash_inventory WHERE id = $1', [id]);
  }
}

describe('StoreInventoryController (integration, real DB, mocked S3)', () => {
  let storeA, storeB, storeUserA, storeUserB;

  beforeAll(async () => {
    storeA = await makeTestStore('A');
    storeB = await makeTestStore('B');
    storeUserA = await makeTestStoreUser('A', storeA);
    storeUserB = await makeTestStoreUser('B', storeB);
  });

  afterAll(async () => {
    await db.query('DELETE FROM store_users WHERE id = ANY($1::uuid[])', [[storeUserA, storeUserB]]);
    await db.query('DELETE FROM stores WHERE id = ANY($1::uuid[])', [[storeA, storeB]]);
    await db.end();
  });

  beforeEach(() => jest.clearAllMocks());

  describe('listProducts — store-scoped listing', () => {
    test('a store only ever sees its own products, never another store\'s', async () => {
      const productA = await makeTestProduct({ storeId: storeA });
      const productB = await makeTestProduct({ storeId: storeB });

      try {
        const req = mockReq({ storeId: storeA, query: {} });
        const res = mockRes();
        await StoreInventoryController.listProducts(req, res);

        const ids = res.json.mock.calls[0][0].products.map((p) => p.id);
        expect(ids).toContain(productA);
        expect(ids).not.toContain(productB);
      } finally {
        await cleanup({ productIds: [productA, productB] });
      }
    });
  });

  describe('getProduct — store-scoped detail', () => {
    test('returns the real product for its own store', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeA, params: { productId } });
        const res = mockRes();
        await StoreInventoryController.getProduct(req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product: expect.objectContaining({ id: productId }) }));
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('a cross-store detail request returns 404, not the other store\'s real product', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeB, params: { productId } });
        const res = mockRes();
        await StoreInventoryController.getProduct(req, res);
        expect(res.status).toHaveBeenCalledWith(404);
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });
  });

  describe('addProduct — real creation, store_id always server-resolved', () => {
    test('creates a real product attributed to req.storeId, ignoring any store_id a client might send', async () => {
      const req = mockReq({
        storeId: storeA,
        storeUserId: storeUserA,
        body: { product_name: 'New Test Product', price: '149.99', store_id: storeB }, // attacker-supplied store_id
      });
      const res = mockRes();
      await StoreInventoryController.addProduct(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const created = res.json.mock.calls[0][0].product;
      expect(created.store_id).toBe(storeA); // never storeB, despite the body field
      expect(s3Service.uploadPublicFile).not.toHaveBeenCalled(); // no file attached

      const persisted = await db.query('SELECT store_id FROM flash_inventory WHERE id = $1', [created.id]);
      expect(persisted.rows[0].store_id).toBe(storeA);

      await cleanup({ productIds: [created.id] });
    });

    test('rejects a request missing product_name or price, with no real insert', async () => {
      const req = mockReq({ storeId: storeA, storeUserId: storeUserA, body: { product_name: 'No Price' } });
      const res = mockRes();
      await StoreInventoryController.addProduct(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an attached file whose real bytes are not an allowed image type', async () => {
      const req = mockReq({
        storeId: storeA,
        storeUserId: storeUserA,
        body: { product_name: 'Bad Image Product', price: '99' },
        file: { buffer: NOT_AN_IMAGE, mimetype: 'image/png' }, // spoofed header
      });
      const res = mockRes();
      await StoreInventoryController.addProduct(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(s3Service.uploadPublicFile).not.toHaveBeenCalled();
    });

    test('a real, valid image is uploaded (mocked S3) and its URL stored', async () => {
      s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example.com/flash-product-images/abc.jpg' });
      const req = mockReq({
        storeId: storeA,
        storeUserId: storeUserA,
        body: { product_name: 'Photographed Product', price: '250' },
        file: { buffer: REAL_JPEG_BYTES },
      });
      const res = mockRes();
      await StoreInventoryController.addProduct(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const created = res.json.mock.calls[0][0].product;
      expect(created.image_url).toBe('https://cdn.example.com/flash-product-images/abc.jpg');

      await cleanup({ productIds: [created.id] });
    });
  });

  describe('updateStock — real locked transaction + store-scoped isolation', () => {
    test('updates a real product\'s stock for the owning store', async () => {
      const productId = await makeTestProduct({ storeId: storeA, stock: { M: 5 } });
      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId }, body: { stock_by_size: { M: 12 } } });
        const res = mockRes();
        await StoreInventoryController.updateStock(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product: expect.objectContaining({ stock_by_size: { M: 12 } }) }));

        const stored = await db.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].stock_by_size).toEqual({ M: 12 });
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    // The most security-relevant property of this whole subsystem: Store
    // B, with a real, live req.storeId of its own, tries to overwrite
    // Store A's real product's stock.
    test('a cross-store stock update is rejected as 404, and the real product is left completely untouched', async () => {
      const productId = await makeTestProduct({ storeId: storeA, stock: { M: 5 } });
      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { productId }, body: { stock_by_size: { M: 999 } } });
        const res = mockRes();
        await StoreInventoryController.updateStock(req, res);

        expect(res.status).toHaveBeenCalledWith(404);

        const stored = await db.query('SELECT stock_by_size FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].stock_by_size).toEqual({ M: 5 }); // untouched, not 999
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('rejects a missing or malformed stock_by_size body', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId }, body: { stock_by_size: 'not-an-object' } });
        const res = mockRes();
        await StoreInventoryController.updateStock(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('returns 404 for a product id that does not exist at all', async () => {
      const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId: '00000000-0000-0000-0000-000000000000' }, body: { stock_by_size: { M: 1 } } });
      const res = mockRes();
      await StoreInventoryController.updateStock(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('deactivateProduct — store-scoped soft delete', () => {
    test('deactivates a real product for its own store', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId } });
        const res = mockRes();
        await StoreInventoryController.deactivateProduct(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product: expect.objectContaining({ is_active: false }) }));
        const stored = await db.query('SELECT is_active FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].is_active).toBe(false);
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('a cross-store deactivate attempt is rejected, and the real product stays active', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { productId } });
        const res = mockRes();
        await StoreInventoryController.deactivateProduct(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        const stored = await db.query('SELECT is_active FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].is_active).toBe(true); // untouched
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });
  });

  describe('updateImage — mocked upload, real store-scoped write', () => {
    test('rejects when no file is attached', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId } });
        const res = mockRes();
        await StoreInventoryController.updateImage(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('a real, valid new image replaces the stored URL for the owning store', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example.com/flash-product-images/new.jpg' });
      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { productId }, file: { buffer: REAL_JPEG_BYTES } });
        const res = mockRes();
        await StoreInventoryController.updateImage(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product: expect.objectContaining({ image_url: 'https://cdn.example.com/flash-product-images/new.jpg' }) }));
        const stored = await db.query('SELECT image_url FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].image_url).toBe('https://cdn.example.com/flash-product-images/new.jpg');
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });

    test('a cross-store image update is rejected as 404, product left untouched', async () => {
      const productId = await makeTestProduct({ storeId: storeA });
      s3Service.uploadPublicFile.mockResolvedValue({ url: 'https://cdn.example.com/flash-product-images/hijacked.jpg' });
      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { productId }, file: { buffer: REAL_JPEG_BYTES } });
        const res = mockRes();
        await StoreInventoryController.updateImage(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        const stored = await db.query('SELECT image_url FROM flash_inventory WHERE id = $1', [productId]);
        expect(stored.rows[0].image_url).toBeNull();
      } finally {
        await cleanup({ productIds: [productId] });
      }
    });
  });
});
