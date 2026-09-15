'use strict';

// Admin panel — chronological ordering and date/time search, everywhere,
// permanently (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md). The real
// requirement this file exists to satisfy: every admin-panel resource,
// today's nine and every one added in a future phase, must default to
// showing records most-recent-first, and this must be a durable, enforced
// pattern — not something hand-applied per resource and forgotten the next
// time a resource gets added.
//
// AdminJS's own real, documented mechanism for a default sort is a
// `sort: { sortBy, direction }` key inside a resource's `options` (confirmed
// by reading sort-setter.js directly, not assumed) — read via
// `resourceOptions.sort` and used as the initial sort before any user
// interaction; it falls back to the first sortable listProperty only if
// `options.sort` is absent. This helper does nothing more than set that key
// correctly and consistently, merged on top of whatever options a resource
// already has — it never overwrites listProperties/properties/actions.
//
// RESOURCE_TIMESTAMP_COLUMNS documents, per table, exactly which column
// answers "when did this actually happen" — most are created_at, but not
// all: driver_wallets is a one-row-per-driver live snapshot, not an event
// log, so updated_at (the last time its balance actually changed) is the
// meaningful column there, not created_at (the row's arbitrary first-insert
// time, most likely just whenever that driver's first delivery completed).
// sos_alerts has no separate triggered_at column — created_at IS the
// trigger time (set once, at insert, by SosAlert.create) — confirmed
// directly against the real schema, not assumed from the column name alone.
const RESOURCE_TIMESTAMP_COLUMNS = {
  drivers: 'created_at',
  orders: 'created_at',
  order_cancellations: 'created_at',
  return_requests: 'created_at',
  sos_alerts: 'created_at',
  driver_wallets: 'updated_at',
  driver_wallet_ledger: 'created_at',
  driver_payout_requests: 'created_at',
  payout_transactions: 'created_at',
  driver_ratings: 'created_at',
  payments: 'created_at',
  payment_refunds: 'created_at',
  // flagged_accounts is a periodically-synced snapshot (server.js's cron
  // job), not an event log -- synced_at (when this row was last refreshed
  // against the real users columns) is the meaningful "when" here, same
  // reasoning as driver_wallets.updated_at above.
  flagged_accounts: 'synced_at',
  flash_inventory: 'created_at',
  marketing_waitlist: 'created_at',
  marketing_contact_messages: 'created_at',
  marketing_applications: 'created_at',
  chat_reports: 'created_at',
  user_blocks: 'created_at',
  // §2.13 audit (full admin visibility) — driver_commission_debts,
  // driver_penalties, and admin_actions are all real append-only event
  // logs (one row per debt/penalty/admin action), same shape as
  // driver_wallet_ledger above — created_at is the real "when did this
  // happen" column.
  driver_commission_debts: 'created_at',
  driver_penalties: 'created_at',
  admin_actions: 'created_at',
  // driver_subscriptions/premium_subscriptions renew via UPSERT on the
  // same row (confirmed directly — Admin.getFinancials()'s own comment:
  // "premium_subscriptions itself can't be [summed for revenue] since
  // renewals upsert the same row"), so updated_at (the last real change —
  // a renewal or a cancellation) is the meaningful column, not
  // created_at (this row's one-time original insert) — same reasoning as
  // driver_wallets above.
  driver_subscriptions: 'updated_at',
  premium_subscriptions: 'updated_at',
  // Admin Platform Phase 3 — real onboarding events (one row per store,
  // created once at manual-onboarding time) — created_at is the meaningful
  // "when" column, same shape as drivers/admin_actions above.
  stores: 'created_at',
};

// Applied via the same options object every resource already builds, not a
// side channel — a resource registered without calling this simply has no
// `sort` key, no default order, and (per adminChronologicalSort.test.js)
// fails CI, the same enforcement shape adminCoverage.js already uses for
// table-visibility decisions.
function withChronologicalDefaults(options, sortByColumn) {
  if (!sortByColumn) {
    throw new Error('withChronologicalDefaults: sortByColumn is required — add the table to RESOURCE_TIMESTAMP_COLUMNS first.');
  }
  return {
    ...options,
    sort: { sortBy: sortByColumn, direction: 'desc' },
  };
}

module.exports = { withChronologicalDefaults, RESOURCE_TIMESTAMP_COLUMNS };
