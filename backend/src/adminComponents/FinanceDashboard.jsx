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

// Day-over-day trend charts (Addendum 2 §5). Colors are the validated
// categorical palette from the dataviz skill's reference instance --
// AdminJS's own default theme doesn't ship enough distinct categorical
// hues for four series (only primary100/accent/info exist outside the
// reserved success/error/warning status colors), so these three are
// pulled from the skill's own validated set instead of guessed. Verified
// via scripts/validate_palette.js under --pairs all (the correct mode for
// small multiples, since all four charts are visible on screen at once):
// blue/orange/aqua clear every check in both light and dark; a genuine 4th
// hue (yellow) does NOT -- it fails the normal-vision floor against orange
// (ΔE 13.7, below the 15 floor) -- so "New Drivers" reuses blue rather than
// introduce an unvalidated 4th hue. This is safe specifically because each
// chart is independently titled -- identity never depends on color alone,
// per the skill's own non-negotiable rule -- so two panels sharing a hue
// causes no real ambiguity.
const CHART_COLORS = { blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a' };
const CHART_TEXT_PRIMARY = '#0b0b0b';
const CHART_TEXT_MUTED = '#898781';
const CHART_GRIDLINE = '#e1e0d9';
const CHART_SURFACE = '#fcfcfb';

function formatCompact(n) {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Scope decision, named honestly rather than silently dropped: the dataviz
// skill's full spec calls for a tracking crosshair + one shared tooltip
// across all series at a given X. Built here instead with a native SVG
// <title> per point (a real, working, zero-extra-dependency hover value,
// keyboard-reachable via tabIndex) -- proportionate to a solo founder
// checking this a few times a day, matching the same "periodic refresh,
// not a live socket feed" reasoning the audit doc already applied to this
// exact dashboard (Addendum 2 §5). Every value shown on hover is also
// reachable without it: the endpoint is direct-labeled and the peak value
// anchors the y-scale, per marks-and-anatomy's "label selectively" rule.
function LineChart({ title, data, valueKey, color, formatValue }) {
  const width = 280;
  const height = 110;
  const padding = { top: 10, right: 8, bottom: 18, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = data.map((d) => d[valueKey]);
  const max = Math.max(...values, 1);
  const xFor = (i) => padding.left + (i / (data.length - 1 || 1)) * plotWidth;
  const yFor = (v) => padding.top + plotHeight - (v / max) * plotHeight;
  const points = data.map((d, i) => ({ x: xFor(i), y: yFor(d[valueKey]), value: d[valueKey], day: d.day }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const baseline = padding.top + plotHeight;
  const areaPath = `${linePath} L${points[points.length - 1].x},${baseline} L${points[0].x},${baseline} Z`;
  const last = points[points.length - 1];
  const fmt = (v) => (formatValue ? formatValue(v) : formatCompact(v));

  return (
    <Box mr="lg" mb="lg" p="default" bg="white" boxShadow="card" width={300}>
      <Text fontSize="sm" color="grey60" mb="sm">{title}</Text>
      <svg width={width} height={height} role="img" aria-label={`${title} over the last ${data.length} days, peak ${fmt(max)}`}>
        <text x={padding.left} y={padding.top} fontSize={9} fill={CHART_TEXT_MUTED}>{fmt(max)}</text>
        <line x1={padding.left} y1={baseline} x2={width - padding.right} y2={baseline} stroke={CHART_GRIDLINE} strokeWidth={1} />
        <path d={areaPath} fill={color} opacity={0.1} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p) => (
          <circle key={p.day} cx={p.x} cy={p.y} r={12} fill="transparent" tabIndex={0}>
            <title>{`${p.day}: ${fmt(p.value)}`}</title>
          </circle>
        ))}
        <circle cx={last.x} cy={last.y} r={4} fill={color} stroke={CHART_SURFACE} strokeWidth={2} />
        <text x={last.x} y={Math.max(last.y - 10, 10)} textAnchor="end" fontSize={12} fontWeight={700} fill={CHART_TEXT_PRIMARY}>{fmt(last.value)}</text>
      </svg>
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

  const { totalUsers, approvedDrivers, totalOrders, grossOrderValue, activeOrdersByStatus, financials, dailyTrends } = data;

  return (
    <Box p="xxl">
      <H2 mb="xl">Flash — Operations Dashboard</H2>

      <Section title="At a glance">
        <StatBox label="Total users" value={totalUsers} />
        <StatBox label="Approved drivers" value={approvedDrivers} />
        <StatBox label="Total orders (all time)" value={totalOrders} />
        <StatBox label="Gross order value (all time)" value={money(grossOrderValue)} />
      </Section>

      {dailyTrends && dailyTrends.length > 0 && (
        <Section title={`Last ${dailyTrends.length} days`}>
          <LineChart title="New users" data={dailyTrends} valueKey="newUsers" color={CHART_COLORS.aqua} />
          <LineChart title="New drivers" data={dailyTrends} valueKey="newDrivers" color={CHART_COLORS.blue} />
          <LineChart title="Orders" data={dailyTrends} valueKey="orders" color={CHART_COLORS.blue} />
          <LineChart title="Flash revenue" data={dailyTrends} valueKey="revenue" color={CHART_COLORS.orange} formatValue={money} />
        </Section>
      )}

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
