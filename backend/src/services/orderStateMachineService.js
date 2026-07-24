'use strict';

/**
 * orderStateMachineService.js
 *
 * HIGH-12 FIX: After each status update, notifyUserOrderUpdate() is called so
 *   users receive push notifications even when their app is backgrounded.
 *
 * HIGH-3 FIX: assignDriver() uses a FOR UPDATE + NOT EXISTS subquery to check
 *   driver availability atomically, preventing double-assignment race conditions.
 */

const pool        = require('../config/database');
const DriverWallet = require('../models/DriverWallet');

const ORDER_STATES = [
  'created',
  'payment_pending',
  'paid',
  'scheduled_for_morning',
  'waiting_for_driver',
  'driver_assigned',
  'driver_arrived_store',
  'picked_up',
  'in_transit',
  'delivered',
  'completed',
  'cancelled',
];

const LEGACY_STATE_MAP = {
  en_route: 'driver_arrived_store',
};

const ALLOWED_TRANSITIONS = {
  created:               ['payment_pending', 'cancelled'],
  payment_pending:       ['paid', 'scheduled_for_morning', 'cancelled'],
  paid:                  ['waiting_for_driver', 'scheduled_for_morning', 'cancelled'],
  scheduled_for_morning: ['waiting_for_driver', 'cancelled'],
  waiting_for_driver:    ['driver_assigned', 'cancelled'],
  driver_assigned:       ['driver_arrived_store', 'cancelled'],
  driver_arrived_store:  ['picked_up', 'cancelled'],
  picked_up:             ['in_transit'],
  in_transit:            ['delivered'],
  delivered:             ['completed'],
  completed:             [],
  cancelled:             [],
};

function normalizeState(status) {
  if (!status) return status;
  return LEGACY_STATE_MAP[status] || status;
}

function canTransition(current, next) {
  const from    = normalizeState(current);
  const to      = normalizeState(next);
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function getStateRank(state) {
  return ORDER_STATES.indexOf(normalizeState(state));
}

function logTransition(orderId, fromState, toState, actorRole, actorId) {
  console.log(
    `[OrderStateMachine] orderId=${orderId} from=${fromState} to=${toState} actor=${actorRole}:${actorId || 'n/a'}`,
  );
}

// Socket.IO side-effect shared by updateOrderStatus and requeueOrderForDriverSearch.
// Split out so callers that join an existing transaction (externalClient) can
// defer this until after their own COMMIT succeeds, instead of it firing
// inside a transaction that might still roll back.
function emitOrderUpdate(io, orderId, userId, status) {
  if (!io) return;
  io.to(`order:${orderId}`).emit('order_update', {
    orderId,
    status,
    timestamp: new Date().toISOString(),
  });
  if (userId) {
    io.to(`user:${userId}`).emit('order_update', { orderId, status });
  }
}

// Push notification side-effect for updateOrderStatus, split out for the same
// reason as emitOrderUpdate above.
async function notifyOrderStatusChange(updatedOrder, targetState) {
  if (!updatedOrder.user_id) return;
  const { notifyUserOrderUpdate } = require('./notificationService');
  await notifyUserOrderUpdate(updatedOrder.user_id, updatedOrder.id, targetState).catch(() => {});
}

// A return's reverse-delivery order reaching 'completed' is the moment the
// item is physically back at the store — the return itself doesn't move
// past 'approved' automatically (see Return.finalizeRefund's design: a
// human must review before a refund actually fires). Without this, nothing
// would ever tell anyone that review is now possible, and a return could
// sit indefinitely un-finalized.
async function notifyReturnAwaitingReview(updatedOrder) {
  if (!updatedOrder.is_return_order) return;
  try {
    const result = await pool.query(
      `SELECT rr.id, rr.refund_amount, o.order_number
       FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE rr.return_order_id = $1 AND rr.status = 'approved'`,
      [updatedOrder.id],
    );
    if (!result.rows.length) return;
    const { sendReturnAwaitingReviewEmail } = require('./emailService');
    const row = result.rows[0];
    await sendReturnAwaitingReviewEmail({
      returnId: row.id,
      orderNumber: row.order_number,
      refundAmount: row.refund_amount,
    });
  } catch (_err) {
    // Never let a notification failure affect the order-completion result
    // that already succeeded — same rule as notifyOrderStatusChange above.
  }
}

// When context.externalClient is passed, this function joins the caller's
// existing transaction instead of opening its own — the caller owns
// BEGIN/COMMIT/ROLLBACK and is responsible for calling emitOrderUpdate /
// notifyOrderStatusChange itself once its own transaction actually commits.
// This is what lets e.g. a wallet reversal and the resulting order-status
// change share one atomic transaction (see orderController.cancelOrder).
async function updateOrderStatus(orderId, nextState, context = {}) {
  const io        = context.io;
  const actorId   = context.actorId   || null;
  const actorRole = context.actorRole || 'system';
  const externalClient = context.externalClient || null;
  const targetState = normalizeState(nextState);

  if (!ORDER_STATES.includes(targetState)) {
    throw new Error(`Invalid order state: ${targetState}`);
  }

  const client = externalClient || await pool.connect();
  try {
    if (!externalClient) {
      await client.query('BEGIN');
    }

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );

    if (!orderResult.rows.length) throw new Error('Order not found');

    const order        = orderResult.rows[0];
    const currentState = normalizeState(order.status);

    if (currentState === targetState) {
      logTransition(orderId, currentState, targetState, actorRole, actorId);
      if (!externalClient) {
        await client.query('COMMIT');
      }
      return order;
    }

    if (!canTransition(currentState, targetState)) {
      throw new Error(`Illegal transition from ${currentState} to ${targetState}`);
    }

    logTransition(orderId, currentState, targetState, actorRole, actorId);

    if (actorRole === 'driver') {
      if (!order.driver_id || String(order.driver_id) !== String(actorId)) {
        throw new Error('Driver cannot change this order');
      }
      if (targetState === 'cancelled' && getStateRank(currentState) >= getStateRank('picked_up')) {
        throw new Error('Cannot cancel after pickup without admin override');
      }
    }

    const updates = { status: targetState };

    if (targetState === 'driver_assigned') {
      updates.delivery_payment_status = 'assigned';
      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
      if (order.driver_id && payout > 0) {
        await DriverWallet.addPending(client, order.driver_id, payout, order.id, 'driver_assigned_pending');
      }
    }

    if (['picked_up', 'in_transit', 'delivered'].includes(targetState) && order.payment_method !== 'cash') {
      updates.delivery_payment_status = 'held';
    }

    if (targetState === 'completed') {
      if (order.payment_method !== 'cash') {
        const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
        if (order.driver_id && payout > 0 && order.driver_paid !== true) {
          await DriverWallet.releasePending(client, order.driver_id, payout, order.id, 'delivery_completed_release');
          updates.driver_paid = true;
        }
        updates.delivery_payment_status = 'released';
      }
      if (order.payment_method === 'cash' && order.payment_status !== 'paid') {
        throw new Error('Cash orders require payment confirmation before completion');
      }
    }

    // delivered_at is written exactly once, the first time an order reaches
    // 'delivered' — COALESCE(delivered_at, $5) means a re-entry or a later
    // transition (e.g. delivered -> completed) can never overwrite it. This
    // is the immutable anchor the returns feature's 48-hour eligibility
    // window is computed from; updated_at is unsuitable for that since it's
    // rewritten on every subsequent transition.
    const deliveredAtParam = targetState === 'delivered' ? new Date() : null;

    const updatedResult = await client.query(
      `UPDATE orders
       SET status = $1,
           delivery_payment_status = COALESCE($2, delivery_payment_status),
           driver_paid = COALESCE($3, driver_paid),
           delivered_at = COALESCE(delivered_at, $5),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        updates.status,
        updates.delivery_payment_status || null,
        updates.driver_paid ?? null,
        orderId,
        deliveredAtParam,
      ],
    );

    if (!externalClient) {
      await client.query('COMMIT');
    }

    const updatedOrder = updatedResult.rows[0];

    // When joining a caller's transaction, side effects are the caller's
    // responsibility — they must only fire after the caller's own COMMIT
    // succeeds (see emitOrderUpdate / notifyOrderStatusChange above).
    if (!externalClient) {
      emitOrderUpdate(io, orderId, updatedOrder.user_id, updatedOrder.status);
      await notifyOrderStatusChange(updatedOrder, targetState);
      if (targetState === 'completed') {
        await notifyReturnAwaitingReview(updatedOrder);
      }
    }

    return updatedOrder;
  } catch (err) {
    if (!externalClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (!externalClient) {
      client.release();
    }
  }
}

/**
 * Atomically assign a driver to an order.
 *
 * HIGH-3 FIX: Uses SELECT ... FOR UPDATE with a NOT EXISTS subquery inside
 *   the same transaction that updates the order, preventing double-assignment
 *   when two requests race.
 */
async function assignDriver(orderId, driverId, context = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // CRITICAL FIX: SELECT ... FOR UPDATE below only locks the drivers row —
    // it does NOT lock the orders table the NOT EXISTS subquery reads. Under
    // READ COMMITTED, a transaction blocked waiting for that row lock resumes
    // using the snapshot it already took at the start of THIS statement, so
    // it can still see zero matching orders even after the other transaction
    // has committed one. Confirmed live: two orders fired at a single driver
    // at the exact same instant were BOTH assigned to that driver. A Postgres
    // advisory lock (a separate primitive from row locks, released only on
    // commit/rollback) forces a second concurrent call for the same driver to
    // fully block until the first transaction ends, so its subsequent query
    // is a fresh statement with a fresh snapshot that correctly sees the
    // first assignment.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [driverId]);

    // HIGH-3: Lock driver row AND verify they are still free — all in one
    // atomic operation. If another transaction already assigned this driver,
    // the lock means we'll see the updated is_online / active order state.
    const driverCheck = await client.query(
      `SELECT id FROM drivers
       WHERE id = $1
         AND is_online = true
         AND status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM orders o
           WHERE o.driver_id = $1
             AND o.status IN ('driver_assigned','driver_arrived_store','picked_up','in_transit')
         )
       FOR UPDATE`,
      [driverId],
    );
    if (!driverCheck.rows.length) {
      throw new Error('Driver no longer available');
    }

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!orderResult.rows.length) throw new Error('Order not found');
    const order = orderResult.rows[0];

    const currentState = normalizeState(order.status);
    if (currentState !== 'waiting_for_driver') {
      throw new Error('Order is not ready for assignment');
    }
    if (order.driver_id) throw new Error('Order already assigned');

    // Trusted driver exclusivity check
    if (context.enforceTrustedDriverWindow) {
      const hasUnexpiredPreference =
        order.preferred_driver_id &&
        order.preferred_driver_expires_at &&
        new Date(order.preferred_driver_expires_at).getTime() > Date.now();

      if (hasUnexpiredPreference && String(order.preferred_driver_id) !== String(driverId)) {
        throw new Error(
          "This order is currently reserved for the customer's trusted driver. Please try again shortly.",
        );
      }
    }

    logTransition(orderId, currentState, 'driver_assigned', 'driver', driverId);

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
    const payout  = parseFloat(updated.driver_payout || updated.delivery_fee || 0);
    if (payout > 0) {
      await DriverWallet.addPending(client, driverId, payout, orderId, 'driver_assigned_pending');
    }

    await client.query('COMMIT');

    if (context.io) {
      context.io.to(`driver:${driverId}`).emit('new_order_available', {
        orderId,
        assigned: true,
        payout:   payout.toFixed(2),
      });
      context.io.to(`user:${updated.user_id}`).emit('order_update', {
        orderId,
        status: 'driver_assigned',
      });
    }

    // Push notification for backgrounded user (HIGH-12)
    if (updated.user_id) {
      const { notifyUserOrderUpdate } = require('./notificationService');
      await notifyUserOrderUpdate(updated.user_id, orderId, 'driver_assigned').catch(() => {});
    }

    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function requeueOrderForDriverSearch(orderId, context = {}, externalClient = null) {
  const client  = externalClient || await pool.connect();
  const io      = context.io;
  const actorId   = context.actorId   || null;
  const actorRole = context.actorRole || 'system';

  try {
    if (!externalClient) {
      await client.query('BEGIN');
    }

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );

    if (!orderResult.rows.length) throw new Error('Order not found');

    const order        = orderResult.rows[0];
    const currentState = normalizeState(order.status);

    if (!['driver_assigned', 'driver_arrived_store'].includes(currentState)) {
      throw new Error(`Order cannot be re-queued from ${currentState}`);
    }

    if (actorRole === 'driver' && String(order.driver_id) !== String(actorId)) {
      throw new Error('Driver cannot re-queue this order');
    }

    logTransition(orderId, currentState, 'waiting_for_driver', actorRole, actorId);

    const updatedResult = await client.query(
      `UPDATE orders
       SET driver_id = NULL,
           status = 'waiting_for_driver',
           delivery_payment_status = 'pending_driver',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId],
    );

    if (!externalClient) {
      await client.query('COMMIT');
    }

    const updatedOrder = updatedResult.rows[0];

    // Same rule as updateOrderStatus: when joining a caller's transaction,
    // the caller emits after its own COMMIT succeeds, not us.
    if (!externalClient) {
      emitOrderUpdate(io, orderId, updatedOrder.user_id, updatedOrder.status);
    }

    return updatedOrder;
  } catch (err) {
    if (!externalClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (!externalClient) {
      client.release();
    }
  }
}

module.exports = {
  ORDER_STATES,
  ALLOWED_TRANSITIONS,
  normalizeState,
  canTransition,
  updateOrderStatus,
  assignDriver,
  requeueOrderForDriverSearch,
  emitOrderUpdate,
  notifyOrderStatusChange,
};
