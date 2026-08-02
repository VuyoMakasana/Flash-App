import PortalLayout from '../components/PortalLayout';

// Multi-tenant Stage 6 — the Finance role's real landing page. Analytics
// remains blocked on the deliberately-deferred settlement-calculation
// logic from Stage 1 (docs/audits/FINANCIAL_DOMAIN_SPECIFICATION.md) —
// this is an honest "not yet available" state, not an empty or broken
// screen pretending a real feature exists.
export default function NotAvailablePage() {
  return (
    <PortalLayout>
      <h1>Not Available Yet</h1>
      <p>
        Your role's screen (Analytics — commission and settlement history) isn't built yet.
        This depends on real settlement-calculation logic that hasn't been implemented.
        Check back once it's ready.
      </p>
    </PortalLayout>
  );
}
