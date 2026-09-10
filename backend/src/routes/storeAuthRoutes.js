'use strict';

const express = require('express');
const router = express.Router();
const { authenticateStore } = require('../middleware/auth');
const StoreAuthController = require('../controllers/storeAuthController');
const { storeAuthLimiter } = require('../middleware/rateLimiter');

// POST /api/store-auth/login — 5 attempts per 15 min, its own dedicated
// counter (FLASH_STORE_ADMIN_DESIGN.md §5.5).
router.post('/login', storeAuthLimiter, StoreAuthController.login);

router.post('/logout', authenticateStore, StoreAuthController.logout);

// No requireStoreRole restriction here -- every authenticated role must be
// able to reach this route (that's the whole point of self-service
// deletion); the Owner-specific rejection is a business rule the
// controller itself decides, not a route-level access gate.
router.delete('/account', authenticateStore, StoreAuthController.deleteAccount);

module.exports = router;
