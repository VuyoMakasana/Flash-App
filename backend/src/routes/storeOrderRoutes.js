'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore, requireStoreRole, requireOwnStore } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const StoreOrderController = require('../controllers/storeOrderController');

// Multi-tenant Stage 3 — FLASH_STORE_ADMIN_DESIGN.md §5.3's RBAC table only
// grants order visibility ("Sees") to Owner, Store Manager, and Sales Staff —
// Inventory Staff, Finance, and Marketing have no order-screen access at all,
// applied here literally, not approximated. requireOwnStore is included on
// every route per §5.1's mandatory-middleware rule, even though these
// particular routes carry no client-supplied storeId to check against
// (ownership is enforced inside the controller by comparing the fetched
// order's own store_id to req.storeId) — defense in depth for any future
// route shape on this tree that does carry one.
const ORDER_VISIBLE_ROLES = ['owner', 'store_manager', 'sales_staff'];

router.use(authenticateStore, requireOwnStore, requireStoreRole(...ORDER_VISIBLE_ROLES));

router.get('/', StoreOrderController.listOrders);
router.get('/:orderId', validateId, StoreOrderController.getOrder);
router.post('/:orderId/accept', validateId, StoreOrderController.accept);
router.post('/:orderId/reject', validateId, StoreOrderController.reject);
router.post('/:orderId/mark-ready', validateId, StoreOrderController.markReady);

module.exports = router;
