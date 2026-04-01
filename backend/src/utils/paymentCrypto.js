const crypto = require("crypto");

function getKey() {
  const source = process.env.PAYMENT_METHOD_ENCRYPTION_KEY || process.env.JWT_SECRET || "flash-dev-fallback-key";
  return crypto.createHash("sha256").update(String(source)).digest();
}

function encrypt(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(encryptedValue) {
  if (!encryptedValue) return null;
  const payload = Buffer.from(String(encryptedValue), "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const key = getKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

module.exports = { encrypt, decrypt };
