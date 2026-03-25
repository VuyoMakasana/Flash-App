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
      "SELECT id, total, subtotal, user_id, payment_status FROM orders WHERE id=$1",
      [orderId],
    );

    if (!orderResult.rows.length) throw new Error("Order not found");
    const order = orderResult.rows[0];
    if (order.user_id !== userId) throw new Error("Not your order");
    if (order.payment_status === "paid") throw new Error("Order already paid");

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

  async verifyPayment(reference, io) {
    const paystackRes = await this.request(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    if (!paystackRes.status || paystackRes.data?.status !== "success") {
      throw new Error("Payment not successful");
    }

    const orderId = paystackRes.data?.metadata?.orderId;
    if (!orderId) throw new Error("No order linked to this payment");

    const result = await pool.query(
      `UPDATE orders SET status='paid', payment_status='paid', payment_method='card', updated_at=NOW()
       WHERE id=$1 AND paystack_reference=$2 RETURNING user_id`,
      [orderId, reference],
    );

    if (result.rows.length) {
      await pool.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
         VALUES ($1,$2,$3,'card','paystack',$4,'paid','store')`,
        [
          orderId,
          result.rows[0].user_id,
          paystackRes.data.amount / 100,
          paystackRes.data.id,
        ],
      );

      if (io) {
        io.to(`user:${result.rows[0].user_id}`).emit("payment_confirmed", {
          orderId,
        });
        io.to(`order:${orderId}`).emit("order_update", {
          orderId,
          status: "paid",
        });
        io.to("driver_pool").emit("new_order_available", {
          orderId,
          isCashDelivery: false,
        });
      }
    }

    return { success: true, orderId };
  }

  async chargeAuthorization(authCode, email, amount, metadata) {
    return await this.request("POST", "/transaction/charge_authorization", {
      authorization_code: authCode,
      email,
      amount,
      currency: "ZAR",
      metadata,
    });
  }
}

module.exports = new PaystackService();
