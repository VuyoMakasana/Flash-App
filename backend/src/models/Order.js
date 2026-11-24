// backend/src/models/Order.js
'use strict';

const BaseModel = require('./BaseModel');
const { randomBytes } = require('crypto');
const { calculateDistance } = require('../utils/helpers');
const UserBlock = require('./UserBlock');

// H-4 FIX: delivery fee used to be picked by the client (matching
// pickup_mall_id/dropoff_mall_id, both client-supplied with no malls table
// to validate against — any customer could send matching IDs on every
// order for a guaranteed R90 instead of R180). There is no multi-vendor
// "malls" concept in this codebase; pickup is always the one fixed store
// location. Same two fees, same customer-facing pricing — just gated by
// real haversine distance from the store to the (geofence-validated)
// dropoff point instead of a client-supplied ID match.
const NEARBY_DELIVERY_RADIUS_KM = 5;

// ─── EVERY ITEM MUST BE A REAL PRODUCT (C3, #94) ─────────────────────────────
//
// A client price is never trusted. Each item must name a real, active
// flash_inventory product whose store is active and approved (the same rule
// the storefront applies to stores, Store.listActive). Its price always comes
// from that row. There used to be an "external/partner item" path that took
// the client's price for any item with no productId, or with a productId
// matching no active product; it is gone.
//
// A productId that isn't a UUID is refused before touching the database: the
// uuid column would otherwise throw, and the customer would get a 500 (the
// app's offline demo products have ids like 'p1').
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The name is the client's own cart label (the product may not exist), so
// it's only echoed back, capped in length.
function itemNoLongerAvailable(item) {
  const name = String(item?.name || 'An item').slice(0, 80);
  return new Error(`"${name}" is no longer available. Please remove it from your cart.`);
}

// FI-113 (#94): sizes and stock.
//   Sized product (flash_inventory.sizes non-empty): the item must name one
//     of those sizes, and the stock check and decrement on stock_by_size
//     always run. Previously a missing or unknown size skipped both.
//   Sizeless product (sizes empty): stock isn't tracked (stock_by_size is
//     per size), so a fixed cap applies instead: at most
//     MAX_QUANTITY_SIZELESS of the product per order, counted across all
//     lines. A size sent for it is ignored (stored as NULL).
const MAX_QUANTITY_SIZELESS = 10;

// sizes / stock_by_size are jsonb, but older writes stored JSON strings
// (storeInventoryController._parseJsonField exists for the same reason).
function jsonField(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
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
      // store_id is deliberately NOT accepted from the caller any more -- it is
      // derived below from the locked flash_inventory reads, so no path (client
      // -supplied or controller-guessed) can attribute an order to a store that
      // does not own the goods in it.
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

      // ── SERVER-SIDE PRICE VALIDATION (C3, #94) ─────────────────────────────
      //
      // Every item must be a real, active flash_inventory product whose store
      // is active and approved (H4). Its price and name are taken from that
      // locked row; the client's price and name are never used. Anything else
      // refuses the whole basket with "... is no longer available" (HTTP 400).
      // ──────────────────────────────────────────────────────────────────────
      // Final admin-panel completion pass, §4 — the store-wide promotion's
      // discount_percent (Boost.createPromotion) now actually reduces price,
      // instead of just sitting in store_promotions unused. Only the best
      // (highest-percent) active promotion applies, computed once outside
      // the item loop rather than re-queried per item.
      const promoResult = await client.query(
        `SELECT discount_percent FROM store_promotions
         WHERE is_active = true AND discount_percent IS NOT NULL
           AND NOW() BETWEEN starts_at AND expires_at
         ORDER BY discount_percent DESC LIMIT 1`
      );
      const activeDiscountPercent = promoResult.rows.length
        ? parseInt(promoResult.rows[0].discount_percent, 10)
        : 0;

      let computedSubtotal = 0;
      const validatedItems  = [];
      // Which store(s) this order's inventory belongs to. Collected from the
      // same FOR UPDATE-locked reads below that validate price and decrement
      // stock, so attribution is derived from the authoritative row the order
      // is actually built from -- no extra query, no second lookup that could
      // disagree with it, and no race against a product being reassigned
      // mid-checkout.
      const inventoryStoreIds = new Set();
      // Running quantity per sizeless product, for MAX_QUANTITY_SIZELESS.
      const sizelessQuantities = new Map();

      for (const item of items) {
        const rawQty = Number(item.quantity);
        if (!Number.isInteger(rawQty) || rawQty <= 0) {
          throw new Error(
            `Invalid quantity for "${item.name || 'item'}": must be a positive integer`
          );
        }

        if (typeof item.productId !== 'string' || !UUID_RE.test(item.productId)) {
          throw itemNoLongerAvailable(item);
        }

        // FOR UPDATE OF flash_inventory: only the product row is locked; the
        // store check is a plain read of stores (the same rule as
        // Store.listActive).
        const invRow = await client.query(
          `SELECT id, price, product_name, sizes, stock_by_size, store_id
           FROM flash_inventory
           WHERE id = $1 AND is_active = true
             AND EXISTS (
               SELECT 1 FROM stores s
               WHERE s.id = flash_inventory.store_id
                 AND s.is_active = true AND s.status = 'approved'
             )
           FOR UPDATE OF flash_inventory`,
          [item.productId]
        );
        if (!invRow.rows.length) {
          throw itemNoLongerAvailable(item);
        }

        const product = invRow.rows[0];
        inventoryStoreIds.add(String(product.store_id));
        let serverPrice = parseFloat(product.price);
        if (activeDiscountPercent > 0) {
          serverPrice = Math.round(serverPrice * (1 - activeDiscountPercent / 100) * 100) / 100;
        }

        // Sizes and stock (FI-113). The row is locked FOR UPDATE, and a later
        // line for the same product re-reads it inside this transaction, so
        // it sees the stock an earlier line already took.
        const sizes = jsonField(product.sizes, []);
        const isSized = Array.isArray(sizes) && sizes.length > 0;
        let size = null;
        if (isSized) {
          size = typeof item.size === 'string' ? item.size.trim() : '';
          if (!size) {
            throw new Error(`Please choose a size for "${product.product_name}".`);
          }
          if (!sizes.map(String).includes(size)) {
            throw new Error(`"${product.product_name}" isn't available in size ${size.slice(0, 20)}.`);
          }
          const stock     = jsonField(product.stock_by_size, {}) || {};
          const available = parseInt(stock[size] || 0, 10);
          if (available < rawQty) {
            throw new Error(
              `${product.product_name} size ${size} is out of stock`
            );
          }
          const newStock = { ...stock, [size]: available - rawQty };
          await client.query(
            `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(newStock), item.productId]
          );
        } else {
          const soFar = (sizelessQuantities.get(product.id) || 0) + rawQty;
          if (soFar > MAX_QUANTITY_SIZELESS) {
            throw new Error(
              `You can order at most ${MAX_QUANTITY_SIZELESS} of "${product.product_name}" per order.`
            );
          }
          sizelessQuantities.set(product.id, soFar);
        }

        const qty = rawQty;
        computedSubtotal += serverPrice * qty;

        validatedItems.push({
          productId:   item.productId,
          name:        product.product_name,
          size,
          quantity:    qty,
          serverPrice,
        });
      }
      // ── END PRICE VALIDATION ───────────────────────────────────────────────

      // ── STORE ATTRIBUTION ──────────────────────────────────────────────────
      //
      // Derived per order from the items actually bought, NOT from a "first
      // active store" heuristic. The previous behaviour (the controller's
      // resolveDefaultStoreId -> SELECT id FROM stores WHERE is_active LIMIT 1)
      // was correct only while exactly one store existed: with two, every order
      // would be attributed to whichever store happened to sort first, and once
      // store payouts exist that misattributes real money.
      //
      //   exactly one store        -> that store. (Every item is now a real
      //     product with a store, so there is always at least one; C3, #94.)
      //   more than one store      -> rejected, see below.
      //
      // Splitting a mixed-store cart into per-store orders is deliberately out
      // of scope here. The only alternative to rejecting is to pick one store
      // and silently misattribute the rest of the basket's value -- precisely
      // the money-misrouting this change exists to remove. Rejecting is a no-op
      // against today's single-store data and leaves real splitting open later.
      if (inventoryStoreIds.size > 1) {
        throw new Error(
          'Your basket contains items from more than one store. Please order from one store at a time.'
        );
      }
      const derivedStoreId = inventoryStoreIds.size === 1
        ? [...inventoryStoreIds][0]
        : null;

      // Flash Premium (R99/mo) perk, approved 25% off the delivery fee,
      // uncapped: delivery_fee/driver_payout/flashCommission below are all
      // still derived from computedDeliveryFee (the full, undiscounted tier
      // value) exactly as before this feature existed -- the driver is paid
      // and Flash's gross commission is recorded identically regardless of
      // premium status. The discount only ever reduces what the customer is
      // actually billed (finalTotal), via a separate, explicitly-stored
      // premium_discount_applied column. This deliberately avoids discounting
      // the stored delivery_fee itself, which would silently zero out
      // cardOrderCommission in getFinancials() for premium orders and make
      // the real cost invisible instead of an explicit, reportable line.
      const premiumCheck = await client.query(
        `SELECT 1 FROM premium_subscriptions WHERE user_id=$1 AND status='active' AND expires_at>NOW()`,
        [userId],
      );
      const isPremiumCustomer = premiumCheck.rows.length > 0;
      const premiumDiscountApplied = isPremiumCustomer
        ? Math.round(computedDeliveryFee * 0.25 * 100) / 100
        : 0;

      const finalTotal = computedSubtotal + computedDeliveryFee - premiumDiscountApplied;
      if (finalTotal <= 0) {
        throw new Error('Order total must be positive');
      }
      const flashCommission = Math.max(10, Math.round(computedDeliveryFee * 0.25 * 100) / 100);
      const driverPayout    = Math.round((computedDeliveryFee - flashCommission) * 100) / 100;

      const orderResult = await client.query(
        `INSERT INTO orders (
          order_number, user_id, status, delivery_mode, time_slot,
          subtotal, delivery_fee, total, driver_payout, premium_discount_applied,
          store_id, preferred_driver_id, preferred_driver_expires_at,
          pickup_address, dropoff_address,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
        ) VALUES ($1, $2, 'payment_pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
          premiumDiscountApplied,
          derivedStoreId,
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

  // Reverses exactly what create()'s FOR UPDATE-locked decrement removed
  // for this order's flash_inventory items — called whenever an order is
  // genuinely no longer going to be fulfilled (cancelled via the state
  // machine, or a payment that never succeeded in the first place). Must
  // run inside the caller's own transaction/client so the restock and the
  // status/payment change that triggers it commit or roll back together.
  //
  // Mirrors create()'s own decrement condition exactly: only order_items
  // with a real product_id AND a size were ever decremented (external/
  // partner items and sizeless flash_inventory items were not touched at
  // create() time either), so restocking anything else would restore
  // stock that was never actually taken. A flash_inventory row that no
  // longer exists (product deleted since the order was placed) has
  // nothing real to restock into — logged, not silently swallowed, so a
  // genuine "where did this stock go" question has a trail.
  static async restockItems(orderId, client) {
    const itemsResult = await client.query(
      `SELECT product_id, size, quantity FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL AND size IS NOT NULL`,
      [orderId],
    );

    for (const item of itemsResult.rows) {
      const invResult = await client.query(
        `SELECT stock_by_size FROM flash_inventory WHERE id = $1 FOR UPDATE`,
        [item.product_id],
      );
      if (!invResult.rows.length) {
        console.warn(`[Order] restockItems: product ${item.product_id} no longer exists, skipping restock for order ${orderId}`);
        continue;
      }
      const stock    = invResult.rows[0].stock_by_size || {};
      const current  = parseInt(stock[item.size] || 0, 10);
      const restored = { ...stock, [item.size]: current + item.quantity };
      await client.query(
        `UPDATE flash_inventory SET stock_by_size = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(restored), item.product_id],
      );
    }
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
             -- drivers.updated_at is timestamp WITHOUT time zone (a
             -- pre-existing schema inconsistency, flagged separately, not
             -- fixed column-wide here). Its stored digits are genuinely
             -- UTC (this pool's session timezone is UTC, confirmed live,
             -- same as every other connection to this DB), but sent as-is
             -- they are a bare, unmarked string -- a real phone's own
             -- local JS Date parser (e.g. a South African user's phone,
             -- SAST = UTC+2) treats an offset-less timestamp string as
             -- LOCAL time, silently shifting this specific value by 2
             -- hours. AT TIME ZONE 'UTC' re-tags those same correct digits
             -- as a real timestamptz, so any client anywhere parses it
             -- unambiguously. Scoped to just this one new field, not a
             -- column-wide migration.
             (d.updated_at AT TIME ZONE 'UTC') as driver_location_updated_at,
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

    // §2.7 audit — a block cuts off calling on this order immediately too,
    // not just chat. There's no masked-calling layer yet (deferred to the
    // pre-launch checklist, §2.2), so this can't erase a number the other
    // party may have already noted down before blocking -- but it stops
    // the app itself from displaying/re-serving it going forward, and the
    // mobile Call button hides itself once phone is missing.
    if (order.driver_id && (await UserBlock.isBlockedPair(order.user_id, order.driver_id))) {
      order.driver_phone = null;
    }
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

    // §2.7 audit — same phone redaction as getByIdWithDetails, batched: one
    // query for all of this customer's blocked driver ids (bounded by
    // their own block count, not this page's size or the platform's total
    // order/block volume), then a plain in-memory Set lookup per row --
    // never a per-row query, regardless of how many distinct drivers
    // appear across this page of orders.
    const blockedDriverIds = new Set(await UserBlock.getBlockedDriverIdsForUser(userId));
    if (blockedDriverIds.size) {
      result.rows.forEach((row) => {
        if (blockedDriverIds.has(row.driver_id)) row.driver_phone = null;
      });
    }

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