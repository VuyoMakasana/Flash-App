'use strict';

/**
 * geoBoundary.js
 *
 * Server-side enforcement that Flash only operates within Nelson Mandela Bay
 * (Gqeberha), Eastern Cape — the Play Store can restrict which countries can
 * install the app, but not which cities, so this has to be enforced in our
 * own code.
 *
 * Approach: a bounding box, not a radius or precise municipal polygon. NMB
 * is an elongated metro along the coast (Gqeberha/Port Elizabeth in the
 * east, Kariega/Despatch to the west, Coega to the northeast, ocean to the
 * south) — a radius wide enough to reach Kariega would also reach far out to
 * sea, and a precise polygon needs boundary data this environment has no way
 * to verify against a live map. A box is the simplest shape that's easy to
 * reason about and adjust.
 *
 * These coordinates are a best-effort draft from general geographic
 * knowledge, NOT verified against an authoritative source (e.g. the
 * municipality's own GIS boundary) — reviewed and approved as a starting
 * point, but flagged here again as something to double-check against a real
 * map before this becomes the actual production gate.
 */
const NMB_BOUNDS = {
  minLat: -34.05,
  maxLat: -33.70,
  minLng: 25.35,
  maxLng: 25.75,
};

function isWithinNelsonMandelaBay(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return false;
  return (
    latNum >= NMB_BOUNDS.minLat &&
    latNum <= NMB_BOUNDS.maxLat &&
    lngNum >= NMB_BOUNDS.minLng &&
    lngNum <= NMB_BOUNDS.maxLng
  );
}

const OUTSIDE_SERVICE_AREA_MESSAGE =
  'Flash currently only delivers within Nelson Mandela Bay (Gqeberha). This location is outside our service area.';

// TODO(user): replace with Flash's real store/warehouse pickup coordinate.
// There is no "malls"/store-location table anywhere in this codebase — every
// order is currently treated as picking up from this one fixed location
// rather than trusting client-supplied pickup coordinates for something that
// never changes. Placeholder is the Gqeberha city-center coordinate used
// elsewhere in this file's own worked examples — almost certainly NOT
// Flash's actual pickup address.
const FLASH_STORE_LOCATION = {
  lat: -33.958,
  lng: 25.600,
};

module.exports = {
  NMB_BOUNDS,
  isWithinNelsonMandelaBay,
  OUTSIDE_SERVICE_AREA_MESSAGE,
  FLASH_STORE_LOCATION,
};
