import { useEffect, useState, useCallback } from 'react';
import { storeApi } from '../services/api';
import PortalLayout from '../components/PortalLayout';

// Admin Platform Phase 3 — "role-appropriate analytics (order volume,
// revenue, popular items) — genuinely useful, not a data dump" backed by
// storeOrderController.getAnalytics (a real, indexed, store-scoped
// aggregate query, the same shape as the internal admin panel's own
// Admin.getDailyTrends/getFinancials). Owner/Store Manager/Finance only —
// enforced server-side by storeAnalyticsRoutes.js; a 403 here is a real
// access-denied state, not an empty dashboard.
export default function AnalyticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [days, setDays] = useState(14);

  const load = useCallback(async (rangeDays) => {
    setLoading(true);
    setError(null);
    try {
      const result = await storeApi.getAnalytics(rangeDays);
      setData(result);
    } catch (err) {
      if (err.status === 403) {
        setAccessDenied(true);
        setError("Your role doesn't have analytics access.");
      } else {
        setError('Failed to load analytics.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  return (
    <PortalLayout>
      <div className="inventory-header-row">
        <h1>Analytics</h1>
        {!accessDenied && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : accessDenied || !data ? null : (
        <>
          <div className="analytics-summary">
            <div className="analytics-tile">
              <p className="tile-label">Orders (paid)</p>
              <p className="tile-value">{data.summary.orderCount}</p>
            </div>
            <div className="analytics-tile">
              <p className="tile-label">Revenue</p>
              <p className="tile-value">R{data.summary.revenue.toFixed(2)}</p>
            </div>
          </div>

          <h2>Daily breakdown</h2>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr><th>Day</th><th>Orders</th><th>Revenue</th></tr>
              </thead>
              <tbody>
                {data.daily.length === 0 ? (
                  <tr><td colSpan={3}>No paid orders in this range yet.</td></tr>
                ) : (
                  data.daily.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td>{d.orders}</td>
                      <td>R{d.revenue.toFixed(2)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h2>Popular items</h2>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr><th>Product</th><th>Times ordered</th><th>Units sold</th></tr>
              </thead>
              <tbody>
                {data.popularItems.length === 0 ? (
                  <tr><td colSpan={3}>No items sold in this range yet.</td></tr>
                ) : (
                  data.popularItems.map((item) => (
                    <tr key={item.productName}>
                      <td>{item.productName}</td>
                      <td>{item.timesOrdered}</td>
                      <td>{item.unitsSold}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PortalLayout>
  );
}
