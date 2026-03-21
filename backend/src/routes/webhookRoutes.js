const express = require("express");
const router = express.Router();
const WebhookController = require("../controllers/webhookController");

router.post("/paystack", express.json(), WebhookController.handlePaystack);
router.post("/payflex", express.json(), WebhookController.handlePayflex);

module.exports = router;
