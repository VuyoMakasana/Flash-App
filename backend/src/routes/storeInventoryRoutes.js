'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const StoreInventoryController = require('../controllers/storeInventoryController');

// Multi-tenant Stage 4 — FLASH_STORE_ADMIN_DESIGN.md §5.3's RBAC table only
// grants inventory visibility ("Sees") to Owner, Store Manager, and
// Inventory Staff — different three roles than Orders' (Owner/Store
// Manager/Sales Staff), applied here literally. Finance/Marketing/Sales
// Staff get 403 on this whole route tree.
const INVENTORY_VISIBLE_ROLES = ['owner', 'store_manager', 'inventory_staff'];

router.use(authenticateStore, requireOwnStore, requireStoreRole(...INVENTORY_VISIBLE_ROLES));

router.get('/', StoreInventoryController.listProducts);
router.get('/:productId', validateId, StoreInventoryController.getProduct);
router.post('/', StoreInventoryController.addProduct);
router.patch('/:productId/stock', validateId, StoreInventoryController.updateStock);
router.patch('/:productId/deactivate', validateId, StoreInventoryController.deactivateProduct);

module.exports = router;
