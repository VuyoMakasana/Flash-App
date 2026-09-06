const db = require("../config/database");
const StoreAction = require("../models/StoreAction");
const { clearCache } = require("../middleware/cache");
const s3Service = require("../services/s3Service");
const { detectRealMimeType } = require("../utils/fileSignature");

// Multi-tenant Stage 4 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §5.3/§6.2) —
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
// they do today. This controller owns its own store-scoped queries instead,
// the same choice storeOrderController.js made for orders (fresh queries,
// reusing only the state-machine's own action functions, which already
// operate per-order with their own authorization).
//
// "General edit" (price/description/etc., beyond stock) has no existing
// REST-endpoint precedent anywhere in this codebase, even for Flash admins
// today — only the internal admin panel's own raw AdminJS form can do that.
// Not invented here without being asked; this mirrors exactly the real
// capabilities that already exist as a precedented pattern: create, adjust
// stock, deactivate.
class StoreInventoryController {
  static async listProducts(req, res) {
    try {
      const result = await db.query(
        `SELECT id, product_name, category, brand, price, cost_price, sizes,
                stock_by_size, image_url, description, is_active, created_at, updated_at
         FROM flash_inventory
         WHERE store_id = $1
         ORDER BY created_at DESC LIMIT 200`,
        [req.storeId],
      );
      res.json({ products: result.rows });
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
  // multipart/form-data (the image-upload path, storeInventoryRoutes.js's
  // uploadProductImage middleware) but as real objects if a caller ever
  // posts plain JSON instead -- accepting both means addProduct doesn't
  // silently double-encode or crash depending on which content-type a
  // given request used.
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

    try {
      // Image is optional at creation time (multer's .single() leaves
      // req.file undefined when none was attached) -- real magic-byte
      // verification, not just multer's client-declared mimetype, same
      // discipline as driver documents/order photos.
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
          req.storeId, product_name, category || null, brand || null, price, cost_price || null,
          JSON.stringify(sizes), JSON.stringify(stock_by_size), imageUrl, description || null,
        ],
      );
      const product = result.rows[0];
      // The public customer catalog (GET /api/inventory) caches this same
      // table for 60s -- a store-created product/stock change must not be
      // invisible to real customers for up to a minute, same reason every
      // other write path against flash_inventory already does this.
      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_create", "flash_inventory", product.id);
      res.status(201).json({ product });
    } catch (err) {
      console.error("[StoreInventory] addProduct error:", err.message);
      res.status(500).json({ error: "Failed to add product" });
    }
  }

  // The separate "update-image" action for an existing product -- the
  // internal admin panel's own flash_inventory resource still only takes a
  // plain-text image_url paste; this is the first real upload path for
  // this column anywhere in the codebase.
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

  // F-05 remediation (Phase 0.5 pre-implementation audit) — was a bare,
  // non-transactional UPDATE with no lock, exactly like the platform-wide
  // Inventory.updateStock() this controller deliberately doesn't reuse (see
  // the class comment above). Same fix applied in parallel there: wrap in a
  // real transaction with SELECT...FOR UPDATE first, so this write
  // correctly serializes against a concurrent customer checkout on the
  // same product instead of racing it with no ordering guarantee.
  //
  // Same residual limitation as Inventory.updateStock(), not fixed by this
  // change either: this still takes a full stock_by_size replacement, not
  // a per-size delta, so a stale Store Portal submission can still
  // overwrite a concurrent decrement once the lock is acquired. Locking
  // fixes ordering/atomicity, not staleness — flagged, not silently
  // solved, same as the platform-wide version.
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
}

module.exports = StoreInventoryController;
