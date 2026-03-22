const BaseModel = require("./BaseModel");
const paystackService = require("../services/paystackService");

const PLANS = {
  daily: { price: 25, days: 1, deliveries: 10, label: "Daily" },
  weekly: { price: 120, days: 7, deliveries: 60, label: "Weekly" },
  monthly: { price: 350, days: 30, deliveries: null, label: "Monthly" },
  quarterly: { price: 900, days: 90, deliveries: null, label: "Quarterly" },
};

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

    const savedCard = await this.query(
      `SELECT paystack_authorization_code FROM saved_cards WHERE user_id=$1 AND is_default=true LIMIT 1`,
      [driverId],
    );

    const amountInCents = Math.round(plan.price * 100);

    let paystackResponse;
    if (
      savedCard.rows.length &&
      savedCard.rows[0].paystack_authorization_code
    ) {
      paystackResponse = await paystackService.chargeAuthorization(
        savedCard.rows[0].paystack_authorization_code,
        driverResult.rows[0].email,
        amountInCents,
        { driverId, planId, type: "driver_subscription", platform: "flash" },
      );

      if (paystackResponse.data?.status !== "success") {
        throw new Error(
          "Card charge failed. Please update your payment method.",
        );
      }
    } else {
      const paystackRes = await paystackService.initializePayment(
        driverResult.rows[0].email,
        amountInCents,
        { driverId, planId, type: "driver_subscription", platform: "flash" },
      );

      return {
        requiresPayment: true,
        authorizationUrl: paystackRes.data.authorization_url,
        message: "Complete payment to activate your plan",
      };
    }

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
      [
        driverId,
        planId,
        plan.price,
        plan.deliveries,
        expiresAt,
        paystackResponse.data.reference,
      ],
    );

    return {
      success: true,
      subscription: sub.rows[0],
      message: `${plan.label} plan activated!`,
    };
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

    const paystackRes = await paystackService.initializePayment(
      userResult.rows[0].email,
      9900, // R99 in cents
      { userId, type: "premium_subscription", platform: "flash" },
    );

    return {
      requiresPayment: true,
      authorizationUrl: paystackRes.data.authorization_url,
      message: "Complete payment to activate Flash Premium",
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
