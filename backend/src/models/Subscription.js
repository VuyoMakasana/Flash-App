const BaseModel = require("./BaseModel");
const paystackService = require("../services/paystackService");
const { PLANS } = require("../utils/constants");

class Subscription extends BaseModel {
  static async getDriverSubscription(driverId) {
    const result = await this.query(
      `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [driverId],
    );
    return result.rows[0];
  }

  static async purchaseDriverPlan(driverId, planId, plan) {
    const driverResult = await this.query(
      "SELECT name, email FROM drivers WHERE id=$1",
      [driverId],
    );
    if (!driverResult.rows.length) {
      throw new Error("Driver not found");
    }

    // NOTE: drivers cannot have a payment_methods row (that table's user_id
    // column is FK'd to users, not drivers) so there is no saved-card path
    // for driver subscriptions today — every purchase goes through Paystack's
    // hosted checkout. The subscription itself is created by the webhook
    // once payment succeeds (see webhookController.handleChargeSuccess).
    const amountInCents = Math.round(plan.price * 100);
    const paystackRes = await paystackService.initializeGenericCharge(
      driverResult.rows[0].email,
      amountInCents,
      { driverId, planId, type: "driver_subscription", platform: "flash" },
    );

    return {
      requiresPayment: true,
      authorizationUrl: paystackRes.authorizationUrl,
      message: "Complete payment to activate your plan",
    };
  }

  // Called by webhookController once Paystack confirms a driver_subscription
  // charge succeeded — this is the other half of purchaseDriverPlan() above.
  static async activateDriverPlan(driverId, planId, paystackReference) {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Unknown plan: ${planId}`);

    await this.query(
      `UPDATE driver_subscriptions SET status='expired', updated_at=NOW() WHERE driver_id=$1 AND status='active'`,
      [driverId],
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.days);

    const sub = await this.query(
      `INSERT INTO driver_subscriptions
         (driver_id, plan_type, price, deliveries_limit, deliveries_used, starts_at, expires_at, status, paystack_reference)
       VALUES ($1,$2,$3,$4,0,NOW(),$5,'active',$6) RETURNING *`,
      [driverId, planId, plan.price, plan.deliveries, expiresAt, paystackReference],
    );

    return sub.rows[0];
  }

  static async incrementDeliveryCount(driverId) {
    await this.query(
      `UPDATE driver_subscriptions SET deliveries_used=deliveries_used+1, updated_at=NOW()
       WHERE driver_id=$1 AND status='active' AND expires_at>NOW()`,
      [driverId],
    );
  }

  static async getPremiumStatus(userId) {
    const result = await this.query(
      `SELECT * FROM premium_subscriptions WHERE user_id=$1 AND status='active' AND expires_at>NOW()`,
      [userId],
    );
    return {
      premium: result.rows[0] || null,
      isPremium: result.rows.length > 0,
    };
  }

  static async purchasePremium(userId) {
    const userResult = await this.query("SELECT email FROM users WHERE id=$1", [
      userId,
    ]);
    if (!userResult.rows.length) {
      throw new Error("User not found");
    }

    const paystackRes = await paystackService.initializeGenericCharge(
      userResult.rows[0].email,
      9900, // R99 in cents
      { userId, type: "premium_subscription", platform: "flash" },
    );

    return {
      requiresPayment: true,
      authorizationUrl: paystackRes.authorizationUrl,
      message: "Complete payment to activate Flash Premium",
    };
  }

  // Called by webhookController once Paystack confirms a premium_subscription
  // charge succeeded — this is the other half of purchasePremium() above.
  // premium_subscriptions.user_id is UNIQUE, so renewals must upsert rather
  // than insert a second row -- which means this table alone can't answer
  // "how much has this user paid in total". premium_subscription_payments
  // (v25) is the fix: a separate append-only row per real, confirmed charge,
  // written in the same transaction so the two can never disagree.
  static async activatePremium(userId, paystackReference) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    return await this.transaction(async (client) => {
      // cancelled_at reset to NULL on the UPDATE branch -- a fresh purchase
      // clearly supersedes any earlier cancellation. The INSERT branch needs
      // no explicit value: a brand-new row defaults to NULL already.
      const sub = await client.query(
        `INSERT INTO premium_subscriptions
           (user_id, price, starts_at, expires_at, status, paystack_reference)
         VALUES ($1,99,NOW(),$2,'active',$3)
         ON CONFLICT (user_id) DO UPDATE
         SET price=99, starts_at=NOW(), expires_at=$2, status='active',
             paystack_reference=$3, cancelled_at=NULL, updated_at=NOW()
         RETURNING *`,
        [userId, expiresAt, paystackReference],
      );

      await client.query(
        `INSERT INTO premium_subscription_payments (user_id, amount, paystack_reference)
         VALUES ($1, 99, $2)`,
        [userId, paystackReference],
      );

      return sub.rows[0];
    });
  }

  // Cancellation: stops future renewal intent only -- never touches
  // status/expires_at, so access (and the premium discount / driver
  // delivery eligibility) continues exactly as paid for until the real
  // expiry. WHERE driver_id=$1 scopes this to the authenticated caller's
  // own subscription only; the controller passes req.userId, never a
  // client-supplied id, so there is no parameter through which another
  // driver's subscription could be targeted. AND cancelled_at IS NULL
  // makes a repeat call a no-op instead of a confusing "not found" on the
  // second tap.
  static async cancelDriverPlan(driverId) {
    const result = await this.query(
      `UPDATE driver_subscriptions
       SET cancelled_at = NOW()
       WHERE driver_id = $1 AND status = 'active' AND expires_at > NOW() AND cancelled_at IS NULL
       RETURNING *`,
      [driverId],
    );
    if (!result.rows.length) {
      throw new Error("NO_ACTIVE_SUBSCRIPTION");
    }
    return result.rows[0];
  }

  static async cancelPremium(userId) {
    const result = await this.query(
      `UPDATE premium_subscriptions
       SET cancelled_at = NOW()
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW() AND cancelled_at IS NULL
       RETURNING *`,
      [userId],
    );
    if (!result.rows.length) {
      throw new Error("NO_ACTIVE_SUBSCRIPTION");
    }
    return result.rows[0];
  }

  // Premium purchase via an existing saved card -- the same direct
  // server-side charge pattern paymentController.chargeSavedCard already
  // uses for orders, rather than purchasePremium()'s hosted-checkout
  // redirect. More appropriate here than hosted checkout because, unlike
  // driver subscriptions (which structurally cannot have a saved card --
  // payment_methods.user_id is FK'd to users, not drivers), a premium
  // customer very likely already has one saved from a real order, and
  // forcing them out to a browser for a purchase they could complete with
  // one tap in-app is worse UX with no compensating benefit. No orders
  // row exists for this charge (same as the hosted-checkout path) --
  // Payment.getSavedCardById(cardId, userId) is already ownership-scoped
  // (WHERE id=$1 AND user_id=$2), so a card ID from another account
  // simply resolves to null here, same protection as the order flow gets.
  static async purchasePremiumWithSavedCard(userId, cardId) {
    const Payment = require("./Payment");
    const crypto = require("crypto");

    const card = await Payment.getSavedCardById(cardId, userId);
    if (!card) {
      throw new Error("CARD_NOT_FOUND");
    }

    const userResult = await this.query("SELECT email FROM users WHERE id=$1", [userId]);
    if (!userResult.rows.length) {
      throw new Error("User not found");
    }

    const reference = `flash_premium_sc_${userId}_${crypto.randomBytes(8).toString("hex")}`;

    const paystackRes = await paystackService.chargeAuthorization(
      card.authorization_code,
      userResult.rows[0].email,
      9900, // R99 in cents
      { userId, type: "premium_subscription", platform: "flash", source: "saved_card" },
      reference,
    );

    if (!paystackRes?.status) {
      throw new Error(paystackRes?.message || "Card charge failed");
    }

    if (paystackRes.data?.status !== "success") {
      return {
        success: false,
        status: paystackRes.data?.status || "pending",
        message: paystackRes.data?.gateway_response || "Payment pending",
        reference,
        awaitingWebhook: true,
      };
    }

    return {
      success: true,
      reference,
      message: "Charge accepted. Awaiting webhook confirmation.",
      awaitingWebhook: true,
    };
  }

  static async checkDriverSubscriptionAllowed(driverId) {
    const result = await this.query(
      `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,
      [driverId],
    );
    const sub = result.rows[0];
    if (!sub) {
      return {
        allowed: false,
        reason:
          "No active subscription plan. Purchase a plan to accept deliveries.",
      };
    }
    if (
      sub.deliveries_limit !== null &&
      sub.deliveries_used >= sub.deliveries_limit
    ) {
      return {
        allowed: false,
        reason: `Delivery limit reached for your ${sub.plan_type} plan.`,
      };
    }
    return { allowed: true, subscription: sub };
  }
}

module.exports = Subscription;
