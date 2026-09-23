'use strict';

const db = require("../config/database");
const StoreAction = require("../models/StoreAction");
const {
  acceptOrder,
  rejectPendingAcceptance,
  markReadyForPickup,
} = require("../services/orderStateMachineService");

// Admin Platform Phase 3 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §4/§6.4) —
// the Store Admin Portal's real Orders screen backend. Every handler here
// derives store scope from req.storeId (set by authenticateStore after
// verifying the store user's own token) and NEVER from req.params/body/
// query — the exact rule §5.1 names as CRITICAL. A mismatch is reported as
// 404, not 403, matching the same anti-enumeration convention
// Order.getByIdWithDetails already uses for user/driver ownership checks — a
// compromised Store A account should not even learn that a given order id
// belongs to a real (just not their) store.
//
// Actions reuse orderStateMachineService.acceptOrder/rejectPendingAcceptance/
// markReadyForPickup directly — the same functions the internal Admin
// Panel's own Accept/Reject/Mark-Ready buttons call (adminPanel.js) — so the
// order state machine has exactly one real implementation, not a second
// copy for this portal.
const ACTION_CLIENT_ERROR_FRAGMENTS = [
  "Illegal transition",
  "is not awaiting store acceptance",
];

function isActionClientError(message) {
  if (!message) return false;
  return ACTION_CLIENT_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

// Pagination — never an unbounded list (CLAUDE.md's own scale rule). 25 per
// page by default, capped at 100 even if a caller asks for more.
function parsePagination(query) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

class StoreOrderController {
  static async listOrders(req, res) {
    const { status } = req.query;
    const { page, limit, offset } = parsePagination(req.query);
    try {
      const params = [req.storeId];
      let statusFilter = "";
      if (status) {
        params.push(status);
        statusFilter = `AND o.status = $${params.length}`;
      }
      params.push(limit, offset);
      const result = await db.query(
        `SELECT o.id, o.order_number, o.status, o.total, o.payment_method,
                o.created_at, o.delivery_mode,
                u.name as customer_name, d.name as driver_name
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN drivers d ON d.id = o.driver_id
         WHERE o.store_id = $1 ${statusFilter}
         ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({ orders: result.rows, page, limit });
    } catch (err) {
      console.error("[StoreOrder] listOrders error:", err.message);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  }

  // A real, honest timeline built only from timestamps that genuinely exist
  // (created_at, pickup_photo_at, dropoff_photo_at, delivered_at) — there is
  // no persisted per-transition event log anywhere in this codebase yet.
  // This does NOT fabricate an "accepted at"/"driver assigned at" entry
  // that isn't real data.
  static async getOrder(req, res) {
    try {
      const result = await db.query(
        `SELECT o.*, u.name as customer_name, u.phone as customer_phone,
                d.name as driver_name, d.phone as driver_phone,
                json_agg(json_build_object(
                  'id', oi.id, 'product_name', oi.product_name, 'size', oi.size,
                  'quantity', oi.quantity, 'total_price', oi.total_price
                )) FILTER (WHERE oi.id IS NOT NULL) as items
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN drivers d ON d.id = o.driver_id
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.id = $1
         GROUP BY o.id, u.name, u.phone, d.name, d.phone`,
        [req.params.orderId],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Order not found" });

      const order = result.rows[0];
      if (String(order.store_id) !== String(req.storeId)) {
        return res.status(404).json({ error: "Order not found" });
      }
      res.json({ order });
    } catch (err) {
      console.error("[StoreOrder] getOrder error:", err.message);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  }

  static async accept(req, res) {
    return StoreOrderController._runAction(req, res, {
      actionType: "order_accept",
      run: (orderId, context) => acceptOrder(orderId, context),
      successMessage: "Order accepted — now preparing.",
    });
  }

  static async reject(req, res) {
    return StoreOrderController._runAction(req, res, {
      actionType: "order_reject",
      run: (orderId, context) =>
        rejectPendingAcceptance(orderId, { ...context, reason: "Rejected by store via Store Admin Portal" }),
      successMessage: "Order rejected — customer refunded in full.",
    });
  }

  static async markReady(req, res) {
    return StoreOrderController._runAction(req, res, {
      actionType: "order_mark_ready_for_pickup",
      run: (orderId, context) => markReadyForPickup(orderId, context),
      successMessage: "Order marked ready — driver matching started.",
    });
  }

  // Shared ownership-check + call + audit-log shape for all three actions —
  // the only difference between them is which state-machine function runs.
  static async _runAction(req, res, { actionType, run, successMessage }) {
    const { orderId } = req.params;
    try {
      const orderResult = await db.query(`SELECT store_id FROM orders WHERE id = $1`, [orderId]);
      if (!orderResult.rows.length) return res.status(404).json({ error: "Order not found" });
      if (String(orderResult.rows[0].store_id) !== String(req.storeId)) {
        return res.status(404).json({ error: "Order not found" });
      }

      const io = req.app.get("io");
      const result = await run(orderId, { actorId: req.storeUserId, actorRole: "store", io });
      const updatedOrder = result?.order || result;

      StoreAction.log(req.storeUserId, req.storeId, actionType, "orders", orderId);
      res.json({ order: updatedOrder, message: successMessage });
    } catch (err) {
      console.error(`[StoreOrder] ${actionType} error:`, err.message);
      if (isActionClientError(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to update order" });
    }
  }

  // Admin Platform Phase 3 — role-appropriate analytics
  // (FLASH_STORE_ADMIN_DESIGN.md §6.2's Analytics screen), the same real
  // aggregate-query shape as Admin.getDailyTrends/getFinancials, additively
  // WHERE-scoped to this store instead of platform-wide. Owner/Store
  // Manager/Finance only, per §5.3's RBAC table — enforced by
  // storeAnalyticsRoutes.js, not re-checked here.
  static async getAnalytics(req, res) {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    try {
      const [summaryRes, dailyRes, popularRes] = await Promise.all([
        db.query(
          `SELECT COUNT(*) as order_count, COALESCE(SUM(total), 0) as revenue
           FROM orders WHERE store_id = $1 AND payment_status = 'paid'
             AND created_at >= NOW() - ($2 || ' days')::interval`,
          [req.storeId, days],
        ),
        db.query(
          `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS orders, COALESCE(SUM(total), 0) as revenue
           FROM orders
           WHERE store_id = $1 AND payment_status = 'paid' AND created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY day ORDER BY day ASC`,
          [req.storeId, days],
        ),
        db.query(
          `SELECT oi.product_name, COUNT(*) as times_ordered, SUM(oi.quantity) as units_sold
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE o.store_id = $1 AND o.payment_status = 'paid' AND o.created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY oi.product_name ORDER BY units_sold DESC LIMIT 10`,
          [req.storeId, days],
        ),
      ]);

      res.json({
        summary: {
          orderCount: parseInt(summaryRes.rows[0].order_count, 10),
          revenue: parseFloat(summaryRes.rows[0].revenue),
        },
        daily: dailyRes.rows.map((r) => ({ day: r.day, orders: parseInt(r.orders, 10), revenue: parseFloat(r.revenue) })),
        popularItems: popularRes.rows.map((r) => ({
          productName: r.product_name,
          timesOrdered: parseInt(r.times_ordered, 10),
          unitsSold: parseInt(r.units_sold, 10),
        })),
      });
    } catch (err) {
      console.error("[StoreOrder] getAnalytics error:", err.message);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  }
}

module.exports = StoreOrderController;
