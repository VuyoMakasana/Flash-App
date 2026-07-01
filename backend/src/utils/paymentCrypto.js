'use strict';

/**
 * paymentCrypto.js
 *
 * HIGH-8 FIX: PAYMENT_METHOD_ENCRYPTION_KEY is now required independently of
 *   JWT_SECRET. The old fallback to JWT_SECRET has been removed.
 *
 *   Why this matters: if JWT_SECRET is rotated (e.g. after a token compromise),
 *   the encryption key must NOT change — that would make every stored card
 *   authorization code unreadable. Keeping them as separate secrets ensures
 *   credential rotation in one domain doesn't break another.
 *
 * Generate a unique key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

function getKey() {
  const source = process.env.PAYMENT_METHOD_ENCRYPTION_KEY;

  if (!source) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'PAYMENT_METHOD_ENCRYPTION_KEY environment variable is required in production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    // Non-production only — use a stable dev fallback so cards survive server restarts
    // in development. NEVER deploy this value to production.
    console.warn(
      '[paymentCrypto] PAYMENT_METHOD_ENCRYPTION_KEY not set — using insecure dev fallback. ' +
      'Set this variable before going to production.',
    );
    return crypto.createHash('sha256').update('flash-dev-payment-key-DO-NOT-USE-IN-PROD').digest();
  }

  return crypto.createHash('sha256').update(String(source)).digest();
}

function encrypt(plainText) {
  if (!plainText) return null;
  const iv      = crypto.randomBytes(12);
  const key     = getKey();
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(encryptedValue) {
  if (!encryptedValue) return null;
  const payload    = Buffer.from(String(encryptedValue), 'base64');
  const iv         = payload.subarray(0, 12);
  const tag        = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const key        = getKey();
  const decipher   = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

module.exports = { encrypt, decrypt };
