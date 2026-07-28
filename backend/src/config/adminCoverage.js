// Admin panel table-coverage registry — Phase 0
// (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md, Addendum 1 §4.2, Addendum 3 §5).
//
// The whole point of this file: every real table in the database must have
// an entry in exactly one of the two buckets below. A real integration test
// (backend/tests/integration/adminCoverage.test.js — an integration test, not
// a unit test, since it needs the live schema via information_schema.tables,
// not the mocked pg Pool unit tests use) fails the build if any real table
// exists in neither — so a future migration that adds a table without
// anyone deciding what happens to it admin-visibility-wise gets caught
// immediately, not discovered by accident months later the way several of
// the entries below were found tonight.
//
// `covered` does NOT mean "has a finished admin UI today" — most of Phase
// 1-4 hasn't been built yet. It means a real, specific decision has been
// made about this table: either it already has a real admin-visible query
// (cite it), or it's explicitly scheduled in a named phase of the plan.
// `intentionallyExcluded` means the opposite kind of real decision: this
// table genuinely has no admin-visibility need, ever, and the one-line
// reason says why — so an exclusion can never be a silent rubber stamp.
//
// Populated once, by hand, against every table that existed as of this
// commit (49 — the 47 counted in Addendum 3 §5, plus admins/admin_actions
// themselves, added by this same migration). Four turned out to be dead —
// referenced by no controller or model anywhere in the backend — found only
// by doing this enumeration carefully, not assumed: store_credits and
// driver_payouts (already flagged in Addendum 1 §4.4), and saved_cards +
// order_stops (found new, during this exact pass — see their entries below).
//
// A SECOND, related requirement lives right next to this one, same spirit:
// once a table here is actually registered as a real AdminJS resource (in
// buildResources(), backend/src/adminPanel.js), it must also go through
// withChronologicalDefaults() (backend/src/config/adminResourceDefaults.js)
// with the real, correct timestamp column for that table added to
// RESOURCE_TIMESTAMP_COLUMNS there — a resource that skips this fails
// backend/tests/unit/adminChronologicalSort.test.js the same way an
// undecided table fails the check below. Every future phase's resources
// (Phase 3's remaining items, Phase 4 in full) must go through both checks,
// not just this one — a table decision alone isn't the whole requirement
// once that table becomes a real, browsable admin resource.

module.exports = {
  covered: {
    // ── Already real today ──────────────────────────────────────────────
    return_requests:                'Returns queue (admin.js) — approve/reject/finalize-refund, real endpoints.',
    return_request_items:           'Line-item detail behind the returns queue (Return.getPendingForAdmin joins this).',
    order_cancellations:            'Pre-pickup cancellations view (admin.js) — real store/driver/customer split.',
    order_cancellation_store_shares:'Joined into the cancellations view (Admin.getCancellations).',
    drivers:                        'Phase 1 — GET/PUT /api/admin/drivers* already real backend, UI not yet built.',
    orders:                         'Phase 1 — GET /api/admin/orders already real backend (last 100, no filters yet), UI not yet built.',
    order_items:                    'Phase 1 — line items shown as part of the order-detail view.',
    order_stops:                    'Phase 1, alongside the stores-table work (Addendum 2 §1) — DEAD TABLE, found during this pass: created by migration v9 for multi-store pickup stops, referenced by no controller or model anywhere. Needs the same retire-or-document decision as store_credits/driver_payouts before any order-detail view is built on top of it.',
    users:                          'Phase 1 (count, already real via getStats) + Phase 3 (flagged_for_cash_abuse/cash_refusal_count now surfaced via the synced flagged_accounts table, below) + Phase 4 (full individual lookup — profile, orders, addresses).',
    addresses:                      'Phase 4 — part of the individual user-lookup screen (saved address book).',
    flash_inventory:                'Phase 4 — real admin CRUD already exists (inventoryRoutes.js), UI not yet built.',

    // ── Phase 0 — this table and its own audit trail ─────────────────────
    admins:        'Phase 0 — the account itself. A "manage other admins" screen is a natural Phase 4 addition once there\'s a real second admin (Addendum 3 §4\'s role decision).',
    admin_actions: 'Phase 0 — the audit log itself. AdminAction.getRecent() already exists to read it back; a real UI view showing it is a natural near-term addition.',

    // ── Phase 2 — financial and dispute visibility ──────────────────────
    payments:                'Phase 2 — real, browsable AdminJS resource (critical-flow/edge-case audit §2.7), per-transaction, not just dashboard totals.',
    payment_refunds:         'Phase 2 — real, browsable AdminJS resource (critical-flow/edge-case audit §2.7), per-refund, not just the aggregate reconciliation-check target (Addendum 1 §4.4).',
    driver_commission_debts: 'Phase 2 — cash-order commission revenue line (Addendum 1 §4.3).',
    driver_wallet_ledger:    'Phase 2 — real AdminJS resource + inline summary on a driver\'s own page, now built and verified live.',
    driver_wallets:          'Phase 2 — real AdminJS resource + inline summary on a driver\'s own page, now built and verified live.',
    driver_penalties:        'Phase 2 — cost-offset line (nets against payouts, per Addendum 1 §4.3).',
    driver_payout_requests:  'Phase 2 — real AdminJS resource, now built and verified live.',
    payout_transactions:     'Phase 2 — real AdminJS resource, real Paystack transfer trail, now built and verified live.',
    driver_subscriptions:    'Phase 2 — subscription status/history (added in Addendum 3 §1, fixing the inconsistency where the revenue was counted without the record).',
    premium_subscriptions:   'Phase 2 — same fix as driver_subscriptions, Addendum 3 §1.',
    driver_documents:        'Phase 2/1 — document review via signed URLs; Admin.getDriverById already does this correctly, no UI yet.',
    messages:                'Phase 2 — order chat now shown inline on the order-detail screen alongside pickup/dropoff photos, now built and verified live.',

    // ── Phase 3 — trust and safety ───────────────────────────────────────
    sos_alerts:       'Phase 3 — real AdminJS resource + SosAlert.getAll/acknowledge + an immediate SOS email (Addendum 2 §4) now built and verified live.',
    driver_ratings:   'Phase 3 — real AdminJS resource + a driver-rating-trend dashboard chart, now built and verified live.',
    flagged_accounts: 'Phase 3 — new table (migrate.js v20), a periodically-synced snapshot of users.flagged_for_cash_abuse/cash_refusal_count kept current by a real cron job (server.js) since users itself can\'t be a resource — real AdminJS resource now built and verified live.',

    // ── Phase 4 — rounding out ───────────────────────────────────────────
    app_ratings:          'Phase 4 (Addendum 3 §1 — was orphaned, now placed alongside content moderation).',
    size_profiles:        'Phase 4 (Addendum 3 §1) — data-quality/usage visibility, explicitly low priority.',
    brand_size_mappings:  'Phase 4 — same as size_profiles.',
    feed_posts:           'Phase 4 — content moderation (Addendum 3 §1): list-all-active-posts + admin-callable delete, reusing Feed.deletePost\'s existing soft-delete pattern.',
    feed_comments:        'Phase 4 — same content-moderation screen as feed_posts.',
    store_boosts:         'Phase 4 — founder\'s decision (final completion pass, §4): build the real effect. purchaseBoost now requires a real product_id, charges through Paystack (paystackService.initializeGenericCharge, activated by webhookController.handleBoostCharge on charge.success — no row exists until payment is confirmed), and an active boost genuinely ranks its product first in Inventory.getProducts(). Product-scoped rather than store-scoped because this codebase has no stores table (store_id is a free-text tag, always "flash_closet") — a store-level boost has nothing to rank above and could never produce an observable effect.',
    store_promotions:     'Phase 4 — founder\'s decision (final completion pass, §4): build the real effect. createPromotion never had a price/plan to charge for (a free discount config, not a purchase) — its discount_percent now actually reduces the price of flash_inventory items in Order.create() while a promotion is active.',
    browsing_events:      'Phase 4 — backs the Flash Fleet demand-cluster view (fleetIntelligenceService.js), zero new backend needed.',
  },

  intentionallyExcluded: {
    // ── Internal auth/infra plumbing — no business content to view ──────
    refresh_tokens:  'Internal auth-flow infrastructure (refresh token storage) — no business-visibility need.',
    revoked_tokens:  'Internal auth-flow infrastructure (JWT revocation list) — no business-visibility need.',
    email_tokens:    'Internal auth-flow infrastructure (email verification/reset tokens) — no business-visibility need.',
    webhook_events:  'Internal Paystack webhook-idempotency ledger (unique constraint on paystack_event_id) — infrastructure only, no content to view.',

    // ── Dead/legacy tables that need no view because nothing writes to them ──
    saved_cards: 'DEAD TABLE, found new during this pass — superseded by payment_methods (migrate.js\'s own one-time data migration copies rows FROM saved_cards INTO payment_methods). No controller or model reads or writes saved_cards anymore.',
    store_credits: 'CONFIRMED DEAD TABLE (Addendum 1 §4.4, re-confirmed at the final completion pass by searching the entire backend source) — moved here from `covered`, where it had been sitting despite being dead. No INSERT/UPDATE anywhere; the one real read path (Return.getCredits, GET /api/returns/credits) can only ever return empty since nothing creates a balance > 0 row. Superseded by the current real-refund return model. Kept, not dropped, per this project\'s own rule — see migrate.js\'s own comment on the table definition. Must never be read from for a real admin number (e.g. "outstanding store credit liability" would always silently report zero).',
    driver_payouts: 'CONFIRMED DEAD TABLE (Addendum 1 §4.4, re-confirmed at the final completion pass) — moved here from `covered` for the same reason as store_credits above. No INSERT/UPDATE/SELECT anywhere in the backend — fully orphaned, not just under-used. Superseded by driver_payout_requests + payout_transactions, the real, actively-used pair. Kept, not dropped — see migrate.js\'s own comment on the table definition.',

    // ── Real, live tables with a genuine reason to stay out of the admin panel ──
    payment_methods:      'Users\' saved payment methods — no legitimate day-to-day admin business need to browse; card data minimization is deliberate (see the AppSec audit\'s PCI-scope reasoning). Visible only indirectly (last4/brand) if a support case ever needs it via direct DB access, not a standing UI.',
    transfer_recipients:  'Driver bank/payout-destination records — sensitive banking data with no routine admin browsing need. If a payout dispute ever needs manual verification, that should be a narrow, need-to-know lookup added deliberately then, not a standing list view.',
    trusted_drivers:      'User-driver trust relationship records — no standalone admin business need identified; visible indirectly via the Phase 4 user-lookup screen if ever needed, not as its own view.',
    feed_likes:           'Pure like-count join table, no independent content to moderate beyond the post itself (feed_posts, Phase 4).',
    feed_post_products:   'Tagged-product metadata on a feed post, no independent moderation need beyond the post itself (feed_posts, Phase 4).',
    payflex_webhook_events: 'Legacy Payflex integration history, preserved only per the CRITICAL-3 FIX that removed Payflex entirely — no new rows are ever written, and there is no admin action possible on dead-integration history.',
    driver_locations:       'Raw location ping history, pruned after 30 days by the existing daily cron — no planned aggregate view. Live online/offline status and current position come from drivers.is_online/current_lat/current_lng directly, not this history table.',
  },
};
