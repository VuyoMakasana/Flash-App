'use strict';

const BaseModel = require('./BaseModel');

/**
 * TrustedDriver model
 *
 * HIGH-2 FIX: sendTrustRequest now enforces:
 *   1. 7-day cooldown after a driver declines
 *   2. Max 10 pending requests per user
 *
 * MEDIUM-11 FIX: After emitting the Socket.IO event, sends a push
 *   notification so drivers receive the request even if their app is closed.
 */

class TrustedDriver extends BaseModel {
  static async getTrustedDrivers(userId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.total_deliveries,
              d.vehicle_type, d.vehicle_plate, d.profile_photo_url, d.is_online,
              d.status as driver_verification_status,
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','driver_arrived_store','picked_up','in_transit')
              ) as is_busy
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'accepted'
       ORDER BY td.created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  static async getPendingRequests(userId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.vehicle_type
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'pending'`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Send (or re-send) a trust request from a user to a driver.
   *
   * Guards:
   *   - Driver must exist and be approved
   *   - 7-day cooldown if driver previously declined
   *   - User may not have more than 10 pending requests total
   */
  static async sendTrustRequest(userId, driverId, io) {
    // 1. Verify driver exists and is approved
    const driver = await this.query(
      "SELECT id, name, push_token FROM drivers WHERE id=$1 AND status='approved'",
      [driverId],
    );
    if (!driver.rows.length) {
      throw new Error('Driver not found');
    }

    // 2. Check 7-day cooldown after a decline
    const cooldownCheck = await this.query(
      `SELECT updated_at FROM trusted_drivers
       WHERE user_id=$1 AND driver_id=$2 AND status='declined'
         AND updated_at > NOW() - INTERVAL '7 days'`,
      [userId, driverId],
    );
    if (cooldownCheck.rows.length) {
      const err = new Error('This driver declined your request recently. Please wait 7 days before trying again.');
      err.code = 'COOLDOWN';
      throw err;
    }

    // 3. Check pending request cap (max 10 pending per user)
    const pendingCount = await this.query(
      `SELECT COUNT(*) AS cnt FROM trusted_drivers
       WHERE user_id=$1 AND status='pending'`,
      [userId],
    );
    if (parseInt(pendingCount.rows[0].cnt, 10) >= 10) {
      const err = new Error('You have too many pending trusted driver requests. Wait for some to be responded to before sending more.');
      err.code = 'TOO_MANY_PENDING';
      throw err;
    }

    // 4. Insert or update (only allowed if not in cooldown)
    const result = await this.query(
      `INSERT INTO trusted_drivers (user_id, driver_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, driver_id) DO UPDATE
         SET status='pending', updated_at=NOW()
         WHERE trusted_drivers.status IN ('accepted')
       RETURNING *`,
      [userId, driverId],
    );

    // If the conflict row was 'declined' the DO UPDATE WHERE clause won't match,
    // so we upsert for cases where there's no existing row or it was 'accepted'
    // (re-request after removal). If result is empty, just insert fresh.
    let row;
    if (result.rows.length) {
      row = result.rows[0];
    } else {
      // No row returned means an existing 'declined' row blocked the upsert —
      // but we already checked cooldown above, so this shouldn't happen.
      // Insert fresh as a safety net:
      const insertResult = await this.query(
        `INSERT INTO trusted_drivers (user_id, driver_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (user_id, driver_id) DO UPDATE
           SET status='pending', updated_at=NOW()
         RETURNING *`,
        [userId, driverId],
      );
      row = insertResult.rows[0];
    }

    // 5. Real-time notification via Socket.IO
    if (io) {
      io.to(`driver:${driverId}`).emit('trust_request', {
        type: 'trust_request',
        requestId: row.id,
        userId,
        message: 'A customer wants to add you as a trusted driver',
      });
    }

    // 6. Push notification for backgrounded driver apps (MEDIUM-11)
    const driverRecord = driver.rows[0];
    if (driverRecord.push_token) {
      try {
        // H4 FIX: pushNotificationService.js only ever exported
        // sendDriverPushNotification — this destructure always resolved to
        // undefined, so every call here threw and was silently swallowed
        // below. notificationService.js is the correctly-wired service used
        // everywhere else in the codebase.
        const { sendPushNotification } = require('../services/notificationService');
        await sendPushNotification({
          tokens: driverRecord.push_token,
          title: 'New Trust Request',
          body: 'A customer wants to add you as a trusted driver',
          data: { type: 'trust_request', requestId: row.id },
        });
      } catch (pushErr) {
        console.warn('[TrustedDriver] Push notification failed:', pushErr.message);
      }
    }

    return row;
  }

  static async removeTrustedDriver(userId, driverId) {
    await this.query(
      'DELETE FROM trusted_drivers WHERE user_id=$1 AND driver_id=$2',
      [userId, driverId],
    );
  }

  static async getDriverRequests(driverId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              u.id as user_id, u.name as user_name
       FROM trusted_drivers td
       JOIN users u ON u.id = td.user_id
       WHERE td.driver_id = $1 AND td.status = 'pending'
       ORDER BY td.created_at DESC`,
      [driverId],
    );
    return result.rows;
  }

  static async respondToRequest(requestId, driverId, action, io) {
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    const result = await this.query(
      `UPDATE trusted_drivers SET status=$1, updated_at=NOW()
       WHERE id=$2 AND driver_id=$3
       RETURNING *`,
      [newStatus, requestId, driverId],
    );

    if (!result.rows.length) {
      throw new Error('Request not found');
    }

    const row = result.rows[0];
    const message =
      action === 'accept'
        ? 'A driver accepted your trusted driver request!'
        : 'A driver declined your trusted driver request.';

    if (io) {
      io.to(`user:${row.user_id}`).emit('trust_response', {
        driverId,
        status: newStatus,
        message,
      });
    }

    // Push notification fallback for backgrounded customer apps — mirrors
    // the push already sent to the driver in sendTrustRequest above, which
    // previously had no equivalent on this side of the exchange.
    try {
      const userResult = await this.query(
        'SELECT push_token FROM users WHERE id=$1',
        [row.user_id],
      );
      const pushToken = userResult.rows[0]?.push_token;
      if (pushToken) {
        const { sendPushNotification } = require('../services/notificationService');
        await sendPushNotification({
          tokens: pushToken,
          title: action === 'accept' ? 'Trust Request Accepted' : 'Trust Request Declined',
          body: message,
          data: { type: 'trust_response', driverId, status: newStatus },
        });
      }
    } catch (pushErr) {
      console.warn('[TrustedDriver] Push notification failed:', pushErr.message);
    }

    return { success: true, status: newStatus };
  }

  static async removeSelf(driverId, userId) {
    await this.query(
      'DELETE FROM trusted_drivers WHERE driver_id=$1 AND user_id=$2',
      [driverId, userId],
    );
  }

  static async checkDriverStatus(userId, driverId) {
    const result = await this.query(
      `SELECT d.id, d.name, d.is_online, d.rating, d.total_deliveries,
              d.vehicle_type, d.profile_photo_url,
              td.status as trust_status,
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','driver_arrived_store','picked_up','in_transit')
              ) as is_busy
       FROM drivers d
       LEFT JOIN trusted_drivers td
         ON td.driver_id = d.id AND td.user_id = $1
       WHERE d.id = $2`,
      [userId, driverId],
    );
    return result.rows[0];
  }
}

module.exports = TrustedDriver;
