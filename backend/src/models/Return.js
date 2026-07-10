const BaseModel = require("./BaseModel");
const RefundService = require("../services/refundService");

// Flat single-store return fee. Flash currently has exactly one physical
// store/warehouse (FLASH_STORE_LOCATION, orderController.js) — there is no
// multi-vendor "stores" concept anywhere in this codebase, so a per-store
// fee tier has nowhere to attach yet. Kept as a plain constant (not a DB
// column default) so a future multi-store fee calculation lives entirely in
// application code with zero schema change required.
const RETURN_FEE = 100.0;
const ELIGIBILITY_WINDOW_HOURS = 48;

class Return extends BaseModel {
  // Item-level return request: customer selects specific order_items and a
  // quantity for each (capped at what was originally purchased), replacing
  // the old whole-order-only model. Eligibility is anchored to orders
  // .delivered_at (an order that reached 'delivered'/'completed' before this
  // column existed has delivered_at = NULL, and is treated as NOT eligible —
  // there's no way to verify its window, and silently allowing it through
  // would reintroduce the exact "no timestamp check" gap this column fixes).
  static async requestReturn(orderId, userId, items, reason, io) {
    return await this.transaction(async (client) => {
      const orderResult = await client.query(
        `SELECT id, status, user_id, delivered_at FROM orders WHERE id = $1`,
        [orderId],
      );

      if (!orderResult.rows.length) {
        throw new Error("Order not found");
      }

      const order = orderResult.rows[0];
      if (order.user_id !== userId) {
        throw new Error("Not your order");
      }

      if (!["delivered", "completed"].includes(order.status)) {
        throw new Error("Can only return delivered orders");
      }

      if (!order.delivered_at) {
        throw new Error("Return eligibility cannot be verified for this order");
      }

      const windowCheck = await client.query(
        `SELECT (NOW() - $1::timestamptz) <= INTERVAL '${ELIGIBILITY_WINDOW_HOURS} hours' AS within_window`,
        [order.delivered_at],
      );
      if (!windowCheck.rows[0].within_window) {
        throw new Error("Return window has expired");
      }

      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("At least one item must be selected for return");
      }

      // Validate every selected line belongs to this order and doesn't
      // exceed the originally-purchased quantity, snapshotting unit_price at
      // request time (not a live re-read later, so a price change after
      // this request doesn't silently alter what's owed).
      const orderItemIds = items.map((i) => i.order_item_id);
      const ownedItems = await client.query(
        `SELECT id, quantity, unit_price FROM order_items
         WHERE order_id = $1 AND id = ANY($2::uuid[])`,
        [orderId, orderItemIds],
      );
      const ownedById = new Map(ownedItems.rows.map((r) => [r.id, r]));

      let itemsSubtotal = 0;
      const lineItems = [];
      for (const { order_item_id, quantity_returned } of items) {
        const owned = ownedById.get(order_item_id);
        if (!owned) {
          throw new Error("One or more selected items do not belong to this order");
        }
        const qty = parseInt(quantity_returned, 10);
        if (!Number.isInteger(qty) || qty <= 0) {
          throw new Error("Quantity returned must be a positive whole number");
        }
        if (qty > owned.quantity) {
          throw new Error("Cannot return more than the originally purchased quantity");
        }
        const unitPrice = parseFloat(owned.unit_price);
        const lineRefund = Math.round(unitPrice * qty * 100) / 100;
        itemsSubtotal += lineRefund;
        lineItems.push({ order_item_id, quantity_returned: qty, unit_price: unitPrice, lineRefund });
      }

      if (itemsSubtotal < RETURN_FEE) {
        throw new Error(
          `Selected items must total at least R${RETURN_FEE.toFixed(2)} to submit a return`,
        );
      }

      const refundAmount = Math.round((itemsSubtotal - RETURN_FEE) * 100) / 100;

      const result = await client.query(
        `INSERT INTO return_requests (order_id, user_id, reason, fee_amount, refund_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_id) DO NOTHING RETURNING *`,
        [orderId, userId, reason || null, RETURN_FEE, refundAmount],
      );

      if (!result.rows.length) {
        throw new Error("Return already requested");
      }

      const returnRow = result.rows[0];

      for (const line of lineItems) {
        await client.query(
          `INSERT INTO return_request_items (return_id, order_item_id, quantity_returned, unit_price, line_refund_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [returnRow.id, line.order_item_id, line.quantity_returned, line.unit_price, line.lineRefund],
        );
      }

      if (io) {
        io.to(`user:${userId}`).emit("return_requested", {
          returnId: returnRow.id,
          orderId,
          feeAmount: RETURN_FEE,
          refundAmount,
        });
      }

      return { ...returnRow, items: lineItems };
    });
  }

  // Admin authorizes pickup — creates the reverse-delivery order for a
  // driver to physically collect the item(s) and bring them back to the
  // store. This does NOT refund anything; refund only fires later, via
  // finalizeRefund, once the reverse order is independently confirmed
  // delivered. No order_items are created for the reverse order — item
  // detail lives in return_request_items, the single source of truth,
  // rather than being duplicated into a second table.
  static async approveReturn(returnId, adminId) {
    return await this.transaction(async (client) => {
      const returnResult = await client.query(
        `SELECT rr.*, o.user_id, o.store_id, o.delivery_fee,
                o.pickup_address, o.dropoff_address,
                o.pickup_lat, o.pickup_lng, o.dropoff_lat, o.dropoff_lng
         FROM return_requests rr
         JOIN orders o ON o.id = rr.order_id
         WHERE rr.id = $1
         FOR UPDATE`,
        [returnId],
      );

      if (!returnResult.rows.length) {
        throw new Error("Return not found");
      }

      const ret = returnResult.rows[0];
      if (ret.status !== "requested") {
        throw new Error("Return request is not awaiting approval");
      }

      const originalOrder = await client.query(
        `SELECT order_number FROM orders WHERE id = $1`,
        [ret.order_id],
      );

      const source = originalOrder.rows[0];
      const returnOrderNumber = `${source.order_number}-RET-${Date.now().toString(36).toUpperCase()}`;
      const returnDeliveryFee = parseFloat(ret.delivery_fee || 90);
      const driverPayout = Math.round((returnDeliveryFee * 0.75 + 15) * 100) / 100;

      const createdOrder = await client.query(
        `INSERT INTO orders (
          order_number, user_id, status, delivery_mode, time_slot,
          subtotal, delivery_fee, total, driver_payout,
          store_id, payment_method, payment_status,
          delivery_payment_status, store_paid, driver_paid,
          is_return_order, parent_order_id,
          pickup_address, dropoff_address,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
        ) VALUES (
          $1, $2, 'waiting_for_driver', 'fleet', 'asap',
          0, $3, $3, $4,
          $5, 'store_account', 'paid',
          'pending_driver', true, false,
          true, $6,
          $7, $8,
          $9, $10, $11, $12
        ) RETURNING id, order_number, status`,
        [
          returnOrderNumber,
          ret.user_id,
          returnDeliveryFee,
          driverPayout,
          ret.store_id || null,
          ret.order_id,
          ret.dropoff_address,
          ret.pickup_address,
          ret.dropoff_lat,
          ret.dropoff_lng,
          ret.pickup_lat,
          ret.pickup_lng,
        ],
      );

      await client.query(
        `UPDATE return_requests
         SET status = 'approved',
             approved_at = NOW(),
             approved_by = $2,
             return_order_id = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [returnId, adminId || null, createdOrder.rows[0].id],
      );

      return {
        returnId,
        status: "approved",
        returnOrder: createdOrder.rows[0],
      };
    });
  }

  // Admin rejects the return — callable while still 'requested' (never
  // dispatched at all) or 'approved' (dispatched, with or without the
  // reverse order having been delivered yet). Deliberately does NOT touch
  // driver_wallets/driver_wallet_ledger under any circumstance — a driver
  // who completes the reverse-delivery leg is paid through the ordinary
  // order-completion path regardless of this decision (see
  // orderStateMachineService.js's delivered->completed handling, which
  // never reads return_requests.status).
  static async rejectReturn(returnId, adminId, rejectionReason) {
    return await this.transaction(async (client) => {
      const returnResult = await client.query(
        `SELECT * FROM return_requests WHERE id = $1 FOR UPDATE`,
        [returnId],
      );

      if (!returnResult.rows.length) {
        throw new Error("Return not found");
      }

      const ret = returnResult.rows[0];
      if (!["requested", "approved"].includes(ret.status)) {
        throw new Error("Return request is not in a rejectable state");
      }

      const updated = await client.query(
        `UPDATE return_requests
         SET status = 'rejected',
             rejected_at = NOW(),
             rejected_by = $2,
             rejection_reason = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [returnId, adminId || null, rejectionReason || null],
      );

      return updated.rows[0];
    });
  }

  // Admin finalizes the refund — only reachable once the return is
  // 'approved' AND its reverse-delivery order has independently reached
  // 'completed' (the driver has physically brought the item back). This is
  // the "real confirmation step" the refund is gated on. Calls
  // RefundService.refundOrderPayment with the pre-computed, fee-netted
  // refund_amount as an override — never the full original payment.
  static async finalizeRefund(returnId, adminId) {
    const returnResult = await this.query(
      `SELECT rr.*, o.status AS return_order_status
       FROM return_requests rr
       JOIN orders o ON o.id = rr.return_order_id
       WHERE rr.id = $1`,
      [returnId],
    );

    if (!returnResult.rows.length) {
      throw new Error("Return not found");
    }

    const ret = returnResult.rows[0];
    if (ret.status !== "approved") {
      throw new Error("Return request is not awaiting final review");
    }
    if (ret.return_order_status !== "completed") {
      throw new Error("Reverse-delivery order has not been completed yet");
    }

    const refund = await RefundService.refundOrderPayment(
      ret.order_id,
      ret.user_id,
      "return_refund",
      parseFloat(ret.refund_amount),
    );

    await this.query(
      `UPDATE return_requests SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [returnId],
    );

    return { returnId, status: "refunded", refund };
  }

  // There is no admin dashboard/app anywhere in this codebase — this is
  // currently the only way to discover a return exists and needs action at
  // all. Covers both stages of the loop: brand-new 'requested' returns
  // still needing an initial approve/reject (dispatch) decision, and
  // already-'approved' ones awaiting final review — distinguished via
  // return_order_status (null until dispatched, then in-transit vs
  // 'completed' and ready for the final refund/reject call).
  static async getPendingForAdmin() {
    const result = await this.query(
      `SELECT rr.*, o.order_number, ro.status AS return_order_status, ro.order_number AS return_order_number
       FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       LEFT JOIN orders ro ON ro.id = rr.return_order_id
       WHERE rr.status IN ('requested', 'approved')
       ORDER BY rr.created_at ASC`,
    );
    return result.rows;
  }

  static async getCredits(userId) {
    const result = await this.query(
      `SELECT id, amount, balance, reason, expires_at, created_at
       FROM store_credits
       WHERE user_id=$1 AND balance > 0 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [userId],
    );

    const total = result.rows.reduce(
      (sum, c) => sum + parseFloat(c.balance),
      0,
    );
    return { credits: result.rows, totalBalance: total.toFixed(2) };
  }

  static async getUserReturns(userId) {
    const result = await this.query(
      `SELECT rr.*, o.order_number, o.subtotal,
              json_agg(json_build_object(
                'order_item_id', rri.order_item_id,
                'quantity_returned', rri.quantity_returned,
                'unit_price', rri.unit_price,
                'line_refund_amount', rri.line_refund_amount
              )) FILTER (WHERE rri.id IS NOT NULL) AS items
       FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       LEFT JOIN return_request_items rri ON rri.return_id = rr.id
       WHERE rr.user_id=$1
       GROUP BY rr.id, o.order_number, o.subtotal
       ORDER BY rr.created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}

module.exports = Return;
