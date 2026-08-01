const db = require("../config/database");
const StoreAction = require("../models/StoreAction");
const { clearCache } = require("../middleware/cache");

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

  static async addProduct(req, res) {
    const { product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description } = req.body;
    if (!product_name || price === undefined || price === null) {
      return res.status(400).json({ error: "product_name and price are required" });
    }
    try {
      const result = await db.query(
        `INSERT INTO flash_inventory (store_id, product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          req.storeId, product_name, category || null, brand || null, price, cost_price || null,
          JSON.stringify(sizes || []), JSON.stringify(stock_by_size || {}), image_url || null, description || null,
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

  static async updateStock(req, res) {
    const { productId } = req.params;
    const { stock_by_size } = req.body;
    if (!stock_by_size || typeof stock_by_size !== "object") {
      return res.status(400).json({ error: "stock_by_size object is required" });
    }
    try {
      const result = await db.query(
        `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW()
         WHERE id = $2 AND store_id = $3 RETURNING *`,
        [JSON.stringify(stock_by_size), productId, req.storeId],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Product not found" });

      await clearCache("cache:*/inventory*");
      StoreAction.log(req.storeUserId, req.storeId, "product_update_stock", "flash_inventory", productId);
      res.json({ product: result.rows[0] });
    } catch (err) {
      console.error("[StoreInventory] updateStock error:", err.message);
      res.status(500).json({ error: "Failed to update stock" });
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
