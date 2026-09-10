import { useEffect, useState, useCallback } from 'react';
import { storeApi } from '../services/api';
import { statusInfo } from '../utils/orderStatus';
import PortalLayout from '../components/PortalLayout';

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [actioningId, setActioningId] = useState(null);

  const loadOrders = useCallback(async () => {
    setError(null);
    try {
      const { orders: rows } = await storeApi.getOrders();
      setOrders(rows);
    } catch (err) {
      if (err.status === 403) {
        // A real, distinct state from "no orders exist" — an empty orders[]
        // here means "not authorized," not "this store has none," and must
        // never render alongside a misleading "No orders yet." (found live
        // while testing a real Finance-role account against this screen).
        setAccessDenied(true);
        setError("Your role doesn't have order access.");
      } else {
        setError('Failed to load orders.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  async function runAction(orderId, action) {
    setActioningId(orderId);
    setError(null);
    try {
      await action(orderId);
      await loadOrders();
    } catch (err) {
      setError(err.message || 'Action failed.');
    } finally {
      setActioningId(null);
    }
  }

  // New Orders is its own always-visible top section — store response
  // time is the real latency this workflow introduces, the 15-minute
  // timeout cron is the backstop, not the target (FLASH_STORE_ADMIN_
  // DESIGN.md §4.1).
  const newOrders = orders.filter((o) => o.status === 'pending_store_acceptance');
  const otherOrders = orders.filter((o) => o.status !== 'pending_store_acceptance');

  return (
    <PortalLayout>
      <h1>Orders</h1>
      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : accessDenied ? null : (
        <>
          {newOrders.length > 0 && (
            <section className="new-orders-section">
              <h2>New Orders ({newOrders.length})</h2>
              {newOrders.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  actioning={actioningId === order.id}
                  actions={
                    <>
                      <button
                        className="btn-accept"
                        disabled={actioningId === order.id}
                        onClick={() => runAction(order.id, storeApi.acceptOrder)}
                      >
                        Accept
                      </button>
                      <button
                        className="btn-reject"
                        disabled={actioningId === order.id}
                        onClick={() => runAction(order.id, storeApi.rejectOrder)}
                      >
                        Reject
                      </button>
                    </>
                  }
                />
              ))}
            </section>
          )}

          <section>
            <h2>All Orders</h2>
            {otherOrders.length === 0 && newOrders.length === 0 ? (
              <p>No orders yet.</p>
            ) : (
              otherOrders.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  actioning={actioningId === order.id}
                  actions={
                    order.status === 'preparing' ? (
                      <button
                        className="btn-mark-ready"
                        disabled={actioningId === order.id}
                        onClick={() => runAction(order.id, storeApi.markReady)}
                      >
                        Mark Ready for Pickup
                      </button>
                    ) : null
                  }
                />
              ))
            )}
          </section>
        </>
      )}
    </PortalLayout>
  );
}

function OrderRow({ order, actions, actioning }) {
  const { label, tone } = statusInfo(order.status);
  return (
    <div className="order-row">
      <span className={`status-dot status-${tone}`} />
      <div className="order-row-main">
        <strong>{order.order_number}</strong>
        <span>{order.customer_name || 'Customer'}</span>
        <span className={`status-label status-${tone}`}>{label}</span>
        <span>R{Number(order.total).toFixed(2)}</span>
      </div>
      {actioning ? <span>Working…</span> : <div className="order-row-actions">{actions}</div>}
    </div>
  );
}
