'use strict';

/**
 * commissionService.js
 *
 * Phase 2b — resolving Flash's commission rate and computing what a store
 * earns on a completed order. No money moves here; 2c does that. What this
 * produces is the auditable number 2c will later pay against.
 *
 * Implements FINANCIAL_DOMAIN_SPECIFICATION.md §2. The rate is business
 * configuration held in the `commission_rates` table, never a constant in
 * code — so changing it is an INSERT, not a deploy.
 */

// Precedence, most specific first. §2.2 defines three tiers; only 'global'
// exists in the data today, but the ORDER BY below is written so adding a
// store override or a promotional window is a data change, not a code change.
const SCOPE_PRECEDENCE = { promotional: 1, store: 2, global: 3 };

/**
 * Resolve the commission rate in effect RIGHT NOW for a store.
 *
 * "Right now" is the whole point. Called inside the completion transaction,
 * so NOW() is completion time — which is the rate that gets frozen onto the
 * order. An order placed under 10% and completed after a 5% promotional
 * window opens earns 5%, and a rate changed afterwards never alters it.
 *
 * The date predicates are what make that real. A naive `WHERE is_active =
 * true` would return whichever row is flagged active regardless of its
 * window, silently applying a promotional rate before it starts or after it
 * ends.
 *
 * @param {pg.PoolClient|pg.Pool} runner  transaction client, so the rate is
 *   read inside the same transaction that stamps it
 * @param {string|null} storeId  accepted and currently unused beyond the
 *   store-scoped tiers below. Present now so adding per-store overrides
 *   later does not change this function's signature or any caller.
 * @returns {Promise<{id: string, rate: number}|null>} null when no rate is
 *   configured — the caller must treat that as "do not stamp", never as zero.
 */
async function resolveCommissionRate(runner, storeId = null) {
  const result = await runner.query(
    `SELECT id, rate, scope_type
       FROM commission_rates
      WHERE is_active = true
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at   IS NULL OR ends_at   >= NOW())
        AND (
              scope_type = 'global'
              OR (scope_type IN ('store', 'promotional') AND store_id = $1)
            )
      ORDER BY CASE scope_type
                 WHEN 'promotional' THEN 1
                 WHEN 'store'       THEN 2
                 ELSE 3
               END,
               created_at DESC
      LIMIT 1`,
    [storeId],
  );

  if (!result.rows.length) return null;

  const row = result.rows[0];
  return { id: row.id, rate: parseFloat(row.rate), scopeType: row.scope_type };
}

/**
 * Commission on an item subtotal, rounded to cents.
 *
 * Rounded the same way computeCancellationSplit already rounds money
 * (Math.round(x * 100) / 100) rather than relying on the NUMERIC(10,2)
 * column to truncate, so the value JavaScript holds and the value Postgres
 * stores are the same number. A half-cent difference between them is the
 * kind of thing that turns into an unreconcilable settlement total.
 */
function computeCommissionAmount(subtotal, rate) {
  const value = parseFloat(subtotal) || 0;
  if (value <= 0) return 0;
  return Math.round(value * rate * 100) / 100;
}

/**
 * Resolve + compute in one call, for the completion path.
 *
 * Returns null when no rate is configured, which the caller treats as "leave
 * the columns NULL and log". A missing rate must never block a delivery from
 * completing: the order is real, the goods are delivered, and an unstamped
 * commission is recoverable later where a failed completion is not.
 */
async function computeStoreCommission(runner, { storeId, subtotal }) {
  const resolved = await resolveCommissionRate(runner, storeId);
  if (!resolved) return null;

  return {
    amount: computeCommissionAmount(subtotal, resolved.rate),
    rate: resolved.rate,
    rateId: resolved.id,
    scopeType: resolved.scopeType,
  };
}

module.exports = {
  resolveCommissionRate,
  computeCommissionAmount,
  computeStoreCommission,
  SCOPE_PRECEDENCE,
};
