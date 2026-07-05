const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const SosController = require('../controllers/sosController');

// Available to both customer and driver roles (unlike most order-scoped
// routes, which are role-restricted to one side) — access is checked inside
// the controller against the order's own user_id/driver_id instead.
router.post('/:orderId/trigger', authenticate, validateId, SosController.trigger);

module.exports = router;
