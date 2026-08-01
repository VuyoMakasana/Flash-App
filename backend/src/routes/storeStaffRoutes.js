'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const StoreStaffController = require('../controllers/storeStaffController');

// Multi-tenant Stage 5 — FLASH_STORE_ADMIN_DESIGN.md §6.2 and
// DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §2 both agree explicitly:
// managing store_users is Owner-only, no Store Manager exception. Applied
// literally -- a single role, not a set, unlike Orders/Inventory's three.
router.use(authenticateStore, requireOwnStore, requireStoreRole('owner'));

router.get('/', StoreStaffController.listStaff);
router.post('/', StoreStaffController.createStaff);
router.patch('/:staffId/deactivate', validateId, StoreStaffController.deactivateStaff);

module.exports = router;
