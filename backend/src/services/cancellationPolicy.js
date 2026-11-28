'use strict';

/**
 * cancellationPolicy.js — PR G1 (#106)
 *
 * A customer's cancellation, as the live Terms say (flashdelivery.co.za/terms,
 * A9, read 2026-11-27), with the founder's decisions of 2026-11-27:
 *
 *   Before the store accepts, and while the store is still preparing:
 *     full refund (items + delivery fee).
 *   Ready (the store has prepared it), before the driver collects it:
 *     the full delivery fee, plus the items less a cancellation charge of up
 *     to 15% of the item value: 10% to the store, plus 5% to the driver once
 *     a driver is assigned (no driver, no driver share).
 *   After the driver collects it: no cancellation.
 *
 * Flash-side cancellations (no driver, store rejects, store never marks it
 * ready) are not customer cancellations: they always refund in full and
 * don't use this file.
 *
 * Shared by cancelOrder and its read-only preview, so the two can never
 * disagree on the numbers.
 */

const STORE_CHARGE_PCT = 0.10;
const DRIVER_CHARGE_PCT = 0.05;

// Statuses where a cancellation is a full refund. 'created' and
// 'scheduled_for_morning' were missing before G1, so a paid order parked
// overnight was cancelled with no refund at all.
const FULL_REFUND_STATES = [
  'created', 'payment_pending', 'paid', 'scheduled_for_morning', 'pending_store_acceptance', 'preparing',
];
// Ready, not yet collected: the charge applies.
const CHARGE_STATES = ['waiting_for_driver', 'driver_assigned', 'driver_arrived_store'];
// Collected or finished: no cancellation.
const NOT_CANCELLABLE_STATES = ['picked_up', 'in_transit', 'delivered', 'completed', 'cancelled'];

const round2 = (n) => Math.round(n * 100) / 100;

// The store share, the driver share and what goes back. The customer's item
// refund is the remainder, so the three always add up to exactly the item
// value with no rounding gap. A cash order hasn't paid anything yet, so
// nothing is kept or refunded; only the driver's compensation is real
// (paid by Flash for the wasted trip).
function computeCancellationSplit(order, { storePct = STORE_CHARGE_PCT, driverPct = DRIVER_CHARGE_PCT } = {}) {
  const itemValue = parseFloat(order.subtotal) || 0;
  const deliveryFee = parseFloat(order.delivery_fee) || 0;
  const isCash = order.payment_method === 'cash';

  const storeAmount = isCash ? 0 : round2(itemValue * storePct);
  const driverAmount = round2(itemValue * driverPct);
  const customerItemRefund = isCash ? 0 : round2(itemValue - storeAmount - driverAmount);
  const deliveryFeeRefund = isCash ? 0 : deliveryFee;

  return {
    itemValue,
    deliveryFee,
    isCash,
    storePct,
    driverPct,
    chargePct: round2(storePct + driverPct),
    storeAmount,
    driverAmount,
    customerItemRefund,
    deliveryFeeRefund,
    totalCustomerRefund: round2(customerItemRefund + deliveryFeeRefund),
  };
}

/**
 * @param {object} order a locked orders row (status already normalized)
 * @returns {{ cancellable: boolean, refundMode: 'full_refund'|'pre_pickup_split'|null,
 *             split: object|null, hasDriverAssigned: boolean }}
 */
function cancellationTermsFor(order) {
  const state = order.status;
  const hasDriverAssigned = Boolean(order.driver_id);

  if (NOT_CANCELLABLE_STATES.includes(state)) {
    return { cancellable: false, refundMode: null, split: null, hasDriverAssigned };
  }
  if (FULL_REFUND_STATES.includes(state)) {
    return { cancellable: true, refundMode: 'full_refund', split: null, hasDriverAssigned };
  }
  if (CHARGE_STATES.includes(state)) {
    const split = computeCancellationSplit(order, {
      storePct: STORE_CHARGE_PCT,
      driverPct: hasDriverAssigned ? DRIVER_CHARGE_PCT : 0,
    });
    // 'pre_pickup_split' (not a new name): order_cancellations.refund_mode is
    // VARCHAR(30), and paymentReconciliationJob already retries this mode
    // with the stored customer share.
    return { cancellable: true, refundMode: 'pre_pickup_split', split, hasDriverAssigned };
  }
  // A status this policy doesn't know: refuse rather than guess.
  return { cancellable: false, refundMode: null, split: null, hasDriverAssigned };
}

module.exports = {
  cancellationTermsFor,
  computeCancellationSplit,
  STORE_CHARGE_PCT,
  DRIVER_CHARGE_PCT,
  FULL_REFUND_STATES,
  CHARGE_STATES,
  NOT_CANCELLABLE_STATES,
};
