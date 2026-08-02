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
export const ROLE_NAV = {
  owner: [
    { path: '/orders', label: 'Orders' },
    { path: '/inventory', label: 'Inventory' },
    { path: '/settings', label: 'Settings' },
  ],
  store_manager: [
    { path: '/orders', label: 'Orders' },
    { path: '/inventory', label: 'Inventory' },
  ],
  inventory_staff: [
    { path: '/inventory', label: 'Inventory' },
  ],
  sales_staff: [
    { path: '/orders', label: 'Orders' },
  ],
  finance: [],
};

export function getNavForRole(role) {
  return ROLE_NAV[role] || [];
}

export function getDefaultRouteForRole(role) {
  const nav = getNavForRole(role);
  return nav.length > 0 ? nav[0].path : '/not-available';
}
