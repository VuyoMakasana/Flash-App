const express = require('express');
const router  = express.Router();
const WebhookController = require('../controllers/webhookController');

// Paystack: body arrives as raw Buffer (express.raw applied in server.js).
// Do NOT add express.json() here — it breaks HMAC signature verification.
router.post('/paystack', WebhookController.handlePaystack);

// Payflex: needs JSON body parsing.
router.post('/payflex', express.json(), WebhookController.handlePayflex);

module.exports = router;
