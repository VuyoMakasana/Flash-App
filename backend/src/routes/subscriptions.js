const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const PLANS = {
  daily:     { price: 25,  days: 1,  deliveries: 10,   label: 'Daily' },
  weekly:    { price: 120, days: 7,  deliveries: 60,   label: 'Weekly' },
  monthly:   { price: 350, days: 30, deliveries: null, label: 'Monthly' },
  quarterly: { price: 900, days: 90, deliveries: null, label: 'Quarterly' },
};

// ─── GET DRIVER SUBSCRIPTION ──────────────────────────────────────────────────
router.get('/driver', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [req.userId]
    );
    res.json({ subscription: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── PURCHASE DRIVER PLAN ─────────────────────────────────────────────────────
router.post('/driver/purchase', authenticate, requireRole('driver'), async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const driverResult = await pool.query('SELECT name, email FROM drivers WHERE id=$1', [req.userId]);
    if (!driverResult.rows.length) return res.status(404).json({ error: 'Driver not found' });

    // Check if driver has a saved card from a previous Paystack payment
    const savedCard = await pool.query(
      `SELECT paystack_authorization_code FROM saved_cards WHERE user_id=$1 AND is_default=true LIMIT 1`,
      [req.userId]
    );

    const https = require('https');
    const amountInCents = Math.round(plan.price * 100);

    let paystackBody;
    let paystackPath;

    if (savedCard.rows.length && savedCard.rows[0].paystack_authorization_code) {
      // Charge the saved card directly (no redirect needed)
      paystackPath = '/transaction/charge_authorization';
      paystackBody = {
        authorization_code: savedCard.rows[0].paystack_authorization_code,
        email:              driverResult.rows[0].email,
        amount:             amountInCents,
        currency:           'ZAR',
        metadata:           { driverId: req.userId, planId, type: 'driver_subscription', platform: 'flash' },
      };
    } else {
      // No saved card — return a Paystack link for the driver to complete payment
      paystackPath = '/transaction/initialize';
      paystackBody = {
        email:    driverResult.rows[0].email,
        amount:   amountInCents,
        currency: 'ZAR',
        metadata: { driverId: req.userId, planId, type: 'driver_subscription', platform: 'flash' },
      };
    }

    // Make Paystack request
    const paystackRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.paystack.co', port: 443, path: paystackPath, method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      };
      const req2 = https.request(options, (r) => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.write(JSON.stringify(paystackBody));
      req2.end();
    });

    if (!paystackRes.status) return res.status(400).json({ error: paystackRes.message || 'Payment failed' });

    // If this was an initialize (no saved card), return the URL for the driver to pay
    if (paystackPath === '/transaction/initialize') {
      return res.json({
        requiresPayment: true,
        authorizationUrl: paystackRes.data.authorization_url,
        message: 'Complete payment to activate your plan',
      });
    }

    // Direct charge succeeded — activate the subscription
    if (paystackRes.data?.status !== 'success') {
      return res.status(400).json({ error: 'Card charge failed. Please update your payment method.' });
    }

    await pool.query(
      `UPDATE driver_subscriptions SET status='expired', updated_at=NOW() WHERE driver_id=$1 AND status='active'`,
      [req.userId]
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.days);

    const sub = await pool.query(
      `INSERT INTO driver_subscriptions
         (driver_id, plan_type, price, deliveries_limit, deliveries_used, starts_at, expires_at, status, paystack_reference)
       VALUES ($1,$2,$3,$4,0,NOW(),$5,'active',$6) RETURNING *`,
      [req.userId, planId, plan.price, plan.deliveries, expiresAt, paystackRes.data.reference]
    );

    res.json({ success: true, subscription: sub.rows[0], message: `${plan.label} plan activated!` });
  } catch (err) {
    console.error('Subscription purchase error:', err);
    res.status(500).json({ error: 'Failed to purchase subscription' });
  }
});

// ─── INCREMENT DELIVERY COUNT ─────────────────────────────────────────────────
router.post('/driver/increment', authenticate, requireRole('driver'), async (req, res) => {
  try {
    await pool.query(`UPDATE driver_subscriptions SET deliveries_used=deliveries_used+1, updated_at=NOW() WHERE driver_id=$1 AND status='active' AND expires_at>NOW()`, [req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to increment' });
  }
});

// ─── CHECK SUBSCRIPTION MIDDLEWARE ───────────────────────────────────────────
const checkDriverSubscription = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,
      [req.userId]
    );
    const sub = result.rows[0];
    if (!sub) return res.status(403).json({ error: 'No active plan', message: 'Purchase a plan to accept deliveries.', requiresSubscription: true });
    if (sub.deliveries_limit !== null && sub.deliveries_used >= sub.deliveries_limit) {
      return res.status(403).json({ error: 'Delivery limit reached', message: `You've reached your ${sub.plan_type} plan limit.`, requiresUpgrade: true });
    }
    req.driverSubscription = sub;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Failed to check subscription' });
  }
};

// Standalone version for calling from other routes (not as middleware)
async function checkDriverSubscriptionAllowed(driverId) {
  const result = await pool.query(
    `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,
    [driverId]
  );
  const sub = result.rows[0];
  if (!sub) return { allowed: false, reason: 'No active subscription plan. Purchase a plan to accept deliveries.' };
  if (sub.deliveries_limit !== null && sub.deliveries_used >= sub.deliveries_limit) {
    return { allowed: false, reason: `Delivery limit reached for your ${sub.plan_type} plan.` };
  }
  return { allowed: true, subscription: sub };
}

// ─── GET PREMIUM STATUS (user) ────────────────────────────────────────────────
router.get('/premium', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM premium_subscriptions WHERE user_id=$1 AND status='active' AND expires_at>NOW()`,
      [req.userId]
    );
    res.json({ premium: result.rows[0] || null, isPremium: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch premium status' });
  }
});

// ─── PURCHASE PREMIUM (R99/month) ─────────────────────────────────────────────
router.post('/premium/purchase', authenticate, requireRole('user'), async (req, res) => {
  try {
    const userResult = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

    // Initialize a Paystack payment for Flash Premium (R99/month)
    const https = require('https');
    const paystackRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        email:    userResult.rows[0].email,
        amount:   9900, // R99 in cents
        currency: 'ZAR',
        metadata: { userId: req.userId, type: 'premium_subscription', platform: 'flash' },
      });
      const options = {
        hostname: 'api.paystack.co', port: 443, path: '/transaction/initialize', method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      };
      const req2 = https.request(options, (r) => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (!paystackRes.status) return res.status(400).json({ error: 'Could not initialize payment' });

    // Return authorization URL — frontend opens this for user to pay
    // Premium is activated by the webhook (charge.success) automatically
    res.json({
      requiresPayment:  true,
      authorizationUrl: paystackRes.data.authorization_url,
      message:          'Complete payment to activate Flash Premium',
    });
  } catch (err) {
    console.error('Premium purchase error:', err);
    res.status(500).json({ error: 'Failed to activate premium' });
  }
});

module.exports = router;
module.exports.checkDriverSubscription = checkDriverSubscription;
module.exports.checkDriverSubscriptionAllowed = checkDriverSubscriptionAllowed;
