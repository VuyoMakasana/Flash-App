'use strict';
/**
 * tests/integration/storeInventoryImageUpload.test.js
 *
 * Coverage-remediation Phase 4 — proves the real fix for the
 * uploadPublicFile bug found while writing storeInventoryController.test.js
 * (s3Service.uploadPublicFile did not exist at all; every real store
 * product-image upload crashed unconditionally). Deliberately a SEPARATE
 * file from storeInventoryController.test.js, which mocks s3Service at
 * the module level for its many fast, business-logic-focused tests --
 * this file mocks nothing. It makes a real Cloudinary upload through the
 * real controller and then makes a real HTTP request to the URL that
 * comes back, because the actual bug here was never "does the function
 * get called" (a mock would have looked identical before and after the
 * fix) -- it was "does a customer's phone ever actually load this image."
 * Requires real CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET, already present
 * in this isolated test project's .env; skipped with a clear message if
 * they're absent so this suite degrades safely elsewhere rather than
 * failing for an unrelated reason.
 *
 * Real-world scenario this file protects:
 *   - a store uploads a real product photo -> a customer browsing the
 *     storefront on their phone, no login, no token, must be able to
 *     actually load that image over a plain HTTP GET
 */

const db = require('../../src/config/database');
const cloudinary = require('cloudinary').v2;
const StoreInventoryController = require('../../src/controllers/storeInventoryController');

const CLOUDINARY_CONFIGURED = Boolean(process.env.CLOUDINARY_CLOUD_NAME);
const describeIfConfigured = CLOUDINARY_CONFIGURED ? describe : describe.skip;

// A real, minimal, valid 1x1 JPEG -- real magic bytes so detectRealMimeType
// accepts it, and a real enough body for Cloudinary to actually store it.
const REAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI' +
  'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQ' +
  'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB' +
  'AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX' +
  '/9k=',
  'base64',
);

async function makeTestStore(tag) {
  const result = await db.query(
    `INSERT INTO stores (name) VALUES ($1) RETURNING id`,
    [`Store Image Upload Test Store (${tag}) ${Date.now()}`],
  );
  return result.rows[0].id;
}

async function makeTestStoreUser(tag, storeId) {
  const email = `store-img-upload-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO store_users (store_id, name, email, password_hash, role) VALUES ($1, $2, $3, 'x', 'owner') RETURNING id`,
    [storeId, `Store Image Upload Test User (${tag})`, email],
  );
  return result.rows[0].id;
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

// Cleans up the real Cloudinary asset, not just the DB row -- otherwise
// every run of this suite leaves a real, billed asset behind forever.
async function destroyPublicAsset(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { type: 'upload', resource_type: 'image' });
  } catch (err) {
    console.warn('[test cleanup] failed to destroy Cloudinary asset', publicId, err.message);
  }
}

describeIfConfigured('StoreInventoryController product image upload (real Cloudinary, real HTTP fetch)', () => {
  let storeId, storeUserId;

  beforeAll(async () => {
    storeId = await makeTestStore('upload');
    storeUserId = await makeTestStoreUser('upload', storeId);
  });

  afterAll(async () => {
    await db.query('DELETE FROM store_users WHERE id = $1', [storeUserId]);
    await db.query('DELETE FROM stores WHERE id = $1', [storeId]);
    await db.end();
  });

  test('a real uploaded product image is actually reachable at a public URL over plain HTTP, no auth', async () => {
    const req = {
      storeId,
      storeUserId,
      params: {},
      body: { product_name: 'Real Upload Test Product', price: '199.99' },
      file: { buffer: REAL_JPEG },
    };
    const res = mockRes();

    await StoreInventoryController.addProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const product = res.json.mock.calls[0][0].product;
    expect(product.image_url).toMatch(/^https:\/\/res\.cloudinary\.com\//);

    let publicId;
    try {
      // Genuinely fetch the URL a real customer's phone would load --
      // this is the actual thing that was broken (the upload call itself
      // crashed every time, so no URL, real or fake, ever existed before
      // the fix). No Authorization header, exactly like the real
      // storefront's <Image> tag would request it.
      const response = await fetch(product.image_url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^image\//);

      // Extract the public_id Cloudinary actually assigned (folder/name,
      // no extension) so cleanup targets the real asset.
      const match = product.image_url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
      publicId = match ? match[1] : null;
    } finally {
      await destroyPublicAsset(publicId);
      await db.query('DELETE FROM flash_inventory WHERE id = $1', [product.id]);
    }
  }, 30000);

  test('updateImage on a real, existing product also produces a genuinely reachable public URL', async () => {
    const createReq = {
      storeId,
      storeUserId,
      params: {},
      body: { product_name: 'Real Update-Image Test Product', price: '99.99' },
    };
    const createRes = mockRes();
    await StoreInventoryController.addProduct(createReq, createRes);
    const productId = createRes.json.mock.calls[0][0].product.id;

    let publicId;
    try {
      const updateReq = { storeId, storeUserId, params: { productId }, file: { buffer: REAL_JPEG } };
      const updateRes = mockRes();
      await StoreInventoryController.updateImage(updateReq, updateRes);

      const updated = updateRes.json.mock.calls[0][0].product;
      expect(updated.image_url).toMatch(/^https:\/\/res\.cloudinary\.com\//);

      const response = await fetch(updated.image_url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^image\//);

      const match = updated.image_url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
      publicId = match ? match[1] : null;
    } finally {
      await destroyPublicAsset(publicId);
      await db.query('DELETE FROM flash_inventory WHERE id = $1', [productId]);
    }
  }, 30000);
});

if (!CLOUDINARY_CONFIGURED) {
  test.skip('StoreInventoryController product image upload -- skipped, CLOUDINARY_CLOUD_NAME not set in this environment', () => {});
}
