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
