const crypto = require("crypto");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const paystackService = require("../services/paystackService");
const db = require("../config/database");
const { updateOrderStatus } = require("../services/orderStateMachineService");
const { autoAssignNearestDriver } = require("../services/fleetIntelligenceService");
const cashOtpService = require("../services/cashOtpService");

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

      // Keep delivery lifecycle transitions centralized in the state machine.
      await updateOrderStatus(orderId, "paid", {
        actorId: req.userId,
        actorRole: "user",
        io,
      });
      await updateOrderStatus(orderId, "waiting_for_driver", {
        actorId: req.userId,
        actorRole: "user",
        io,
      });

      await autoAssignNearestDriver(orderId, io).catch(() => null);
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
    let reference;

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
      let order;
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
           SET paystack_reference = $1, payment_status = 'pending', updated_at = NOW()
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
        card.authorization_code,
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
        // Paystack explicitly rejected the charge — clear the reference so the client can retry.
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
        // Non-immediate-success statuses (e.g. send_otp, pending) mean Paystack may still
        // complete the charge asynchronously and send a webhook. Keep the reference so the
        // webhook finalization path can match the order.
        return res.status(202).json({
          success: false,
          status: paystackRes.data?.status || "pending",
          message: paystackRes.data?.gateway_response || "Payment pending",
          reference,
          awaitingWebhook: true,
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
      // If chargeAuthorization threw (network/API error), the request may or may
      // not have reached Paystack. Conditionally revert only when the reference
      // still matches (paystack_reference = $2), so we don't overwrite state that
      // was already advanced by an arriving webhook.
      if (reference) {
        await db.query(
          `UPDATE orders
           SET payment_status = 'pending', paystack_reference = NULL, updated_at = NOW()
           WHERE id = $1 AND paystack_reference = $2`,
          [orderId, reference],
        ).catch((e) => console.error("[Paystack] Cleanup revert failed:", e.message));
      }
      res.status(500).json({ error: "Failed to charge saved card" });
    }
  }

  static async confirmCashReceived(req, res) {
    const { orderId, otp } = req.body;
    const io = req.app.get("io");

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    try {
      const result = await db.query(
        `SELECT * FROM orders WHERE id = $1`,
        [orderId],
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = result.rows[0];
      if (order.driver_id !== req.userId) {
        return res.status(403).json({ error: "Not your order" });
      }
      if (order.payment_method !== "cash" || order.payment_status !== "pending_cash") {
        return res.status(409).json({ error: "Order is not awaiting cash confirmation" });
      }
      if (order.status !== "delivered") {
        return res.status(409).json({ error: "Cash can only be confirmed after delivery" });
      }
      if (!otp) {
        return res.status(400).json({ error: "OTP confirmation is required" });
      }

      await cashOtpService.verifyOtp(orderId, otp);

      await db.query(
        `UPDATE orders
         SET payment_status = 'paid', cash_received_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );

      await updateOrderStatus(orderId, "completed", {
        actorId: req.userId,
        actorRole: "driver",
        io,
      });

      return res.json({ success: true, payment_status: "paid", status: "completed" });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Failed to confirm cash" });
    }
  }

  static async sendCashOtp(req, res) {
    const { orderId } = req.body;
    const io = req.app.get("io");

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    try {
      const orderResult = await db.query(
        `SELECT id, user_id, driver_id, payment_method, payment_status, status
         FROM orders
         WHERE id = $1`,
        [orderId],
      );

      if (!orderResult.rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = orderResult.rows[0];
      if (String(order.driver_id) !== String(req.userId)) {
        return res.status(403).json({ error: "Not your order" });
      }
      if (order.payment_method !== "cash" || order.payment_status !== "pending_cash") {
        return res.status(409).json({ error: "Order is not awaiting cash payment" });
      }
      if (!["in_transit", "delivered"].includes(order.status)) {
        return res.status(409).json({ error: "Cash OTP can only be sent once the order is in transit or delivered" });
      }

      const otpResult = await cashOtpService.generateOtp(orderId);

      if (io) {
        io.to(`user:${order.user_id}`).emit("cash_otp_requested", {
          orderId,
          expiresAt: otpResult.order.cash_otp_expires_at,
          message: "Your Flash driver requested a cash confirmation OTP.",
        });
      }

      const response = {
        success: true,
        orderId,
        expiresAt: otpResult.order.cash_otp_expires_at,
      };

      // Only return OTP in non-production for QA/testing flows.
      if (process.env.NODE_ENV !== "production") {
        response.devOtp = otpResult.otp;
      }

      return res.json(response);
    } catch (err) {
      return res.status(400).json({ error: err.message || "Failed to send cash OTP" });
    }
  }

  static async markCashFailed(req, res) {
    const { orderId, reason } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    try {
      const result = await db.query(
        `SELECT id, driver_id, user_id, payment_method, payment_status
         FROM orders WHERE id = $1`,
        [orderId],
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }
      const order = result.rows[0];
      if (order.driver_id !== req.userId) {
        return res.status(403).json({ error: "Not your order" });
      }
      if (order.payment_method !== "cash") {
        return res.status(409).json({ error: "Not a cash order" });
      }

      await db.query(
        `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );

      await db.query(
        `UPDATE users
         SET cash_refusal_count = COALESCE(cash_refusal_count, 0) + 1,
             flagged_for_cash_abuse = CASE
               WHEN COALESCE(cash_refusal_count, 0) + 1 >= 2 THEN true
               ELSE flagged_for_cash_abuse
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [order.user_id],
      );

      await db.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, status, type, metadata)
         VALUES ($1, $2, 0, 'cash', 'cash_on_delivery', 'failed', 'delivery', $3::jsonb)`,
        [orderId, order.user_id, JSON.stringify({ reason: reason || "customer_refused_cash" })],
      );

      return res.json({ success: true, payment_status: "failed" });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Failed to mark cash failure" });
    }
  }
}

module.exports = PaymentController;
