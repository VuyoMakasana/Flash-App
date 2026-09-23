'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore, requireStorePasswordCurrent } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const { storeWriteLimiter } = require('../middleware/rateLimiter');
const StoreOrderController = require('../controllers/storeOrderController');

// FLASH_STORE_ADMIN_DESIGN.md §5.3's RBAC table only grants order visibility
// ("Sees") to Owner, Store Manager, and Sales Staff — applied here
// literally, not approximated. requireOwnStore is included even though
// these routes carry no client-supplied storeId to check against
// (ownership is enforced inside the controller by comparing the fetched
// order's own store_id to req.storeId) — defense in depth for any future
// route shape on this tree that does carry one.
const ORDER_VISIBLE_ROLES = ['owner', 'store_manager', 'sales_staff'];

router.use(authenticateStore, requireOwnStore, requireStorePasswordCurrent, requireStoreRole(...ORDER_VISIBLE_ROLES));

router.get('/', StoreOrderController.listOrders);
router.get('/:orderId', validateId, StoreOrderController.getOrder);
router.post('/:orderId/accept', storeWriteLimiter, validateId, StoreOrderController.accept);
router.post('/:orderId/reject', storeWriteLimiter, validateId, StoreOrderController.reject);
router.post('/:orderId/mark-ready', storeWriteLimiter, validateId, StoreOrderController.markReady);

module.exports = router;
