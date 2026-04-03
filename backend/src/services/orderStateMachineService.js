const pool = require("../config/database");
const DriverWallet = require("../models/DriverWallet");

const ORDER_STATES = [
  "created",
  "payment_pending",
  "paid",
  "waiting_for_driver",
  "driver_assigned",
  "driver_arrived_store",
  "picked_up",
  "in_transit",
  "delivered",
  "completed",
  "cancelled",
];

const LEGACY_STATE_MAP = {
  en_route: "driver_arrived_store",
};

const ALLOWED_TRANSITIONS = {
  created: ["payment_pending", "cancelled"],
  payment_pending: ["paid", "cancelled"],
  paid: ["waiting_for_driver", "cancelled"],
  waiting_for_driver: ["driver_assigned", "cancelled"],
  driver_assigned: ["driver_arrived_store", "cancelled"],
  driver_arrived_store: ["picked_up", "cancelled"],
  picked_up: ["in_transit"],
  in_transit: ["delivered"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
};

function normalizeState(status) {
  if (!status) return status;
  return LEGACY_STATE_MAP[status] || status;
}

function canTransition(current, next) {
  const from = normalizeState(current);
  const to = normalizeState(next);
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function getStateRank(state) {
  const normalized = normalizeState(state);
  return ORDER_STATES.indexOf(normalized);
}

async function updateOrderStatus(orderId, nextState, context = {}) {
  const io = context.io;
  const actorId = context.actorId || null;
  const actorRole = context.actorRole || "system";
  const targetState = normalizeState(nextState);

  if (!ORDER_STATES.includes(targetState)) {
    throw new Error(`Invalid order state: ${targetState}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );

    if (!orderResult.rows.length) {
      throw new Error("Order not found");
    }

    const order = orderResult.rows[0];
    const currentState = normalizeState(order.status);

    if (currentState === targetState) {
      await client.query("COMMIT");
      return order;
    }

    if (!canTransition(currentState, targetState)) {
      throw new Error(`Illegal transition from ${currentState} to ${targetState}`);
    }

    if (actorRole === "driver") {
      if (!order.driver_id || String(order.driver_id) !== String(actorId)) {
        throw new Error("Driver cannot change this order");
      }
      if (targetState === "cancelled" && getStateRank(currentState) >= getStateRank("picked_up")) {
        throw new Error("Cannot cancel after pickup without admin override");
      }
    }

    const updates = { status: targetState };

    if (targetState === "driver_assigned") {
      updates.delivery_payment_status = "assigned";
      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
      if (order.driver_id && payout > 0) {
        await DriverWallet.addPending(client, order.driver_id, payout, order.id, "driver_assigned_pending");
      }
    }

    if (["picked_up", "in_transit", "delivered"].includes(targetState) && order.payment_method !== "cash") {
      updates.delivery_payment_status = "held";
    }

    if (targetState === "completed") {
      if (order.payment_method !== "cash") {
        const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
        if (order.driver_id && payout > 0 && order.driver_paid !== true) {
          await DriverWallet.releasePending(client, order.driver_id, payout, order.id, "delivery_completed_release");
          updates.driver_paid = true;
        }
        updates.delivery_payment_status = "released";
      }
      if (order.payment_method === "cash" && order.payment_status !== "paid") {
        throw new Error("Cash orders require payment confirmation before completion");
      }
    }

    const updatedResult = await client.query(
      `UPDATE orders
       SET status = $1,
           delivery_payment_status = COALESCE($2, delivery_payment_status),
           driver_paid = COALESCE($3, driver_paid),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        updates.status,
        updates.delivery_payment_status || null,
        updates.driver_paid ?? null,
        orderId,
      ],
    );

    await client.query("COMMIT");

    const updatedOrder = updatedResult.rows[0];
    if (io) {
      io.to(`order:${orderId}`).emit("order_update", {
        orderId,
        status: updatedOrder.status,
        timestamp: new Date().toISOString(),
      });
      if (updatedOrder.user_id) {
        io.to(`user:${updatedOrder.user_id}`).emit("order_update", {
          orderId,
          status: updatedOrder.status,
        });
      }
    }

    return updatedOrder;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assignDriver(orderId, driverId, context = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!orderResult.rows.length) throw new Error("Order not found");
    const order = orderResult.rows[0];

    const currentState = normalizeState(order.status);
    if (currentState !== "waiting_for_driver") {
      throw new Error("Order is not ready for assignment");
    }

    if (order.driver_id) throw new Error("Order already assigned");

    const updatedResult = await client.query(
      `UPDATE orders
       SET driver_id = $1,
           status = 'driver_assigned',
           delivery_payment_status = 'assigned',
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [driverId, orderId],
    );

    const updated = updatedResult.rows[0];
    const payout = parseFloat(updated.driver_payout || updated.delivery_fee || 0);
    if (payout > 0) {
      await DriverWallet.addPending(client, driverId, payout, orderId, "driver_assigned_pending");
    }

    await client.query("COMMIT");

    if (context.io) {
      context.io.to(`driver:${driverId}`).emit("new_order_available", {
        orderId,
        assigned: true,
        payout: payout.toFixed(2),
      });
      context.io.to(`user:${updated.user_id}`).emit("order_update", {
        orderId,
        status: "driver_assigned",
      });
    }

    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ORDER_STATES,
  ALLOWED_TRANSITIONS,
  normalizeState,
  canTransition,
  updateOrderStatus,
  assignDriver,
};
