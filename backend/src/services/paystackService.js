const https = require("https");
const crypto = require("crypto");
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
        "[Paystack] PAYSTACK_SECRET_KEY not configured. Payment features will be unavailable.",
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
      req.setTimeout(30000);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Paystack API request timeout"));
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // Production-readiness audit §2.8 — this previously did a plain SELECT
  // (no lock) then, only after a slow external Paystack call, an UPDATE.
  // The mobile app's own request timeout (20s, api.js) is shorter than
  // this service's own outbound Paystack timeout (30s, this.request
  // above) by design margin -- meaning Paystack can genuinely still be
  // in flight when the app gives up and re-enables "Pay", and a retry's
  // SELECT would see the same pre-update state the first attempt saw,
  // independently calling Paystack a second time. Two real, valid
  // Paystack references could exist for one order, with orders.paystack_
  // reference (a single column) silently overwritten by whichever UPDATE
  // landed last -- meaning a real successful charge on the *other*
  // reference could arrive as a webhook that no longer matches anything
  // (`WHERE ... AND paystack_reference = $2`), leaving a genuinely
  // charged customer's order stuck unpaid with no reconciliation path
  // (the reconciliation cron re-verifies whatever reference is *currently*
  // stored, not the one that was actually completed).
  //
  // Fixed with the exact pattern chargeSavedCard already uses correctly:
  // generate our own reference, lock the order row, commit the reference
  // *before* calling Paystack (not after) -- a concurrent second call
  // blocks on the row lock, then sees the just-committed reference and
  // short-circuits instead of ever reaching Paystack. If the external
  // call itself then fails, the reference is reverted (scoped to the
  // exact reference we just set, so a concurrent successful attempt's
  // reference is never clobbered) so a retry can proceed cleanly.
  async initializePayment(orderId, userId) {
    // Resolved before the transaction below touches anything -- a missing
    // APP_URL in production must fail with zero DB side effects, exactly
    // like before this fix, not leave a committed "pending" reference
    // behind that was never actually sent to Paystack.
    let callbackUrl = process.env.APP_URL;
    if (!callbackUrl) {
      if (isProd) {
        throw new Error(
          "[Paystack] APP_URL must be configured in production for payment callbacks",
        );
      }
      callbackUrl = "http://localhost:8081/payment/callback"; // Safe dev fallback
      console.warn(
        "[Paystack] APP_URL not set. Using development default.",
      );
    }

    let reference;
    let order;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const orderResult = await client.query(
        "SELECT id, total, subtotal, user_id, payment_status, paystack_reference, updated_at FROM orders WHERE id=$1 FOR UPDATE",
        [orderId],
      );

      if (!orderResult.rows.length) {
        await client.query("ROLLBACK");
        throw new Error("Order not found");
      }
      order = orderResult.rows[0];
      if (order.user_id !== userId) {
        await client.query("ROLLBACK");
        throw new Error("Not your order");
      }
      if (order.payment_status === "paid") {
        await client.query("ROLLBACK");
        throw new Error("Order already paid");
      }

      // If a payment is already pending with a reference, avoid re-initializing
      // and risking duplicate charge attempts while webhook confirmation is in-flight.
      // Staleness check (2 min, matching paymentReconciliationJob.js's own
      // threshold for consistency): a legitimate Paystack init completes
      // well within that window (this.request's own 30s timeout above), so
      // a reference still sitting 'pending' past it likely means the
      // caller who set it never actually reached Paystack successfully
      // (e.g. its own outbound call failed *after* this row was already
      // committed but *before* a concurrent second caller's short-circuit
      // read it here -- a real, if narrow, gap this fix closes: without
      // this check, that second caller would be handed a reference no
      // webhook will ever arrive for, stuck "awaiting confirmation"
      // forever). Past the threshold, fall through and safely supersede it
      // with a fresh reference instead of trusting a possibly-dead one.
      const referenceAgeMs = order.updated_at ? Date.now() - new Date(order.updated_at).getTime() : Infinity;
      const referenceIsFresh = referenceAgeMs < 2 * 60 * 1000;
      if (order.payment_status === "pending" && order.paystack_reference && referenceIsFresh) {
        await client.query("ROLLBACK");
        return {
          reference: order.paystack_reference,
          amount: order.total,
          awaitingWebhook: true,
          message: "Payment already initiated. Waiting for confirmation.",
        };
      }

      reference = `flash_${orderId}_${crypto.randomBytes(8).toString("hex")}`;
      await client.query(
        "UPDATE orders SET paystack_reference=$1, payment_status='pending', updated_at=NOW() WHERE id=$2",
        [reference, orderId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const userResult = await pool.query("SELECT email FROM users WHERE id=$1", [
      userId,
    ]);
    const email = userResult.rows[0]?.email;
    const amountInCents = Math.round(parseFloat(order.total) * 100);

    try {
      const paystackRes = await this.request("POST", "/transaction/initialize", {
        email,
        amount: amountInCents,
        currency: "ZAR",
        reference,
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

      return {
        authorizationUrl: paystackRes.data.authorization_url,
        reference: paystackRes.data.reference,
        amount: order.total,
      };
    } catch (err) {
      await pool.query(
        "UPDATE orders SET payment_status='pending', paystack_reference=NULL, updated_at=NOW() WHERE id=$1 AND paystack_reference=$2",
        [orderId, reference],
      ).catch((e) => console.error("[Paystack] initializePayment cleanup revert failed:", e.message));
      throw err;
    }
  }

  // Generic (non-order) Paystack charge initialization — used for driver
  // subscriptions and Flash Premium, which have no `orders` row to attach to.
  // Unlike initializePayment(orderId, userId), this never touches the orders
  // table; the caller is responsible for finalizing whatever it represents
  // once payment completes (see webhookController's charge.success handler).
  async initializeGenericCharge(email, amountInCents, metadata = {}, reference) {
    let callbackUrl = process.env.APP_URL;
    if (!callbackUrl) {
      if (isProd) {
        throw new Error(
          "[Paystack] APP_URL must be configured in production for payment callbacks",
        );
      }
      callbackUrl = "http://localhost:8081/payment/callback"; // Safe dev fallback
      console.warn(
        "[Paystack] APP_URL not set. Using development default.",
      );
    }

    const paystackRes = await this.request("POST", "/transaction/initialize", {
      email,
      amount: amountInCents,
      currency: "ZAR",
      reference: reference || `flash_${metadata.type || "charge"}_${Date.now()}`,
      callback_url: `${callbackUrl}/payment/callback`,
      metadata,
    });

    if (!paystackRes.status) {
      throw new Error(paystackRes.message || "Paystack initialization failed");
    }

    return {
      authorizationUrl: paystackRes.data.authorization_url,
      reference: paystackRes.data.reference,
    };
  }

  async verifyPayment(reference, io, callerUserId) {
    let paystackRes = null;
    let orderId = null;
    try {
      // Verify with Paystack directly. Never trust the frontend.
      paystackRes = await this.request(
        "GET",
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );

      if (!paystackRes.status || paystackRes.data?.status !== "success") {
        throw new Error("Payment not successful");
      }

      orderId = paystackRes.data?.metadata?.orderId;
    } catch (err) {
      const fallbackOrder = await pool.query(
        `SELECT id, user_id, payment_status
         FROM orders
         WHERE paystack_reference = $1`,
        [reference],
      );

      if (!fallbackOrder.rows.length) {
        throw err;
      }

      const row = fallbackOrder.rows[0];
      if (row.user_id !== callerUserId) {
        throw new Error("Not your order");
      }

      return {
        success: row.payment_status === "paid",
        orderId: row.id,
        paymentStatus: row.payment_status,
        providerStatus: "fallback",
        awaitingWebhook: row.payment_status !== "paid",
      };
    }

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
      providerStatus: paystackRes?.data?.status || "unknown",
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

  async refundTransaction(transactionId, amountInCents = null, reason = "customer_cancellation") {
    const body = {
      transaction: String(transactionId),
      merchant_note: reason,
      customer_note: "Your refund has been initiated by Flash.",
    };
    if (Number.isFinite(Number(amountInCents)) && Number(amountInCents) > 0) {
      body.amount = Math.round(Number(amountInCents));
    }
    return await this.request("POST", "/refund", body);
  }

  // Polling fallback for refund.processed/refund.failed webhooks — mirrors
  // verifyPayment()'s role for charge.success (webhook-primary, poll as a
  // safety net in case a webhook is missed). refundId is the Paystack refund
  // id returned by refundTransaction() (stored as payment_refunds.refund_reference).
  async fetchRefund(refundId) {
    return await this.request("GET", `/refund/${encodeURIComponent(refundId)}`);
  }

  // FIX 7: Creates a Paystack transfer recipient for a driver — required before any bank transfer can be initiated
  async createTransferRecipient({ name, accountNumber, bankCode, description = "" }) {
    return await this.request("POST", "/transferrecipient", {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "ZAR",
      description,
    });
  }

  // Verify a bank account number against a bank code before saving.
  // Returns account_name from Paystack so the driver can confirm it's correct.
  async verifyBankAccount(accountNumber, bankCode) {
    return await this.request(
      "GET",
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
  }

  // Fetch the list of supported banks (used in onboarding picklist).
  async getBankList() {
    return await this.request("GET", "/bank?country=south_africa&per_page=100");
  }

  // FIX 7: Initiates a real Paystack bank transfer — replaces the simulated payout that wrote "Simulated payout completed" with no actual money movement
  async initiateTransfer({ recipientCode, amountRands, reference, reason = "Flash driver payout" }) {
    const amountKobo = Math.round(parseFloat(amountRands) * 100);
    return await this.request("POST", "/transfer", {
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reason,
      currency: "ZAR",
      reference,
    });
  }

  // Fetch the current status of a transfer by its reference.
  // Used to poll for final status if the transfer webhook hasn't arrived yet.
  async verifyTransfer(reference) {
    return await this.request("GET", `/transfer/verify/${encodeURIComponent(reference)}`);
  }

  // ADDED: Paystack balance check before payout transfers
  // WHY: Paystack transfers pull from the Flash Paystack account balance, not from
  // the customer's payment directly. If the balance is R0 and a driver requests R500,
  // the transfer fails silently with no alert. This check prevents that.
  async getBalance() {
    try {
      return await this.request('GET', '/balance');
    } catch (e) {
      console.warn('[Paystack] Balance check failed:', e.message);
      return null;
    }
  }
}

module.exports = new PaystackService();
