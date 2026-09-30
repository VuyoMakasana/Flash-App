'use strict';

const db = require("../config/database");
const StoreAction = require("../models/StoreAction");
const { clearCache } = require("../middleware/cache");
const s3Service = require("../services/s3Service");
const { detectRealMimeType } = require("../utils/fileSignature");
const { validateProductPrice, validateProductCostPrice } = require("../utils/helpers");

// Admin Platform Phase 3 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §5.3/§6.2) —
// the Store Admin Portal's real Inventory screen backend, mirroring
// storeOrderController.js's exact shape: every handler derives store scope
// from req.storeId (set by authenticateStore), never from req.params/body/
// query. A cross-store mismatch is reported as 404, not 403, matching the
// same anti-enumeration convention used throughout this codebase.
//
// Deliberately does NOT reuse Inventory.addProduct/updateStock/deleteProduct
// (backend/src/models/Inventory.js) — those back the existing, unscoped,
// platform-wide Flash-admin REST endpoints (/api/inventory, requireRole
// admin) and the public customer catalog, and must keep behaving exactly as
// they do today. This controller owns its own store-scoped queries instead.
function parsePagination(query) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

class StoreInventoryController {
  static async listProducts(req, res) {
    const { page, limit, offset } = parsePagination(req.query);
    try {
      const result = await db.query(
        `SELECT id, product_name, category, brand, price, cost_price, sizes,
                stock_by_size, image_url, description, is_active, created_at, updated_at
         FROM flash_inventory
         WHERE store_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.storeId, limit, offset],
      );
      res.json({ products: result.rows, page, limit });
    } catch (err) {
      console.error("[StoreInventory] listProducts error:", err.message);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  }

  static async getProduct(req, res) {
    try {
      const result = await db.query(`SELECT * FROM flash_inventory WHERE id = $1`, [req.params.productId]);
      if (!result.rows.length) return res.status(404).json({ error: "Product not found" });

      const product = result.rows[0];
      if (String(product.store_id) !== String(req.storeId)) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ product });
    } catch (err) {
      console.error("[StoreInventory] getProduct error:", err.message);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  }

  // sizes/stock_by_size arrive as JSON-encoded strings when this request is
  // multipart/form-data (the image-upload path) but as real objects if a
  // caller ever posts plain JSON instead — accepting both means addProduct
  // doesn't silently double-encode or crash depending on content-type.
  static _parseJsonField(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (_) { return fallback; }
    }
    return value;
  }

  static async addProduct(req, res) {
    const { product_name, category, brand, price, cost_price, description } = req.body;
    const sizes = StoreInventoryController._parseJsonField(req.body.sizes, []);
    const stock_by_size = StoreInventoryController._parseJsonField(req.body.stock_by_size, {});
    if (!product_name || price === undefined || price === null) {
      return res.status(400).json({ error: "product_name and price are required" });
    }

    // OPEN_FOLLOWUPS #21. Presence was the only check here, so a product could
    // be CREATED at any price even though it could not be EDITED to one — and
    // nothing downstream catches it: the schema has no CHECK beyond v40's, and
    // checkout trusts an inventory row's price rather than re-validating it.
    // Same validator as updateProduct, reported in the same
    // { errors: [{ path, msg }] } shape the portal already renders per-field.
    const priceCheck = validateProductPrice(price);
    const costCheck = validateProductCostPrice(cost_price);
    const errors = [];
    if (!priceCheck.ok) errors.push({ path: 'price', msg: priceCheck.msg });
    if (!costCheck.ok) errors.push({ path: 'cost_price', msg: costCheck.msg });
    if (errors.length) return res.status(400).json({ errors });

    try {
      // Image is optional at creation time — real magic-byte verification,
      // not just multer's client-declared mimetype, same discipline as
      // driver documents/order photos.
      let imageUrl = null;
      if (req.file) {
        const realType = detectRealMimeType(req.file.buffer);
        if (!["image/jpeg", "image/png"].includes(realType)) {
          return res.status(400).json({ error: "File content does not match an allowed image type (JPG or PNG)." });
        }
        const uploadResult = await s3Service.uploadPublicFile(req.file, "flash-product-images");
        imageUrl = uploadResult.url;
      }

      const result = await db.query(
        `INSERT INTO flash_inventory (store_id, product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          // priceCheck.value / costCheck.value, not the raw body values: these
          // are the parsed, cent-rounded numbers. costCheck.value also fixes a
          // real bug — `cost_price || null` turned a submitted 0 into NULL,
          // because 0 is falsy, so the same input meant "free to us" through
          // updateProduct and "cost unknown" through here.
          req.storeId, product_name, category || null, brand || null, priceCheck.value, costCheck.value,
          JSON.stringify(sizes), JSON.stringify(stock_by_size), imageUrl, description || null,
        ],
      );
      const product = result.rows[0];
      // The public customer catalog (GET /api/inventory) caches this same
      // table for 60s — a store-created product/stock change must not be
      // invisible to real customers for up to a minute.
      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_create", "flash_inventory", product.id);
      res.status(201).json({ product });
    } catch (err) {
      console.error("[StoreInventory] addProduct error:", err.message);
      res.status(500).json({ error: "Failed to add product" });
    }
  }

  static async updateImage(req, res) {
    const { productId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: "An image file is required" });
    }
    const realType = detectRealMimeType(req.file.buffer);
    if (!["image/jpeg", "image/png"].includes(realType)) {
      return res.status(400).json({ error: "File content does not match an allowed image type (JPG or PNG)." });
    }
    try {
      const uploadResult = await s3Service.uploadPublicFile(req.file, "flash-product-images");
      const result = await db.query(
        `UPDATE flash_inventory SET image_url = $1, updated_at = NOW()
         WHERE id = $2 AND store_id = $3 RETURNING *`,
        [uploadResult.url, productId, req.storeId],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Product not found" });

      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_update_image", "flash_inventory", productId);
      res.json({ product: result.rows[0] });
    } catch (err) {
      console.error("[StoreInventory] updateImage error:", err.message);
      res.status(500).json({ error: "Failed to update image" });
    }
  }

  // Wraps a real transaction with SELECT...FOR UPDATE first, so this write
  // correctly serializes against a concurrent customer checkout on the same
  // product instead of racing it with no ordering guarantee. Same residual
  // limitation as the platform-wide Inventory.updateStock(): this still
  // takes a full stock_by_size replacement, not a per-size delta, so a
  // stale Store Portal submission can still overwrite a concurrent
  // decrement once the lock is acquired — flagged, not silently solved.
  static async updateStock(req, res) {
    const { productId } = req.params;
    const { stock_by_size } = req.body;
    if (!stock_by_size || typeof stock_by_size !== "object") {
      return res.status(400).json({ error: "stock_by_size object is required" });
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT id FROM flash_inventory WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [productId, req.storeId],
      );
      if (!existing.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Product not found" });
      }

      const result = await client.query(
        `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW()
         WHERE id = $2 AND store_id = $3 RETURNING *`,
        [JSON.stringify(stock_by_size), productId, req.storeId],
      );

      await client.query("COMMIT");

      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_update_stock", "flash_inventory", productId);
      res.json({ product: result.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[StoreInventory] updateStock error:", err.message);
      res.status(500).json({ error: "Failed to update stock" });
    } finally {
      client.release();
    }
  }

  // PATCH /:productId — correct a product's details after creation.
  //
  // Until this existed a store could add a product but never fix it. A
  // mistyped price could only be resolved by deactivating and re-adding,
  // which loses the product's id and its order history. In a marketplace
  // whose commission is a percentage OF THAT PRICE, an uncorrectable price
  // is the sharpest gap in the portal.
  //
  // WHITELISTED FIELDS ONLY, built as a parameterised SET list. The column
  // names come from EDITABLE_FIELDS below and never from the request, so a
  // caller cannot reach store_id, is_active, id or the timestamps by adding
  // keys to the body. Deliberately excluded:
  //   stock_by_size / image_url — own endpoints, with their own semantics
  //   is_active                 — deactivate/reactivate, so the change is audited as itself
  //   store_id                  — reassigning a product to another store is not an edit
  static async updateProduct(req, res) {
    const { productId } = req.params;

    const EDITABLE_FIELDS = {
      product_name: (v) => (typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 200
        ? { ok: true, value: v.trim() } : { ok: false, msg: 'product_name must be 2-200 characters' }),
      // Parsed and range-checked rather than passed through: price drives
      // commission, so a NaN or a negative reaching NUMERIC(10,2) would be a
      // money bug, not a validation nicety.
      //
      // Shared with addProduct below and with the legacy admin REST route
      // (OPEN_FOLLOWUPS #21) — one rule, three call sites, so they cannot
      // drift. The reasoning about why the write path is the only place a
      // bound can be enforced lives with the function in utils/helpers.js.
      price: validateProductPrice,
      cost_price: validateProductCostPrice,
      category: (v) => (v === null || v === '' || (typeof v === 'string' && v.length <= 100)
        ? { ok: true, value: v === '' ? null : v } : { ok: false, msg: 'category must be at most 100 characters' }),
      brand: (v) => (v === null || v === '' || (typeof v === 'string' && v.length <= 100)
        ? { ok: true, value: v === '' ? null : v } : { ok: false, msg: 'brand must be at most 100 characters' }),
      description: (v) => (v === null || v === '' || (typeof v === 'string' && v.length <= 2000)
        ? { ok: true, value: v === '' ? null : v } : { ok: false, msg: 'description must be at most 2000 characters' }),
    };

    const setFragments = [];
    const values = [];
    const errors = [];

    for (const [field, validate] of Object.entries(EDITABLE_FIELDS)) {
      // Only fields actually present are touched, so a partial PATCH cannot
      // blank out a column the caller never mentioned.
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
      const result = validate(req.body[field]);
      if (!result.ok) {
        // `path`/`msg`, deliberately matching express-validator's wire shape
        // rather than inventing a second one: the portal's api.js already
        // normalizes that shape into per-field messages, so hand-rolled
        // validation here renders next to the offending input for free.
        errors.push({ path: field, msg: result.msg });
        continue;
      }
      values.push(result.value);
      setFragments.push(`${field} = $${values.length}`);
    }

    if (errors.length) return res.status(400).json({ errors });
    if (!setFragments.length) {
      return res.status(400).json({ error: 'No editable fields supplied.' });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Locked and store-scoped before the write, matching updateStock. 404
      // rather than 403 so another store's product id is not confirmed to
      // exist.
      const existing = await client.query(
        `SELECT id, price FROM flash_inventory WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [productId, req.storeId],
      );
      if (!existing.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Product not found" });
      }

      values.push(productId, req.storeId);
      const result = await client.query(
        `UPDATE flash_inventory SET ${setFragments.join(', ')}, updated_at = NOW()
         WHERE id = $${values.length - 1} AND store_id = $${values.length} RETURNING *`,
        values,
      );

      await client.query("COMMIT");

      await clearCache("cache:*/inventory*");
      // The previous price is recorded in the audit metadata, because "why did
      // this order's commission not match the current price" is answerable
      // only if the price at the time is recoverable. Orders already freeze
      // their own unit_price, so this is for reconstructing the store's
      // intent, not the order's maths.
      StoreAction.log(
        req.storeUserId, req.storeId, "product_update", "flash_inventory", productId,
        { fields: setFragments.map((f) => f.split(' = ')[0]), previous_price: existing.rows[0].price },
      );
      res.json({ product: result.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[StoreInventory] updateProduct error:", err.message);
      res.status(500).json({ error: "Failed to update product" });
    } finally {
      client.release();
    }
  }

  static async deactivateProduct(req, res) {
    const { productId } = req.params;
    try {
      const result = await db.query(
        `UPDATE flash_inventory SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND store_id = $2 RETURNING *`,
        [productId, req.storeId],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Product not found" });

      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_deactivate", "flash_inventory", productId);
      res.json({ product: result.rows[0] });
    } catch (err) {
      console.error("[StoreInventory] deactivateProduct error:", err.message);
      res.status(500).json({ error: "Failed to deactivate product" });
    }
  }

  // The inverse of deactivateProduct. Without it a product deactivated by
  // mistake was gone from the catalogue permanently — the row still there,
  // still correct, and only restorable with direct database access.
  //
  // Mirrors deactivateProduct exactly, including clearing the inventory cache:
  // a reactivated product must reappear on the customer storefront, and a
  // stale cache would make the button look broken.
  static async reactivateProduct(req, res) {
    const { productId } = req.params;
    try {
      const result = await db.query(
        `UPDATE flash_inventory SET is_active = true, updated_at = NOW()
         WHERE id = $1 AND store_id = $2 RETURNING *`,
        [productId, req.storeId],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Product not found" });

      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_reactivate", "flash_inventory", productId);
      res.json({ product: result.rows[0] });
    } catch (err) {
      console.error("[StoreInventory] reactivateProduct error:", err.message);
      res.status(500).json({ error: "Failed to reactivate product" });
    }
  }
}

module.exports = StoreInventoryController;
