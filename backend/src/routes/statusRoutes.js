'use strict';

// L0.5b (#98): public kill-switch status. GET /api/status/features returns
// every switch's key, whether it's on (including an env "off" override) and
// its fixed customer message. Nothing else: no admin, reason or timestamps.
// The apps can use it for warning banners (L4); the founder can open it in a
// browser. Cached for 15 s, the same as the switches themselves.

const express = require('express');
const { featureSwitches } = require('../services/featureSwitches');

const router = express.Router();

router.get('/features', async (_req, res) => {
  try {
    const features = await featureSwitches.getStatus();
    res.set('Cache-Control', 'public, max-age=15');
    return res.json({ features });
  } catch (err) {
    console.error('[FeatureSwitch] status endpoint failed:', err.message);
    return res.status(500).json({ error: 'Could not load feature status.' });
  }
});

module.exports = router;
