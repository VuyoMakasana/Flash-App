const pool = require("../config/database");

async function checkDriverSubscriptionAllowed(driverId) {
  const result = await pool.query(
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

module.exports = { checkDriverSubscriptionAllowed };
