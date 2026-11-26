'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore, requireStorePasswordCurrent } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const { storeWriteLimiter } = require('../middleware/rateLimiter');
const { requireFeature } = require('../middleware/requireFeature');
// Kill switch (L0.5b): every write here is a store setting. Order handling
// (store-orders accept/reject/mark ready) is deliberately NOT guarded.
const storeSettingsWrite = requireFeature('store_portal_writes');
const StoreStaffController = require('../controllers/storeStaffController');

// FLASH_STORE_ADMIN_DESIGN.md §6.2 and DOMAIN_OWNERSHIP_AUTHORITY_
// SPECIFICATION.md §2 both agree explicitly: managing store_users is
// Owner-only, no Store Manager exception. Applied literally — a single
// role, not a set, unlike Orders/Inventory's three. This IS the server-side
// enforcement of "no role can grant itself a higher role or act outside
// what its role permits, enforced server-side, not just hide UI for it" —
// a non-Owner token can never reach any of these three routes at all,
// regardless of what any client sends.
router.use(authenticateStore, requireOwnStore, requireStorePasswordCurrent, requireStoreRole('owner'));

router.get('/', StoreStaffController.listStaff);
router.post('/', storeSettingsWrite, storeWriteLimiter, StoreStaffController.createStaff);
router.patch('/:staffId/deactivate', storeSettingsWrite, storeWriteLimiter, validateId, StoreStaffController.deactivateStaff);
router.patch('/:staffId/reactivate', storeSettingsWrite, storeWriteLimiter, validateId, StoreStaffController.reactivateStaff);

module.exports = router;
