'use strict';

/**
 * sosController.js
 *
 * One-tap SOS/safety action, available to both customer and driver during
 * an active delivery — deliberately simple (one insert, one admin alert),
 * since this needs to work reliably under stress rather than be
 * feature-rich. No separate workflow/status machine: sos_alerts rows have
 * an acknowledged_at/acknowledged_by pair ready for whenever an admin
 * interface exists to use them, but building a full acknowledgment
 * workflow with no admin UI to call it from would be premature scope.
 */

const db = require('../config/database');
const SosAlert = require('../models/SosAlert');
const { sendSosAlertEmail } = require('../services/emailService');

class SosController {
  static async trigger(req, res) {
    const { orderId } = req.params;
    const { lat, lng } = req.body;
    const io = req.app.get('io');

    try {
      const orderResult = await db.query(
        `SELECT id, order_number, user_id, driver_id, status, pickup_address, dropoff_address
         FROM orders WHERE id = $1`,
        [orderId],
      );
      if (!orderResult.rows.length) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = orderResult.rows[0];

      const allowed =
        (req.userRole === 'user' && String(order.user_id) === String(req.userId)) ||
        (req.userRole === 'driver' && String(order.driver_id) === String(req.userId));
      if (!allowed) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const alert = await SosAlert.create(orderId, req.userRole, req.userId, lat, lng);

      if (io) {
        io.to('admin').emit('sos_alert', {
          id: alert.id,
          orderId,
          triggeredByRole: req.userRole,
          triggeredById: req.userId,
          lat: alert.lat,
          lng: alert.lng,
          pickupAddress: order.pickup_address,
          dropoffAddress: order.dropoff_address,
          orderStatus: order.status,
          createdAt: alert.created_at,
          message: `SOS triggered by ${req.userRole} on order ${orderId}`,
        });
      } else {
        console.error(`[SOS] ALERT with no io instance available — orderId=${orderId} role=${req.userRole} userId=${req.userId}`);
      }

      // Fired without awaiting — the in-app "help is on the way" response
      // below must never wait on an SMTP round trip. The .catch() here
      // means a bug in the email path can NEVER affect the response a user
      // in a real emergency is waiting on. Addendum 2 §4's own notification
      // tiering named this the single most important item to wire up first,
      // ahead of every other return/cancellation/threshold notification
      // named alongside it.
      sendSosAlertEmail({
        alertId: alert.id,
        orderId,
        orderNumber: order.order_number,
        triggeredByRole: req.userRole,
        pickupAddress: order.pickup_address,
        dropoffAddress: order.dropoff_address,
        lat: alert.lat,
        lng: alert.lng,
      }).catch((emailErr) => console.error('[SOS] Failed to send alert email:', emailErr.message));

      return res.status(201).json({
        success: true,
        message: 'Help is on the way. Support has been notified.',
      });
    } catch (err) {
      console.error('[SOS] trigger error:', err.message);
      // A safety feature must never fail silently with just a generic error —
      // if the app itself can't get the alert through, the user needs to
      // know to fall back to calling emergency services directly.
      return res.status(500).json({
        error: 'Could not send SOS alert through the app. If you are in immediate danger, please call emergency services directly.',
      });
    }
  }
}

module.exports = SosController;
