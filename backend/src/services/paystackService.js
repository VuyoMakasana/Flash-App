const https = require("https");
const pool = require("../config/database");
const { getOptional, isProd } = require("../config/env");

class PaystackService {
  constructor() {
    // Validate Paystack configuration at startup
    const secretKey = getOptional("PAYSTACK_SECRET_KEY", "paystack");
    if (!secretKey && isProd) {
      console.error(
        "[Paystack] CRITICAL: PAYSTACK_SECRET_KEY required in production for payment processing",
      );
    } else if (!secretKey) {
      console.warn(
        "[Paystack] ℹ️  PAYSTACK_SECRET_KEY not configured. Payment features will be unavailable.",
      );
    }
  }

  async request(method, path, body = null) {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    // Check if secret is available and not placeholder
    if (!secretKey || secretKey.startsWith("sk_test_")) {
      if (isProd) {
        throw new Error(
          "[Paystack] CRITICAL: PAYSTACK_SECRET_KEY not configured for production. Payment processing unavailable.",
        );
      }
      // In dev, allow test keys but warn
      if (secretKey?.startsWith("sk_test_")) {
        console.warn(
          "[Paystack] Using test secret key. Payments are simulated.",
        );
      }
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.paystack.co",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${secretKey || "sk_test_placeholder"}`,
          "Content-Type": "application/json",
        },
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Invalid Paystack response"));
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async initializePayment(orderId, userId) {
    const orderResult = await pool.query(
      "SELECT id, total, subtotal, user_id, payment_status, paystack_reference FROM orders WHERE id=$1",
      [orderId],
    );

    if (!orderResult.rows.length) throw new Error("Order not found");
    const order = orderResult.rows[0];
    if (order.user_id !== userId) throw new Error("Not your order");
    if (order.payment_status === "paid") throw new Error("Order already paid");

    // If a payment is already pending with a reference, avoid re-initializing
    // and risking duplicate charge attempts while webhook confirmation is in-flight.
    if (order.payment_status === "pending" && order.paystack_reference) {
      return {
        reference: order.paystack_reference,
        amount: order.total,
        awaitingWebhook: true,
        message: "Payment already initiated. Waiting for confirmation.",
      };
    }

    const userResult = await pool.query("SELECT email FROM users WHERE id=$1", [
      userId,
    ]);
    const email = userResult.rows[0]?.email;
    const amountInCents = Math.round(parseFloat(order.total) * 100);

    // Ensure APP_URL is configured
    let callbackUrl = process.env.APP_URL;
    if (!callbackUrl) {
      if (isProd) {
        throw new Error(
          "[Paystack] APP_URL must be configured in production for payment callbacks",
        );
      }
      callbackUrl = "http://localhost:8081/payment/callback"; // Safe dev fallback
      console.warn(
        "[Paystack] ℹ️  APP_URL not set. Using development default.",
      );
    }

    const paystackRes = await this.request("POST", "/transaction/initialize", {
      email,
      amount: amountInCents,
      currency: "ZAR",
      reference: `flash_${orderId}_${Date.now()}`,
      callback_url: `${callbackUrl}/payment/callback`,
      metadata: {
        orderId,
        userId,
        platform: "flash",
      },
    });

    if (!paystackRes.status) {
      throw new Error(paystackRes.message || "Paystack initialization failed");
    }

    await pool.query(
      "UPDATE orders SET paystack_reference=$1, status=$2, updated_at=NOW() WHERE id=$3",
      [paystackRes.data.reference, "payment_pending", orderId],
    );

    return {
      authorizationUrl: paystackRes.data.authorization_url,
      reference: paystackRes.data.reference,
      accessCode: paystackRes.data.access_code,
      amount: order.total,
    };
  }

  async verifyPayment(reference, io, callerUserId) {
    // Verify with Paystack directly. Never trust the frontend.
    const paystackRes = await this.request(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    if (!paystackRes.status || paystackRes.data?.status !== "success") {
      throw new Error("Payment not successful");
    }

    const orderId = paystackRes.data?.metadata?.orderId;

    if (!orderId) throw new Error("No order linked to this payment");

    // Webhook is the source of truth for finalization. Verify endpoint only
    // checks provider status and current server-side order state.
    const orderCheck = await pool.query(
      `SELECT id, user_id, payment_status, paystack_reference
       FROM orders
       WHERE id = $1`,
      [orderId],
    );

    if (!orderCheck.rows.length) {
      throw new Error("Order not found");
    }

    const order = orderCheck.rows[0];

    // Enforce ownership against the authenticated caller, not untrusted metadata.
    if (order.user_id !== callerUserId) {
      throw new Error("Not your order");
    }

    if (order.paystack_reference !== reference) {
      throw new Error("Payment reference does not match this order");
    }

    return {
      success: order.payment_status === "paid",
      orderId,
      paymentStatus: order.payment_status,
      providerStatus: paystackRes.data.status,
      awaitingWebhook: order.payment_status !== "paid",
    };
  }

  async chargeAuthorization(authCode, email, amount, metadata, reference) {
    const body = {
      authorization_code: authCode,
      email,
      amount,
      currency: "ZAR",
      metadata,
    };
    if (reference) body.reference = reference;
    return await this.request("POST", "/transaction/charge_authorization", body);
  }
}

module.exports = new PaystackService();
