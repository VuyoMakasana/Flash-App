'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateStore, requireStoreRole, requireOwnStore } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const StoreInventoryController = require('../controllers/storeInventoryController');

// Multi-tenant Stage 6 — product images. Mirrors driverRoutes.js's own
// uploadPhoto config exactly (memoryStorage, 10MB limit, image-only) — the
// same proven pattern, not a new one. multer's fileFilter only sees the
// client-declared mimetype (trivially spoofable); the controller's own
// magic-byte check via detectRealMimeType is the real gate.
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG and PNG images are allowed'));
    }
  },
});

// Multi-tenant Stage 4 — FLASH_STORE_ADMIN_DESIGN.md §5.3's RBAC table only
// grants inventory visibility ("Sees") to Owner, Store Manager, and
// Inventory Staff — different three roles than Orders' (Owner/Store
// Manager/Sales Staff), applied here literally. Finance/Marketing/Sales
// Staff get 403 on this whole route tree.
const INVENTORY_VISIBLE_ROLES = ['owner', 'store_manager', 'inventory_staff'];

router.use(authenticateStore, requireOwnStore, requireStoreRole(...INVENTORY_VISIBLE_ROLES));

router.get('/', StoreInventoryController.listProducts);
router.get('/:productId', validateId, StoreInventoryController.getProduct);
router.post('/', uploadImage.single('image'), StoreInventoryController.addProduct);
router.patch('/:productId/stock', validateId, StoreInventoryController.updateStock);
router.patch('/:productId/image', validateId, uploadImage.single('image'), StoreInventoryController.updateImage);
router.patch('/:productId/deactivate', validateId, StoreInventoryController.deactivateProduct);

module.exports = router;
