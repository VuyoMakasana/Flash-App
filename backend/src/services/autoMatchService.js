'use strict';

/**
 * autoMatchService.js
 *
 * Implements the customer-facing "Any Available Driver" checkout option
 * (orders.delivery_mode = 'fleet') — auto-assigns the nearest online,
 * available driver to an order once it's paid and waiting for a driver.
 *
 * Split out from fleetIntelligenceService.js, which is a completely
 * separate, admin-only demand-clustering/analytics tool. The two used to
 * share a file (and this feature's customer-facing copy used to say "Flash
 * Fleet", the same name as that admin tool) — a real naming collision risk,
 * not just a cosmetic one, given fleetIntelligenceService.js was previously
 * found reaching drivers when it shouldn't have (see fleetIntelligenceService.js's
 * own header comment). This function was always correctly customer-facing
 * and never touched the admin-only path, but keeping it in the same file
 * under a shared name made that far too easy to get wrong in the future.
 */

const pool = require("../config/database");
const { assignDriver } = require("./orderStateMachineService");

async function autoAssignNearestDriver(orderId, io) {
  const orderResult = await pool.query(
    `SELECT id, delivery_mode, status, preferred_driver_id, pickup_lat, pickup_lng
     FROM orders WHERE id = $1`,
    [orderId],
  );

  if (!orderResult.rows.length) return null;
  const order = orderResult.rows[0];
  if (order.delivery_mode !== "fleet" || order.preferred_driver_id) return null;
  if (order.status !== "waiting_for_driver") return null;

  const nearby = await pool.query(
    `SELECT d.id,
            (6371 * acos(
              cos(radians($1)) * cos(radians(d.current_lat)) *
              cos(radians(d.current_lng) - radians($2)) +
              sin(radians($1)) * sin(radians(d.current_lat))
            )) AS distance_km
     FROM drivers d
     WHERE d.is_online = true
       AND d.status = 'approved'
       AND d.current_lat IS NOT NULL
       AND d.current_lng IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.driver_id = d.id
           AND o.status IN ('driver_assigned', 'driver_arrived_store', 'picked_up', 'in_transit')
       )
     ORDER BY distance_km ASC
     LIMIT 1`,
    [order.pickup_lat, order.pickup_lng],
  );

  if (!nearby.rows.length) return null;

  return await assignDriver(orderId, nearby.rows[0].id, { io });
}

module.exports = { autoAssignNearestDriver };
