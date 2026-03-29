const crypto = require("crypto");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const paystackService = require("../services/paystackService");
const db = require("../config/database");

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
      const result = await paystackService.verifyPayment(reference, io, req.userId);
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
      const userResult = await db.query(
        "SELECT email FROM users WHERE id=$1",
        [req.userId],
      );
      const email = userResult.rows[0]?.email;

      // Lock the order row to prevent concurrent charge attempts and to persist
      // the reference atomically before calling Paystack.
      const client = await db.connect();
      let order, reference;
      try {
        await client.query("BEGIN");

        const lockedResult = await client.query(
          `SELECT id, total, payment_status, paystack_reference, user_id
           FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [orderId, req.userId],
        );

        if (!lockedResult.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Order not found" });
        }

        order = lockedResult.rows[0];

        if (order.payment_status === "paid") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Order already paid" });
        }

        // Reject concurrent charge attempts while a charge is already in flight.
        if (order.payment_status === "pending" && order.paystack_reference) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Payment already pending confirmation",
            awaitingWebhook: true,
            reference: order.paystack_reference,
          });
        }

        reference = `flash_sc_${orderId}_${crypto.randomBytes(8).toString("hex")}`;
        await client.query(
          `UPDATE orders
           SET paystack_reference = $1, status = 'payment_pending', payment_status = 'pending', updated_at = NOW()
           WHERE id = $2`,
          [reference, orderId],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

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
        reference,
      );

      if (!paystackRes?.status) {
        // Paystack rejected the charge outright — revert so the client can retry.
        await db.query(
          `UPDATE orders
           SET payment_status = 'pending', paystack_reference = NULL, updated_at = NOW()
           WHERE id = $1`,
          [orderId],
        );
        return res
          .status(400)
          .json({ error: paystackRes?.message || "Card charge failed" });
      }

      if (paystackRes.data?.status !== "success") {
        // Non-immediate-success (e.g. send_otp, pending) — revert so the client can retry.
        await db.query(
          `UPDATE orders
           SET payment_status = 'pending', paystack_reference = NULL, updated_at = NOW()
           WHERE id = $1`,
          [orderId],
        );
        return res.status(202).json({
          success: false,
          status: paystackRes.data?.status || "pending",
          message: paystackRes.data?.gateway_response || "Payment pending",
        });
      }

      // Charge accepted — webhook is the source of truth for final paid transition.
      res.status(202).json({
        success: true,
        orderId,
        reference,
        message: "Charge accepted. Awaiting webhook confirmation.",
        awaitingWebhook: true,
      });
    } catch (err) {
      console.error("[Paystack] Saved card charge error:", err.message);
      res.status(500).json({ error: "Failed to charge saved card" });
    }
  }
}

module.exports = PaymentController;
