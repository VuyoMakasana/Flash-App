const crypto = require("crypto");
const db = require("../config/database");

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// H13 FIX: previously fell back to JWT_SECRET (coupling two independent
// security domains — rotating JWT_SECRET after a compromise would silently
// change cash-OTP verification too) or, worse, a hardcoded string literal
// visible to anyone who reads this file, which would let them forge valid
// cash-collection OTPs. Mirrors paymentCrypto.js's PAYMENT_METHOD_ENCRYPTION_KEY
// pattern: required independently in production, dev-only fallback with a
// loud warning.
function otpSecret() {
  const secret = process.env.CASH_OTP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "CASH_OTP_SECRET environment variable is required in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    console.warn(
      "[cashOtpService] CASH_OTP_SECRET not set — using insecure dev fallback. " +
      "Set this variable before going to production.",
    );
    return "flash-cash-otp-dev-only-fallback";
  }
  return secret;
}

function createOtpCode() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = (10 ** OTP_LENGTH) - 1;
  return String(crypto.randomInt(min, max + 1));
}

function hashOtp(orderId, otp) {
  return crypto
    .createHmac("sha256", otpSecret())
    .update(`${orderId}:${otp}`)
    .digest("hex");
}

async function generateOtp(orderId) {
  const otp = createOtpCode();
  const otpHash = hashOtp(orderId, otp);

  const result = await db.query(
    `UPDATE orders
     SET cash_otp_hash = $2,
         cash_otp_expires_at = NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes',
         cash_otp_sent_at = NOW(),
         cash_otp_verified_at = NULL,
         cash_otp_attempts = 0,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, user_id, status, payment_method, payment_status, driver_id, cash_otp_expires_at`,
    [orderId, otpHash],
  );

  if (!result.rows.length) {
    throw new Error("Order not found");
  }

  return {
    otp,
    order: result.rows[0],
  };
}

async function verifyOtp(orderId, otp) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, cash_otp_hash, cash_otp_expires_at, cash_otp_attempts
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId],
    );

    if (!result.rows.length) {
      throw new Error("Order not found");
    }

    const row = result.rows[0];
    if (!row.cash_otp_hash || !row.cash_otp_expires_at) {
      throw new Error("Cash OTP not generated");
    }

    if (row.cash_otp_attempts >= MAX_ATTEMPTS) {
      throw new Error("OTP attempts exceeded");
    }

    if (new Date(row.cash_otp_expires_at).getTime() < Date.now()) {
      throw new Error("OTP expired");
    }

    const candidateHash = hashOtp(orderId, otp);
    const valid = crypto.timingSafeEqual(
      Buffer.from(row.cash_otp_hash, "hex"),
      Buffer.from(candidateHash, "hex"),
    );

    if (!valid) {
      await client.query(
        `UPDATE orders
         SET cash_otp_attempts = COALESCE(cash_otp_attempts, 0) + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );
      throw new Error("Invalid OTP");
    }

    await client.query(
      `UPDATE orders
       SET cash_otp_verified_at = NOW(),
           cash_otp_hash = NULL,
           cash_otp_expires_at = NULL,
           cash_otp_attempts = 0,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId],
    );

    await client.query("COMMIT");
    return { valid: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  generateOtp,
  verifyOtp,
};
