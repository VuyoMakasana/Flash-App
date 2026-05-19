/**
 * operatingHoursService.js
 *
 * Flash operates 07:00 – 19:00 SAST (UTC+2).
 * Orders placed outside those hours are held as 'scheduled_for_morning'
 * and released to drivers at 07:00 the following morning.
 *
 * All time comparisons use UTC internally. SAST = UTC+2.
 */

const OPEN_HOUR_UTC  = 5;   // 07:00 SAST = 05:00 UTC
const CLOSE_HOUR_UTC = 17;  // 19:00 SAST = 17:00 UTC

/**
 * Returns true if the current moment is within operating hours.
 */
function isWithinOperatingHours(now = new Date()) {
  const hour = now.getUTCHours();
  return hour >= OPEN_HOUR_UTC && hour < CLOSE_HOUR_UTC;
}

/**
 * Returns the next 07:00 SAST open time as a UTC Date.
 * If we are currently before 07:00, returns today's open time.
 * If we are after 19:00, returns tomorrow's open time.
 */
function getNextOpenTime(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(OPEN_HOUR_UTC, 0, 0, 0);
  if (now.getUTCHours() >= OPEN_HOUR_UTC) {
    // Already past or at open — schedule for next day
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/**
 * Returns true if the current moment is OUTSIDE operating hours.
 */
function isClosedNow(now = new Date()) {
  return !isWithinOperatingHours(now);
}

module.exports = { isWithinOperatingHours, isClosedNow, getNextOpenTime };