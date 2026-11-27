'use strict';

// Step 1 (#102), audit P0-5: the customer's delivery code must never reach
// the driver (or anyone else) inside an order object.
//
// Many queries return whole orders rows (SELECT o.*, RETURNING *), and those
// rows carry cash_otp_plain (the code itself, kept so the customer can see
// it again) and cash_otp_hash. Rather than trusting every query and every
// res.json to leave them out, every JSON response passes through
// stripOrderSecrets (middleware/stripOrderSecrets.js, mounted for the whole
// API). The customer reads their code only from GET
// /api/payments/cash/otp/:orderId, which returns it as `otp`, never under
// these keys.

const ORDER_SECRET_FIELDS = new Set(['cash_otp_plain', 'cash_otp_hash']);
const MAX_DEPTH = 10;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Returns a copy without the secret fields at any depth; returns the very
// same value when there was nothing to remove. Never mutates its input.
function stripOrderSecrets(value, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const stripped = stripOrderSecrets(item, depth + 1);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? out : value;
  }
  if (!isPlainObject(value)) return value;

  let out = null;
  for (const key of Object.keys(value)) {
    if (ORDER_SECRET_FIELDS.has(key)) {
      if (!out) out = { ...value };
      delete out[key];
      continue;
    }
    const child = value[key];
    const stripped = stripOrderSecrets(child, depth + 1);
    if (stripped !== child) {
      if (!out) out = { ...value };
      out[key] = stripped;
    }
  }
  return out || value;
}

module.exports = { stripOrderSecrets, ORDER_SECRET_FIELDS };
