// backend/src/models/Order.js
// FULL REPLACEMENT FILE — adds server-side price validation.
// Items from flash_inventory are validated against server price.
// Items from external stores (no matching inventory row) use client price
// but the subtotal is recomputed server-side from the items array.
'use strict';

const BaseModel = require('./BaseModel');
const { randomBytes } = require('crypto');

class Order extends BaseModel {
  static tableName = 'orders';

  static calculateDeliveryFee({ pickupMallId, dropoffMallId }) {
    if (pickupMallId && dropoffMallId && String(pickupMallId) === String(dropoffMallId)) {
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

    const orderNumber        = `FLASH-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const computedDeliveryFee = this.calculateDeliveryFee({ pickupMallId: pickup_mall_id, dropoffMallId: dropoff_mall_id });

    return await this.transaction(async (client) => {

      // ── SERVER-SIDE PRICE VALIDATION ────────────────────────────────────
      // For every item that has a productId, look up the authoritative price
      // from flash_inventory. If not found (external store item), fall back
      // to the client-supplied price and log a warning for monitoring.
      let computedSubtotal = 0;
      const validatedItems = [];

      for (const item of items) {
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
            serverPrice = parseFloat(invRow.rows[0].price);

            // Stock check — decrement atomically
            const stock     = invRow.rows[0].stock_by_size || {};
            const available = parseInt(stock[item.size] || 0);
            if (item.size && available < parseInt(item.quantity)) {
              throw new Error(`${item.name || invRow.rows[0].product_name} size ${item.size} is out of stock`);
            }
            if (item.size) {
              const newStock = { ...stock, [item.size]: available - parseInt(item.quantity) };
              await client.query(
                `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(newStock), item.productId]
              );
            }
          } else {
            // Product ID provided but not found in inventory — this could be
            // a partner store product. Use client price but log for review.
            console.warn(
              `[Order] productId ${item.productId} not in flash_inventory — using client price ${item.price}`
            );
            serverPrice = parseFloat(item.price || 0);
          }
        } else {
          // No productId — external/partner product. Use client price.
          serverPrice = parseFloat(item.price || 0);
        }

        const qty = parseInt(item.quantity) || 1;
        computedSubtotal += serverPrice * qty;

        validatedItems.push({
          productId:   item.productId || null,
          name:        item.name      || 'Product',
          size:        item.size      || null,
          quantity:    qty,
          serverPrice,
        });
      }
      // ── END PRICE VALIDATION ─────────────────────────────────────────────

      const finalTotal      = computedSubtotal + computedDeliveryFee;
      const flashCommission = Math.max(10, Math.round(computedDeliveryFee * 0.25 * 100) / 100);
      const driverPayout    = Math.round((computedDeliveryFee - flashCommission) * 100) / 100;

      const orderResult = await client.query(
        `INSERT INTO orders (
          order_number, user_id, status, delivery_mode, time_slot,
          subtotal, delivery_fee, total, driver_payout,
          store_id, preferred_driver_id,
          pickup_address, dropoff_address,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
        ) VALUES ($1, $2, 'payment_pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
          store_id          || null,
          preferred_driver_id || null,
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
             d.vehicle_type as driver_vehicle, d.profile_photo_url as driver_photo,
             d.rating as driver_rating, d.current_lat as driver_lat, d.current_lng as driver_lng,
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
             d.rating as driver_rating, d.current_lat as driver_lat, d.current_lng as driver_lng,
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
    let sql    = `SELECT * FROM orders WHERE driver_id = $1`;
    const params = [driverId];
    if (status) { sql += ` AND status = $2`; params.push(status); }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.query(sql, params);
    return result.rows;
  }
}

module.exports = Order;
