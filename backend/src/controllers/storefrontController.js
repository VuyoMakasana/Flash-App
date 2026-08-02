const Store = require("../models/Store");

// Multi-tenant Stage 7 — the customer-facing storefront's real, public,
// unauthenticated store directory/detail endpoints. Mirrors
// inventoryController.js's shape exactly (same public-read pattern, same
// error handling), since these two resources (products, stores) share the
// same trust boundary: real data, publicly browsable, no customer store_id
// claim to check against (per MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md §1.5).
class StorefrontController {
  static async listStores(req, res) {
    const { page = 1, limit = 20 } = req.query;
    try {
      const stores = await Store.listActive(page, limit);
      res.json({ stores });
    } catch (err) {
      console.error("[Storefront] listStores error:", err.message);
      res.status(500).json({ error: "Failed to fetch stores" });
    }
  }

  static async getStore(req, res) {
    const { storeId } = req.params;
    try {
      const store = await Store.findPublicById(storeId);
      if (!store) {
        return res.status(404).json({ error: "Store not found" });
      }
      res.json({ store });
    } catch (err) {
      console.error("[Storefront] getStore error:", err.message);
      res.status(500).json({ error: "Failed to fetch store" });
    }
  }
}

module.exports = StorefrontController;
