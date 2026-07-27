import React, { useEffect, useState } from 'react';
import { ApiClient } from 'adminjs';
import { Box, H2, H4, Text } from '@adminjs/design-system';

// The AdminJS default dashboard (used until now) is a static "welcome to
// AdminJS" marketing page -- confirmed by reading default-dashboard.js
// directly -- it never renders anything a dashboard.handler returns. That
// meant the real stats/active-orders/financial numbers built server-side
// were only reachable by calling GET /admin-panel/api/dashboard directly;
// nothing showed them in the actual panel a founder opens. This is the
// first real custom AdminJS component in this codebase, registered via
// ComponentLoader in adminPanel.js -- kept deliberately plain (no chart
// library, no new dependency; react/react-dom already ship as adminjs's
// own dependencies, resolved by adminjs's own bundler) since a solo
// founder checking this a few times a day doesn't need more than real,
// correctly-labeled numbers.

function money(value) {
  const n = Number(value || 0);
  return `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatBox({ label, value }) {
  return (
    <Box variant="grey" p="lg" mr="lg" mb="lg" width={220}>
      <Text fontSize="sm" color="grey60">{label}</Text>
      <H2 mt="sm">{value}</H2>
    </Box>
  );
}

function Section({ title, children }) {
  return (
    <Box mb="xxl">
      <H4 mb="lg">{title}</H4>
      <Box flex flexDirection="row" flexWrap="wrap">{children}</Box>
    </Box>
  );
}

const FinanceDashboard = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    new ApiClient().getDashboard()
      .then((response) => setData(response.data))
      .catch((err) => setError(err.message || 'Failed to load dashboard data'));
  }, []);

  if (error) {
    return <Box p="xxl"><Text color="danger">Failed to load dashboard: {error}</Text></Box>;
  }
  if (!data) {
    return <Box p="xxl"><Text>Loading...</Text></Box>;
  }

  const { totalUsers, approvedDrivers, totalOrders, grossOrderValue, activeOrdersByStatus, financials } = data;

  return (
    <Box p="xxl">
      <H2 mb="xl">Flash — Operations Dashboard</H2>

      <Section title="At a glance">
        <StatBox label="Total users" value={totalUsers} />
        <StatBox label="Approved drivers" value={approvedDrivers} />
        <StatBox label="Total orders (all time)" value={totalOrders} />
        <StatBox label="Gross order value (all time)" value={money(grossOrderValue)} />
      </Section>

      <Section title="Active orders right now, by status">
        {activeOrdersByStatus.length === 0
          ? <Text>No active orders.</Text>
          : activeOrdersByStatus.map((row) => (
            <StatBox key={row.status} label={row.status} value={row.count} />
          ))}
      </Section>

      {financials && (
        <>
          <Section title="Flash revenue (real money Flash keeps -- not gross order value)">
            <StatBox label="Card-order delivery commission" value={money(financials.flashRevenue.cardOrderCommission)} />
            <StatBox label="Cash-order commission (collected)" value={money(financials.flashRevenue.cashOrderCommission)} />
            <StatBox label="Driver subscriptions" value={money(financials.flashRevenue.driverSubscriptions)} />
            <StatBox label="Premium subscriptions" value={money(financials.flashRevenue.premiumSubscriptions)} />
            <StatBox label="Pre-pickup cancellation store share" value={money(financials.flashRevenue.cancellationStoreShare)} />
            <StatBox label="Total Flash revenue" value={money(financials.flashRevenue.total)} />
          </Section>

          <Section title="Costs Flash pays">
            <StatBox label="Driver payouts (actually paid out)" value={money(financials.costs.driverPayoutsPaid)} />
            <StatBox label="Cancellation driver compensation" value={money(financials.costs.cancellationDriverCompensation)} />
            <StatBox label="Refunds issued (completed)" value={money(financials.costs.refundsIssued)} />
            <StatBox label="Total costs" value={money(financials.costs.total)} />
          </Section>

          <Section title="Net position">
            <StatBox label="Driver penalties collected (offsets payouts)" value={money(financials.driverPenaltiesCollected)} />
            <StatBox label="Net position (revenue - costs + penalties)" value={money(financials.netPosition)} />
            <StatBox label="Cash commission not yet collected" value={money(financials.outstanding.cashCommissionNotYetCollected)} />
          </Section>

          <Box variant="grey" p="lg">
            <Text fontSize="sm" color="grey60">
              Excludes: {financials.excludedFromRevenue.boostAndPromotionPricePaid}
            </Text>
            <Text fontSize="sm" color="grey60" mt="sm">
              {financials.excludesExternalCosts}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};

export default FinanceDashboard;
