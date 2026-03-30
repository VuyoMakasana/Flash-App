const express = require('express');
const router  = express.Router();
const WebhookController = require('../controllers/webhookController');

// If a prior express.raw() left req.body as a Buffer, parse it back to JSON.
// This is a safety net in case middleware ordering changes in future.
function parseJsonIfBuffer(req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    console.warn('[Webhook] parseJsonIfBuffer triggered — check middleware order');
    try {
      const text = req.body.toString('utf8');
      req.body = text ? JSON.parse(text) : {};
    } catch (err) {
      return next(err);
    }
  }
  return next();
}

// Paystack: apply express.raw() on this route only so HMAC verification
// receives the original bytes. Do NOT add express.json() here.
router.post('/paystack', express.raw({ type: 'application/json' }), WebhookController.handlePaystack);

// Payflex: needs a parsed JSON object. express.json() handles the normal
// path; parseJsonIfBuffer covers edge cases where a Buffer slips through.
router.post('/payflex', express.json(), parseJsonIfBuffer, WebhookController.handlePayflex);

module.exports = router;
