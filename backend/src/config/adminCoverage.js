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
    users:                          'Phase 1 (count, already real via getStats) + Phase 4 (full individual lookup — profile, orders, addresses, flags).',
    addresses:                      'Phase 4 — part of the individual user-lookup screen (saved address book).',
    flash_inventory:                'Phase 4 — real admin CRUD already exists (inventoryRoutes.js), UI not yet built.',

    // ── Phase 0 — this table and its own audit trail ─────────────────────
    admins:        'Phase 0 — the account itself. A "manage other admins" screen is a natural Phase 4 addition once there\'s a real second admin (Addendum 3 §4\'s role decision).',
    admin_actions: 'Phase 0 — the audit log itself. AdminAction.getRecent() already exists to read it back; a real UI view showing it is a natural near-term addition.',

    // ── Phase 2 — financial and dispute visibility ──────────────────────
    payments:                'Phase 2 — core transaction ledger feeding the financial-picture view.',
    payment_refunds:         'Phase 2 — refunds-issued total; also the reconciliation-check target (Addendum 1 §4.4).',
    driver_commission_debts: 'Phase 2 — cash-order commission revenue line (Addendum 1 §4.3).',
    driver_wallet_ledger:    'Phase 2 — driver payout/compensation cost lines; also a reconciliation-check target.',
    driver_wallets:          'Phase 2 — driver wallet balance admin view (genuinely new backend, no admin endpoint exists yet).',
    driver_penalties:        'Phase 2 — cost-offset line (nets against payouts, per Addendum 1 §4.3).',
    driver_payout_requests:  'Phase 2 — driver payout admin view.',
    payout_transactions:     'Phase 2 — driver payout admin view, real Paystack transfer trail.',
    driver_subscriptions:    'Phase 2 — subscription status/history (added in Addendum 3 §1, fixing the inconsistency where the revenue was counted without the record).',
    premium_subscriptions:   'Phase 2 — same fix as driver_subscriptions, Addendum 3 §1.',
    driver_documents:        'Phase 2/1 — document review via signed URLs; Admin.getDriverById already does this correctly, no UI yet.',
    messages:                'Phase 2 — found during this pass, not previously named in any round: order chat between customer/driver belongs in the dispute-review screen alongside pickup/dropoff photos (same screen, same justification — a dispute needs the conversation, not just the photo).',

    // ── Phase 3 — trust and safety ───────────────────────────────────────
    sos_alerts:     'Phase 3 — the most urgent gap in the whole document (Addendum 1 §1.4): needs a real getAll/acknowledge pair.',
    driver_ratings: 'Phase 3 — rating trends (already named in the original §3 Phase 3 text).',

    // ── Phase 4 — rounding out ───────────────────────────────────────────
    app_ratings:          'Phase 4 (Addendum 3 §1 — was orphaned, now placed alongside content moderation).',
    size_profiles:        'Phase 4 (Addendum 3 §1) — data-quality/usage visibility, explicitly low priority.',
    brand_size_mappings:  'Phase 4 — same as size_profiles.',
    feed_posts:           'Phase 4 — content moderation (Addendum 3 §1): list-all-active-posts + admin-callable delete, reusing Feed.deletePost\'s existing soft-delete pattern.',
    feed_comments:        'Phase 4 — same content-moderation screen as feed_posts.',
    store_boosts:         'Phase 4 — real product decision needed (build the pricing/ranking effect, or retire the feature) — not just a UI task. Confirmed again this pass: purchaseBoost never calls Paystack, price_paid is not a verified charge.',
    store_promotions:     'Phase 4 — same decision as store_boosts.',
    store_credits:        'Phase 4 — DEAD TABLE (Addendum 1 §4.4): real read path, never written to anywhere. Needs a retire-or-rebuild decision before Phase 4 touches it.',
    driver_payouts:        'Phase 4 — DEAD TABLE (Addendum 1 §4.4): created by a migration, referenced nowhere else. Real pair is driver_payout_requests + payout_transactions.',
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
