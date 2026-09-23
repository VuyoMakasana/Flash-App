'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore, requireStorePasswordCurrent } = require('../middleware/auth');
const StoreOrderController = require('../controllers/storeOrderController');

// FLASH_STORE_ADMIN_DESIGN.md §5.3's RBAC table: Finance sees "Financial/
// analytics screens only" — Owner and Store Manager also see it (both see
// "financials" per the same table), but Sales/Inventory Staff/Marketing do
// not, a different three-role set than Orders' (Owner/Manager/Sales).
const ANALYTICS_VISIBLE_ROLES = ['owner', 'store_manager', 'finance'];

router.use(authenticateStore, requireOwnStore, requireStorePasswordCurrent, requireStoreRole(...ANALYTICS_VISIBLE_ROLES));

router.get('/', StoreOrderController.getAnalytics);

module.exports = router;
