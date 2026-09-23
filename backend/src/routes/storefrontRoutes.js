const express = require("express");
const router = express.Router();
const { validateId } = require("../middleware/validation");
const { cache } = require("../middleware/cache");
const StorefrontController = require("../controllers/storefrontController");

// Public, unauthenticated — same trust boundary as /api/inventory (real
// data, customer-browsable, no auth). Same 60s cache precedent for the
// same reason: read-heavy, changes infrequently, and any admin-side store
// edit is expected to be rare enough that a short TTL is a fine trade-off
// (no invalidation wiring exists yet since no store-edit endpoint exists
// yet either — add clearCache() there if/when one is built).
router.get("/", cache(60), StorefrontController.listStores);
router.get("/:storeId", validateId, cache(60), StorefrontController.getStore);

module.exports = router;
