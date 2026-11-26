'use strict';

// L0.5b (#98): kill switches. The founder can stop one flow (card payments,
// new orders, cash, payouts, store settings, sign-ups, Premium, Boosts) from
// the admin panel within seconds, without a redeploy, while customers see a
// calm, fixed message. Approved design: docs/KILL_SWITCHES.md.
//
// Values live in public.feature_switches (v44). isEnabled(key):
//   - 15 s in-memory cache, so a change applies within 15 s with no restart
//     and requests don't hit the database every time;
//   - if a read fails, the last known values are kept (and retried 15 s later);
//   - on a cold start with no value, money-moving switches fail CLOSED
//     (driver_payouts, premium, boosts) and the rest fail OPEN;
//   - an environment value of "off" (FEATURE_<KEY>=off, e.g.
//     FEATURE_CARD_PAYMENTS=off) always wins. That one needs a restart, so it's
//     the emergency backstop if the database or the panel is unavailable.
//
// NEVER guarded by a switch: webhooks, payment verification, reconciliation,
// refunds, cash OTP, cancellations and store order handling (accept, reject,
// mark ready). Blocking those would strand money or trigger auto-cancels.
// tests/unit/featureSwitchGuards.test.js proves it with every switch off.

const KEYS = Object.freeze([
  'card_payments', 'new_orders', 'cash_orders', 'driver_payouts',
  'store_portal_writes', 'signups', 'premium', 'boosts',
]);

const FAIL_CLOSED = new Set(['driver_payouts', 'premium', 'boosts']);

const CACHE_MS = 15 * 1000;

// The founder approved these exact messages (2026-11-21). They're fixed in
// code; the admin panel only flips switches.
const MESSAGES = Object.freeze({
  card_payments: 'Card payments are paused for a few minutes. Nothing has been charged, and your cart is saved. Please try again shortly.',
  new_orders: "Flash isn't taking new orders right now. Your cart is saved. Please try again a little later.",
  cash_orders: "Cash isn't available right now. Please pay the delivery fee by card.",
  driver_payouts: 'Payouts are paused for now. Your earnings are safe and will be paid when payouts resume.',
  store_portal_writes: 'Store settings are read-only for a few minutes while we do maintenance. Orders still work as normal.',
  signups: 'New sign-ups are paused right now. Please try again later.',
  premium: "This feature isn't available yet.",
  boosts: "This feature isn't available yet.",
});

const REASON_MAX = 500;

function assertKey(key) {
  if (!KEYS.includes(key)) throw new Error(`Unknown feature switch: ${key}`);
}

function envVarName(key) {
  return `FEATURE_${key.toUpperCase()}`;
}

function createFeatureSwitches({
  query = (sql, params) => require('../config/database').query(sql, params),
  connect = () => require('../config/database').connect(),
  now = () => Date.now(),
  env = process.env,
  log = console,
} = {}) {
  let values = null;      // Map key -> boolean, from the last successful read
  let checkedAt = -Infinity;
  let inflight = null;

  function envOverrideOff(key) {
    return String(env[envVarName(key)] ?? '').trim().toLowerCase() === 'off';
  }

  async function refresh() {
    try {
      const result = await query('SELECT key, enabled FROM feature_switches');
      const next = new Map();
      for (const row of result.rows) {
        if (KEYS.includes(row.key)) next.set(row.key, row.enabled === true);
      }
      values = next;
    } catch (err) {
      // Keep the last known values; try again after CACHE_MS.
      log.warn(`[FeatureSwitch] read failed, keeping ${values ? 'last known values' : 'cold-start defaults'}: ${err.message}`);
    } finally {
      checkedAt = now();
    }
  }

  async function ensureFresh() {
    if (now() - checkedAt < CACHE_MS) return;
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    await inflight;
  }

  async function isEnabled(key) {
    assertKey(key);
    if (envOverrideOff(key)) return false;
    await ensureFresh();
    if (values && values.has(key)) return values.get(key);
    return !FAIL_CLOSED.has(key);
  }

  async function getStatus() {
    const out = {};
    for (const key of KEYS) {
      out[key] = { enabled: await isEnabled(key), message: MESSAGES[key] };
    }
    return out;
  }

  // Admin change, from the "Switch off" / "Switch on" actions. One
  // transaction: the switch row and its admin_actions audit row commit
  // together. The cache is dropped so this server applies it immediately
  // (other servers within CACHE_MS).
  async function setSwitch(key, enabled, adminId, reason) {
    assertKey(key);
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    const why = String(reason ?? '').trim();
    if (!why) throw new Error('A reason is required.');
    if (why.length > REASON_MAX) throw new Error(`The reason can be at most ${REASON_MAX} characters.`);
    if (!adminId) throw new Error('An admin is required.');

    const client = await connect();
    let previous;
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT enabled FROM feature_switches WHERE key = $1 FOR UPDATE',
        [key],
      );
      if (!current.rows.length) throw new Error(`Feature switch ${key} is missing from the database.`);
      previous = current.rows[0].enabled === true;
      if (previous === enabled) {
        await client.query('ROLLBACK');
        return { changed: false, key, previous, enabled };
      }
      await client.query(
        'UPDATE feature_switches SET enabled = $2, updated_at = NOW(), updated_by = $3 WHERE key = $1',
        [key, enabled, adminId],
      );
      await client.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_table, target_id, metadata)
         VALUES ($1, 'feature_switch_changed', 'feature_switches', NULL, $2)`,
        [adminId, JSON.stringify({ key, old_value: previous, new_value: enabled, reason: why })],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    checkedAt = -Infinity;
    // The reason stays in admin_actions only: it's free text.
    log.log(`[FeatureSwitch] ${key} switched ${enabled ? 'ON' : 'OFF'} (was ${previous ? 'on' : 'off'}) by admin ${adminId}`);
    return { changed: true, key, previous, enabled };
  }

  return { isEnabled, getStatus, setSwitch, envOverrideOff };
}

const featureSwitches = createFeatureSwitches();

module.exports = {
  featureSwitches,
  createFeatureSwitches,
  KEYS,
  FAIL_CLOSED,
  MESSAGES,
  CACHE_MS,
  envVarName,
};
