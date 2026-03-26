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

  static async chargeSavedCard(req, res) {
    const { orderId, cardId } = req.body;
    const io = req.app.get("io");

    if (!orderId || !cardId) {
      return res.status(400).json({ error: "orderId and cardId are required" });
    }

    try {
      const card = await Payment.getSavedCardById(cardId, req.userId);
      if (!card) {
        return res.status(404).json({ error: "Saved card not found" });
      }

      const order = await Order.getByIdWithDetails(orderId, req.userId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (order.payment_status === "paid") {
        return res.status(409).json({ error: "Order already paid" });
      }

      const userResult = await require("../config/database").query(
        "SELECT email FROM users WHERE id=$1",
        [req.userId],
      );
      const email = userResult.rows[0]?.email;
      const amountInCents = Math.round(parseFloat(order.total) * 100);

      const paystackRes = await paystackService.chargeAuthorization(
        card.paystack_authorization_code,
        email,
        amountInCents,
        {
          orderId,
          userId: req.userId,
          cardId: card.id,
          source: "saved_card",
        },
      );

      if (!paystackRes?.status) {
        return res
          .status(400)
          .json({ error: paystackRes?.message || "Card charge failed" });
      }

      if (paystackRes.data?.status !== "success") {
        return res.status(202).json({
          success: false,
          status: paystackRes.data?.status || "pending",
          message: paystackRes.data?.gateway_response || "Payment pending",
        });
      }

      await Payment.markOrderPaidByCard(
        orderId,
        req.userId,
        parseFloat(order.total),
        paystackRes.data?.id || paystackRes.data?.reference,
      );

      if (io) {
        io.to(`user:${req.userId}`).emit("payment_confirmed", { orderId });
        io.to("driver_pool").emit("new_order_available", {
          orderId,
          isCashDelivery: false,
        });
      }

      res.json({
        success: true,
        orderId,
        reference: paystackRes.data?.reference,
        message: "Payment successful",
      });
    } catch (err) {
      console.error("[Paystack] Saved card charge error:", err.message);
      res.status(500).json({ error: "Failed to charge saved card" });
    }
  }
}

module.exports = PaymentController;
