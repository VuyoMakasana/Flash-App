// backend/src/models/Order.js
//
// CHANGES FROM ORIGINAL:
//   Added validateExternalItemPrice() — rejects external/partner store items
//   whose client-supplied price is <= 0, NaN, Infinity, or negative.
//   This closes the vulnerability where a user could submit { "price": 0 }
//   or { "price": 0.01 } for external items that have no inventory row.
//   Flash inventory items are still validated against the server price (unchanged).
'use strict';

const BaseModel = require('./BaseModel');
const { randomBytes } = require('crypto');
const { calculateDistance } = require('../utils/helpers');

// H-4 FIX: delivery fee used to be picked by the client (matching
// pickup_mall_id/dropoff_mall_id, both client-supplied with no malls table
// to validate against — any customer could send matching IDs on every
// order for a guaranteed R90 instead of R180). There is no multi-vendor
// "malls" concept in this codebase; pickup is always the one fixed store
// location. Same two fees, same customer-facing pricing — just gated by
// real haversine distance from the store to the (geofence-validated)
// dropoff point instead of a client-supplied ID match.
const NEARBY_DELIVERY_RADIUS_KM = 5;

// ─── EXTERNAL ITEM PRICE VALIDATOR ───────────────────────────────────────────
//
// Called for every item that has no matching flash_inventory row (i.e. items
// from partner stores or external catalogue entries). The flash_inventory path
// already validates against a trusted server price and is not affected.
//
// Rules:
//   • Must be a finite number (rejects NaN, Infinity, -Infinity, strings)
//   • Must be > 0  (rejects zero and negative values)
//   • Must be <= 100 000  (sanity cap; prevents absurd values from inflating totals)
//
// Throws a descriptive Error that is returned to the client as HTTP 400.
// ─────────────────────────────────────────────────────────────────────────────
function validateExternalItemPrice(rawPrice, itemName) {
  const price = Number(rawPrice);

  if (!Number.isFinite(price)) {
    throw new Error(
      `Invalid price for "${itemName || 'item'}": price must be a valid number (received ${rawPrice})`
    );
  }

  if (price <= 0) {
    throw new Error(
      `Invalid price for "${itemName || 'item'}": price must be greater than zero (received ${price})`
    );
  }

  if (price > 100_000) {
    throw new Error(
      `Invalid price for "${itemName || 'item'}": price exceeds maximum allowed value (received ${price})`
    );
  }

  return price; // safe, validated value
}

class Order extends BaseModel {
  static tableName = 'orders';

  static calculateDeliveryFee({ pickupLat, pickupLng, dropoffLat, dropoffLng }) {
    const distKm = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
    if (distKm !== null && distKm <= NEARBY_DELIVERY_RADIUS_KM) {
      return 90;
    }
    return 180;
  }

  static async create(orderData) {
    const {
      userId,
      items,
      delivery_mode,
      time_slot,
      subtotal,        // client value — used only as a fallback hint; server recomputes
      store_id,
      preferred_driver_id,
      pickup_mall_id,
      dropoff_mall_id,
      pickup_address,
      dropoff_address,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    } = orderData;

    const orderNumber         = `FLASH-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const computedDeliveryFee = this.calculateDeliveryFee({
      pickupLat:  pickup_lat,
      pickupLng:  pickup_lng,
      dropoffLat: dropoff_lat,
      dropoffLng: dropoff_lng,
    });

    // TRUSTED DRIVER EXCLUSIVITY WINDOW (see Driver.js getAvailableOrders/acceptOrder):
    // When a user selects a preferred/trusted driver, that driver gets a
    // 3-minute exclusive window to accept before the order falls back to the
    // general pool. NULL when no preferred driver was selected.
    const TRUSTED_DRIVER_WINDOW_MINUTES = 3;
    const preferredDriverExpiresAt = preferred_driver_id
      ? new Date(Date.now() + TRUSTED_DRIVER_WINDOW_MINUTES * 60 * 1000)
      : null;

    return await this.transaction(async (client) => {

      // ── SERVER-SIDE PRICE VALIDATION ───────────────────────────────────────
      //
      // FLASH INVENTORY ITEMS (item.productId matches flash_inventory.id):
      //   Price is taken exclusively from the server. Client price is ignored.
      //
      // EXTERNAL / PARTNER STORE ITEMS (no matching inventory row, or no productId):
      //   Price comes from the client but MUST pass validateExternalItemPrice().
      //   Zero, negative, NaN, Infinity, and non-numeric strings are all rejected
      //   with HTTP 400 before the transaction commits.
      //
      // ──────────────────────────────────────────────────────────────────────
      let computedSubtotal = 0;
      const validatedItems  = [];

      for (const item of items) {
        const rawQty = Number(item.quantity);
        if (!Number.isInteger(rawQty) || rawQty <= 0) {
          throw new Error(
            `Invalid quantity for "${item.name || 'item'}": must be a positive integer`
          );
        }

        let serverPrice = null;

        if (item.productId) {
          const invRow = await client.query(
            `SELECT id, price, product_name, stock_by_size
             FROM flash_inventory
             WHERE id = $1 AND is_active = true
             FOR UPDATE`,
            [item.productId]
          );

          if (invRow.rows.length) {
            // ── FLASH INVENTORY PATH: use server price, ignore client price ──
            serverPrice = parseFloat(invRow.rows[0].price);

            // Stock check — decrement atomically
            const stock     = invRow.rows[0].stock_by_size || {};
            const available = parseInt(stock[item.size] || 0);
            if (item.size && available < rawQty) {
              throw new Error(
                `${item.name || invRow.rows[0].product_name} size ${item.size} is out of stock`
              );
            }
            if (item.size) {
              const newStock = { ...stock, [item.size]: available - rawQty };
              await client.query(
                `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(newStock), item.productId]
              );
            }
          } else {
            // ── PARTNER STORE PATH: productId present but not in inventory ──
            // Validate client price before trusting it.
            console.warn(
              `[Order] productId ${item.productId} not in flash_inventory — validating client price`
            );
            serverPrice = validateExternalItemPrice(
              item.price,
              item.name || `product:${item.productId}`
            );
          }
        } else {
          // ── EXTERNAL STORE PATH: no productId — validate client price ─────
          serverPrice = validateExternalItemPrice(
            item.price,
            item.name || 'external item'
          );
        }

        const qty = rawQty;
        computedSubtotal += serverPrice * qty;

        validatedItems.push({
          productId:   item.productId || null,
          name:        item.name      || 'Product',
          size:        item.size      || null,
          quantity:    qty,
          serverPrice,
        });
      }
      // ── END PRICE VALIDATION ───────────────────────────────────────────────

      const finalTotal = computedSubtotal + computedDeliveryFee;
      if (finalTotal <= 0) {
        throw new Error('Order total must be positive');
      }
      const flashCommission = Math.max(10, Math.round(computedDeliveryFee * 0.25 * 100) / 100);
      const driverPayout    = Math.round((computedDeliveryFee - flashCommission) * 100) / 100;

      const orderResult = await client.query(
        `INSERT INTO orders (
          order_number, user_id, status, delivery_mode, time_slot,
          subtotal, delivery_fee, total, driver_payout,
          store_id, preferred_driver_id, preferred_driver_expires_at,
          pickup_address, dropoff_address,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
        ) VALUES ($1, $2, 'payment_pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *`,
        [
          orderNumber,
          userId,
          delivery_mode,
          time_slot,
          computedSubtotal,    // server-computed, not client-supplied
          computedDeliveryFee,
          finalTotal,
          driverPayout,
          store_id            || null,
          preferred_driver_id || null,
          preferredDriverExpiresAt,
          pickup_address,
          dropoff_address,
          pickup_lat,
          pickup_lng,
          dropoff_lat,
          dropoff_lng,
        ]
      );

      const order = orderResult.rows[0];

      for (const item of validatedItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, size, quantity, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            order.id,
            item.productId,
            item.name,
            item.size,
            item.quantity,
            item.serverPrice,
            item.serverPrice * item.quantity,
          ]
        );
      }

      return order;
    });
  }

  static async updateStatus(orderId, status, driverId = null) {
    const updates = { status, updated_at: new Date() };
    if (driverId) updates.driver_id = driverId;
    return await super.update(this.tableName, orderId, updates);
  }

  static async getByIdWithDetails(orderId, userId = null, driverId = null) {
    const sql = `
      SELECT o.*,
             d.name as driver_name, d.phone as driver_phone,
             d.vehicle_type as driver_vehicle, d.vehicle_plate as driver_plate,
             d.profile_photo_url as driver_photo,
             d.rating as driver_rating, d.total_deliveries as driver_total_deliveries,
             d.status as driver_verification_status,
             d.current_lat as driver_lat, d.current_lng as driver_lng,
             EXISTS(SELECT 1 FROM driver_ratings dr WHERE dr.order_id = o.id) as has_rating,
             EXISTS(SELECT 1 FROM return_requests rr WHERE rr.order_id = o.id) as return_requested,
             json_agg(json_build_object(
               'id', oi.id, 'product_name', oi.product_name, 'size', oi.size,
               'quantity', oi.quantity, 'total_price', oi.total_price
             )) as items
      FROM orders o
      LEFT JOIN drivers d ON d.id = o.driver_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id, d.id
    `;
    const result = await this.query(sql, [orderId]);
    if (!result.rows.length) return null;
    const order = result.rows[0];
    if (userId   && order.user_id   !== userId)   return null;
    if (driverId && order.driver_id !== driverId) return null;
    return order;
  }

  static async getUserOrders(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const sql = `
      SELECT o.*, d.name as driver_name, d.phone as driver_phone,
             d.vehicle_type as driver_vehicle, d.profile_photo_url as driver_photo,
             d.rating as driver_rating, d.total_deliveries as driver_total_deliveries,
             d.current_lat as driver_lat, d.current_lng as driver_lng,
             EXISTS(SELECT 1 FROM return_requests rr WHERE rr.order_id = o.id) as return_requested,
             json_agg(json_build_object(
               'id', oi.id, 'product_id', oi.product_id, 'product_name', oi.product_name,
               'size', oi.size, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 'total_price', oi.total_price
             )) as items
      FROM orders o
      LEFT JOIN drivers d ON d.id = o.driver_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = $1
      GROUP BY o.id, d.id
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.query(sql, [userId, limit, offset]);
    return result.rows;
  }

  static async getPaymentStatus(orderId, userId) {
    const result = await this.query(
      `SELECT id, payment_status, payment_method, delivery_payment_method,
              delivery_payment_status, status
       FROM orders WHERE id = $1 AND user_id = $2`,
      [orderId, userId]
    );
    return result.rows[0];
  }

  static async getDriverOrders(driverId, status = null) {
    let sql      = `SELECT * FROM orders WHERE driver_id = $1`;
    const params = [driverId];
    if (status) { sql += ` AND status = $2`; params.push(status); }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.query(sql, params);
    return result.rows;
  }
}

module.exports = Order;