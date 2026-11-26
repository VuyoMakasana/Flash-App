'use strict';

// L0.5b (#98): route guard for a kill switch. When the switch is off the
// request is refused before the handler runs, with the approved shape:
//   503, Retry-After: 300, { error: <fixed message>, code: "FEATURE_OFF", feature: <key> }
// Today's apps already show `error` in their alert.
//
// Only put this on the routes listed in docs/KILL_SWITCHES.md. Never on
// webhooks, verification, reconciliation, refunds, cash OTP, cancellations or
// store order handling.

const { featureSwitches, FAIL_CLOSED, MESSAGES } = require('../services/featureSwitches');

function refuseFeature(res, key) {
  res.set('Retry-After', '300');
  return res.status(503).json({ error: MESSAGES[key], code: 'FEATURE_OFF', feature: key });
}

// Same answer as the cold-start rule if the check itself throws.
async function featureIsOn(key, switches = featureSwitches) {
  try {
    return await switches.isEnabled(key);
  } catch (err) {
    console.warn(`[FeatureSwitch] check for ${key} failed: ${err.message}`);
    return !FAIL_CLOSED.has(key);
  }
}

function requireFeature(key, switches = featureSwitches) {
  if (!MESSAGES[key]) throw new Error(`Unknown feature switch: ${key}`);
  const guard = async (req, res, next) => {
    if (await featureIsOn(key, switches)) return next();
    return refuseFeature(res, key);
  };
  guard.featureKey = key; // lets tests find which routes carry which switch
  return guard;
}

module.exports = { requireFeature, refuseFeature, featureIsOn };
