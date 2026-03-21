const Payment = require("../models/Payment");
const Order = require("../models/Order");
const paystackService = require("../services/paystackService");

class PaymentController {
  static async initializePayment(req, res) {
    const { orderId } = req.body;
    try {
      const result = await paystackService.initializePayment(
        orderId,
        req.userId,
      );
      res.json(result);
    } catch (err) {
      console.error("[Paystack] Initialize error:", err);
      res.status(500).json({ error: "Failed to initialize payment" });
    }
  }

  static async verifyPayment(req, res) {
    const { reference } = req.params;
    const io = req.app.get("io");

    try {
      const result = await paystackService.verifyPayment(reference, io);
      res.json(result);
    } catch (err) {
      console.error("[Paystack] Verify error:", err);
      res.status(500).json({ error: "Failed to verify payment" });
    }
  }

  static async cashOnDelivery(req, res) {
    const { orderId } = req.body;
    const io = req.app.get("io");

    try {
      const result = await Payment.cashOnDelivery(orderId, req.userId, io);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to set cash delivery" });
    }
  }

  static async initiatePayflex(req, res) {
    const { orderId } = req.body;
    try {
      const result = await Payment.initiatePayflex(orderId, req.userId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to initiate Payflex" });
    }
  }

  static async getPaymentStatus(req, res) {
    const { orderId } = req.params;
    try {
      const status = await Order.getPaymentStatus(orderId, req.userId);
      if (!status) {
        return res.status(404).json({ error: "Order not found" });
      }
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch payment status" });
    }
  }

  static async getSavedCards(req, res) {
    try {
      const cards = await Payment.getSavedCards(req.userId);
      res.json({ cards });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  }

  static async removeCard(req, res) {
    const { cardId } = req.params;
    try {
      await Payment.removeCard(cardId, req.userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to remove card" });
    }
  }

  static async setDefaultCard(req, res) {
    const { cardId } = req.params;
    try {
      await Payment.setDefaultCard(cardId, req.userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to set default card" });
    }
  }
}

module.exports = PaymentController;
