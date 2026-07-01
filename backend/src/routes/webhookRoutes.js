'use strict';

/**
 * webhookRoutes.js
 *
 * CRITICAL-3 FIX: /webhooks/payflex route removed.
 *   Only Paystack webhooks are accepted. Payflex data in the DB is preserved
 *   (payflex_webhook_events table and payflex_order_id column remain) but no
 *   new events are processed.
 */

const express           = require('express');
const router            = express.Router();
const WebhookController = require('../controllers/webhookController');

// Paystack: apply express.raw() on this route only so HMAC verification
// receives the original bytes. Do NOT add express.json() here.
router.post('/paystack', express.raw({ type: 'application/json' }), WebhookController.handlePaystack);

module.exports = router;
