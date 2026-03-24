const https = require("https");
const pool = require("../config/database");

class PaystackService {
  async request(method, path, body = null) {
    if (
      !process.env.PAYSTACK_SECRET_KEY ||
      process.env.PAYSTACK_SECRET_KEY === "sk_test_placeholder"
    ) {
      throw new Error(
        "PAYSTACK_SECRET_KEY is not configured. Set it in backend/.env before using payment endpoints.",
      );
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.paystack.co",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
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

    const paystackRes = await this.request("POST", "/transaction/initialize", {
      email,
      amount: amountInCents,
      currency: "ZAR",
      reference: `flash_${orderId}_${Date.now()}`,
      callback_url: `${process.env.APP_URL || "https://your-app.com"}/payment/callback`,
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
