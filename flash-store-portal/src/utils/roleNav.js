// Multi-tenant Stage 6 — the single real source of truth for which screens
// each role can reach, shared between PortalLayout.jsx (which links to
// show) and LoginPage.jsx (where to land after login) so the two can never
// drift apart. Mirrors DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §5.3's
// RBAC table literally: Store Manager does NOT get Settings (Owner-only,
// per both governing documents, confirmed against the founder's own
// audit-decision resolution); Marketing isn't listed at all (no login
// access yet); Finance has no real screen yet (Analytics remains blocked
// on the deferred settlement-calculation logic) and lands on a real,
// honest "not yet available" state instead of an empty or broken screen.
// Admin Platform Phase 3 — Analytics is now a real, built screen
// (storeOrderController.getAnalytics), not deferred pending settlement-
// calculation logic. Finance's real screen per FLASH_STORE_ADMIN_DESIGN.md
// §5.3 ("Financial/analytics screens only"); Owner and Store Manager also
// see it (the same RBAC table lists "financials" under both).
// TEMPORARY — no Payout Details screen is listed for any role, including
// Owner, and there is deliberately no /store-banking route in App.jsx either.
//
// The backend for it EXISTS and is live (Phase 2a: GET/POST
// /api/store-banking, owner-only, password re-authenticated). It is hidden
// because it cannot currently be completed: GET /api/store-banking/banks
// returns 502 on production's sk_test_ Paystack key, so the bank dropdown a
// payout form needs has nothing to populate it, and POST would 502 as well.
//
// Same treatment, and the same reasoning, as the customer app hiding the Card
// option in flash-user-app/screens/PaymentScreen.js: a store owner tapping
// "Payout Details" would hit a genuine dead end rather than a temporary
// inconvenience, so no entry point is offered at all rather than a broken one.
//
// To restore once a live, ZA-configured Paystack key exists and /banks returns
// real banks: add the route in App.jsx and a { path: '/banking', label:
// 'Payout Details' } entry to owner below. See
// docs/audits/PHASE2A_PAYOUT_DESTINATION_RECORD.md.
export const ROLE_NAV = {
  owner: [
    { path: '/orders', label: 'Orders' },
    { path: '/inventory', label: 'Inventory' },
    { path: '/analytics', label: 'Analytics' },
    { path: '/settings', label: 'Settings' },
  ],
  store_manager: [
    { path: '/orders', label: 'Orders' },
    { path: '/inventory', label: 'Inventory' },
    { path: '/analytics', label: 'Analytics' },
  ],
  inventory_staff: [
    { path: '/inventory', label: 'Inventory' },
  ],
  sales_staff: [
    { path: '/orders', label: 'Orders' },
  ],
  finance: [
    { path: '/analytics', label: 'Analytics' },
  ],
};

export function getNavForRole(role) {
  return ROLE_NAV[role] || [];
}

export function getDefaultRouteForRole(role) {
  const nav = getNavForRole(role);
  return nav.length > 0 ? nav[0].path : '/not-available';
}
