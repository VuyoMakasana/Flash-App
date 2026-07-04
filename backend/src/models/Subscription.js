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
  // than insert a second row.
  static async activatePremium(userId, paystackReference) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const sub = await this.query(
      `INSERT INTO premium_subscriptions
         (user_id, price, starts_at, expires_at, status, paystack_reference)
       VALUES ($1,99,NOW(),$2,'active',$3)
       ON CONFLICT (user_id) DO UPDATE
       SET price=99, starts_at=NOW(), expires_at=$2, status='active',
           paystack_reference=$3, updated_at=NOW()
       RETURNING *`,
      [userId, expiresAt, paystackReference],
    );

    return sub.rows[0];
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
