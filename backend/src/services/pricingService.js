'use strict';

/**
 * Flash Delivery Pricing Engine — South Africa
 *
 * Benchmarks:
 *   Uber Eats: R25–R45 base + R4–R6/km
 *   Mr D Food:  R15–R35 base + R3.5/km
 *   Flash (fashion, larger packages): R35 base + R8/km
 */

const BASE_FEE        = 35;   // ZAR minimum base
const PER_KM_RATE     = 8;    // ZAR per km
const PEAK_MULTIPLIER = 1.35; // 35% surge during peak hours
const EXTRA_STOP_FEE  = 25;   // ZAR per additional stop beyond first pickup
const HEAVY_ITEM_FEE  = 20;   // ZAR surcharge for heavy/bulky items
const MIN_FEE         = 65;   // ZAR floor (no order cheaper than this)
const MAX_FEE         = 500;  // ZAR ceiling

/**
 * Haversine formula: straight-line distance between two GPS coordinates.
 * Returns distance in kilometres.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

/**
 * Peak hours: 07:00–09:00 and 16:30–19:00 SAST (UTC+2).
 * Returns true when the current time falls inside a peak window.
 */
function isPeakHour() {
  const utcHour    = new Date().getUTCHours();
  const utcMinutes = new Date().getUTCMinutes();
  // Convert UTC to SAST (UTC+2)
  const sastMinutes = (utcHour * 60 + utcMinutes + 120) % (24 * 60);
  const h           = Math.floor(sastMinutes / 60);
  const m           = sastMinutes % 60;

  const morningPeak   = h >= 7 && h < 9;                         // 07:00–09:00
  const eveningPeak   = (h === 16 && m >= 30) || (h >= 17 && h < 19); // 16:30–19:00

  return morningPeak || eveningPeak;
}

/**
 * Calculate the delivery fee for a given route.
 *
 * @param {object} params
 * @param {number}  params.pickupLat       - Pickup latitude
 * @param {number}  params.pickupLng       - Pickup longitude
 * @param {number}  params.dropoffLat      - Dropoff latitude
 * @param {number}  params.dropoffLng      - Dropoff longitude
 * @param {number}  [params.extraStops=0]  - Number of additional pickup stops beyond the first
 * @param {boolean} [params.hasHeavyItems] - Whether the order contains heavy/bulky items
 * @returns {{ fee: number, breakdown: object }} Fee in ZAR and itemised breakdown
 */
function calculateDeliveryFee({
  pickupLat,
  pickupLng,
  dropoffLat,
  dropoffLng,
  extraStops   = 0,
  hasHeavyItems = false,
}) {
  // Validate coordinates — default to 5 km if anything is missing
  const distKm =
    pickupLat != null && pickupLng != null && dropoffLat != null && dropoffLng != null
      ? calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng)
      : 5;

  const distanceRounded = Math.round(distKm * 10) / 10; // one decimal

  let fee = BASE_FEE + distKm * PER_KM_RATE;

  const extraStopCharge  = extraStops  > 0 ? extraStops * EXTRA_STOP_FEE  : 0;
  const heavyItemCharge  = hasHeavyItems                ? HEAVY_ITEM_FEE  : 0;
  const peakSurchargeRaw = isPeakHour()                 ? fee * (PEAK_MULTIPLIER - 1) : 0;

  fee += extraStopCharge + heavyItemCharge;
  if (isPeakHour()) fee *= PEAK_MULTIPLIER;

  const finalFee = Math.max(MIN_FEE, Math.min(MAX_FEE, Math.round(fee)));

  return {
    fee: finalFee,
    breakdown: {
      baseFee:          BASE_FEE,
      distanceKm:       distanceRounded,
      distanceFee:      Math.round(distKm * PER_KM_RATE),
      extraStops,
      extraStopCharge,
      hasHeavyItems,
      heavyItemCharge,
      peakHour:         isPeakHour(),
      peakSurcharge:    Math.round(peakSurchargeRaw),
      total:            finalFee,
    },
  };
}

module.exports = {
  calculateDeliveryFee,
  calculateDistance,
  isPeakHour,
};
