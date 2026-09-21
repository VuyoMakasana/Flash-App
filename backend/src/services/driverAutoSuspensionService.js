'use strict';

const pool = require('../config/database');

// STUCK-DRIVER REASSIGNMENT + AUTO-SUSPENSION (coverage-remediation Phase 3)
//
// Extracted verbatim from the cron.schedule('*/10 * * * *', ...) callback
// that used to live inline in src/server.js (originally added because
// drivers could accept an order and go offline with no consequence,
// leaving orders stuck in driver_assigned/driver_arrived_store forever
// with no customer alert and no resolution) -- moved here, unchanged in
// substance, so it's independently unit-testable the same way
// paymentReconciliationJob.js's functions and
// orderStateMachineService.cancelAbandonedPaymentPendingOrders already are
// (see that function's own comment in server.js for the identical
// reasoning). server.js's cron.schedule callback is now a thin wrapper
// that requires and calls this function, exactly like those other jobs'
// wrappers.
//
// This is a REAL extraction, not a rewrite: every query, every condition,
// every comment explaining a real production decision (the transaction
// pattern, the 5-cancellation threshold, the best-effort penalty-row
// insert) is preserved as-is. The only functional change is that the
// Socket.IO instance is now a real parameter (`io`) instead of closing
// over server.js's module-scope `_io` variable -- required to make this
// callable from a test with no running server at all.
async function reassignStuckDriverOrders({ io } = {}) {
  // Find orders stuck in driver_assigned or driver_arrived_store for more than 45 minutes
  const stuckOrders = await pool.query(`
    SELECT o.id, o.driver_id, o.user_id, o.delivery_mode, o.status,
           o.driver_payout, o.delivery_fee,
           d.push_token as driver_push_token
    FROM orders o
    LEFT JOIN drivers d ON d.id = o.driver_id
    WHERE o.status IN ('driver_assigned', 'driver_arrived_store')
      AND o.updated_at < NOW() - INTERVAL '45 minutes'
      AND o.driver_id IS NOT NULL
  `);

  const { requeueOrderForDriverSearch } = require('./orderStateMachineService');
  const DriverWallet = require('../models/DriverWallet');

  for (const order of stuckOrders.rows) {
    try {
      // Requeue and the driver's pending-wallet reversal now share one
      // transaction (same externalClient pattern as
      // orderController.cancelOrder / driverController.cancelAssignedOrder)
      // — previously these were two separate transactions, so a crash
      // between them could reverse the driver's pending payout while the
      // order stayed assigned to a driver who just timed out, or requeue
      // the order while leaving pending_balance permanently uncorrected.
      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Re-queue through the state machine FIRST: this takes a row lock
        // and re-validates the order is still driver_assigned/driver_arrived_store,
        // so a driver's in-flight status update (e.g. just tapped "Picked Up")
        // can't be clobbered by this cron. If the order has already moved
        // on, this throws and the whole transaction rolls back below — no
        // penalty, no wallet change — because the driver did not actually
        // go unavailable.
        await requeueOrderForDriverSearch(
          order.id,
          { actorId: 'system', actorRole: 'system' },
          client,
        );

        if (payout > 0) {
          await DriverWallet.reversePending(
            client, order.driver_id, payout, order.id, 'driver_timeout_reassigned',
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Penalise the driver — increment cancel count
      await pool.query(
        `UPDATE drivers SET cancel_count = COALESCE(cancel_count, 0) + 1, updated_at = NOW() WHERE id = $1`,
        [order.driver_id]
      );

      // Auto-suspend driver if cancel count reaches 5
      const driverCheck = await pool.query(
        `SELECT cancel_count FROM drivers WHERE id = $1`, [order.driver_id]
      );
      if ((driverCheck.rows[0]?.cancel_count || 0) >= 5) {
        await pool.query(
          `UPDATE drivers SET is_online = false, status = 'suspended', updated_at = NOW() WHERE id = $1`,
          [order.driver_id]
        );
        console.warn(`[Cron] Driver ${order.driver_id} auto-suspended after 5 cancellations`);

        // §2.4 audit — previously only a console.warn, leaving no
        // admin-visible record of why/when a system auto-suspension
        // happened. An admin looking at a suspended driver's own detail
        // page (which already sums driver_penalties for that driver,
        // adminPanel.js) had no way to see this without digging through
        // server logs — real friction for dispute resolution ("why was
        // I suspended?"). amount=0 since this isn't a financial penalty,
        // just a real, dated, reasoned row. Best-effort and isolated in
        // its own catch — this is a record of an action that already
        // happened; a failure to write it must never block the customer
        // notification/reassignment steps still to come below.
        try {
          await pool.query(
            `INSERT INTO driver_penalties (driver_id, order_id, amount, reason, status)
             VALUES ($1, $2, 0, $3, 'applied')`,
            [
              order.driver_id,
              order.id,
              `Auto-suspended by system: cancel_count reached ${driverCheck.rows[0].cancel_count} after order ${order.id} was stuck in ${order.status} for over 45 minutes.`,
            ],
          );
        } catch (penaltyErr) {
          console.warn(`[Cron] Failed to record auto-suspension penalty row for driver ${order.driver_id}:`, penaltyErr.message);
        }
      }

      // Notify user with a friendlier message than the generic order_update.
      // Side effects here only fire after the transaction above has
      // committed (its own COMMIT/ROLLBACK already resolved above).
      if (io) {
        io.to(`user:${order.user_id}`).emit('order_update', {
          orderId: order.id,
          status: 'waiting_for_driver',
          message: 'Your driver became unavailable. Finding a new driver now.',
        });
      }

      // Attempt auto-reassign for fleet orders
      if (order.delivery_mode === 'fleet') {
        const { autoAssignNearestDriver } = require('./autoMatchService');
        await autoAssignNearestDriver(order.id, io).catch(() => null);
      }

      console.log(`[Cron] Auto-reassigned stuck order ${order.id} from driver ${order.driver_id}`);
    } catch (orderErr) {
      console.warn(`[Cron] Failed to reassign order ${order.id}:`, orderErr.message);
    }
  }
}

module.exports = { reassignStuckDriverOrders };
