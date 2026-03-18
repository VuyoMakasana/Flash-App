const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── FLEET INTELLIGENCE ENGINE ───────────────────────────────────────────────
// Analyses browsing clusters and alerts nearby drivers to reposition
async function runFleetIntelligence(io) {
  try {
    // Find browsing clusters: areas with 3+ users browsing same category in last 20 mins
    const clusters = await pool.query(`
      SELECT category, city,
             ROUND(AVG(lat)::numeric, 4) as center_lat,
             ROUND(AVG(lng)::numeric, 4) as center_lng,
             COUNT(DISTINCT user_id) as user_count,
             COUNT(*) as total_events
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '20 minutes'
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND category IS NOT NULL
      GROUP BY category, city
      HAVING COUNT(DISTINCT user_id) >= 3
      ORDER BY user_count DESC
      LIMIT 10
    `);

    for (const cluster of clusters.rows) {
      // Find available online drivers within 5km of cluster center
      const nearbyDrivers = await pool.query(`
        SELECT id, name, current_lat, current_lng,
               (6371 * acos(
                 cos(radians($1)) * cos(radians(current_lat)) *
                 cos(radians(current_lng) - radians($2)) +
                 sin(radians($1)) * sin(radians(current_lat))
               )) AS distance_km
        FROM drivers
        WHERE is_online = true
          AND status = 'approved'
          AND current_lat IS NOT NULL
          AND current_lng IS NOT NULL
        HAVING (6371 * acos(
          cos(radians($1)) * cos(radians(current_lat)) *
          cos(radians(current_lng) - radians($2)) +
          sin(radians($1)) * sin(radians(current_lat))
        )) < 5
        ORDER BY distance_km ASC
        LIMIT 3
      `, [cluster.center_lat, cluster.center_lng]);

      // Alert each nearby driver
      for (const driver of nearbyDrivers.rows) {
        if (io) {
          io.to(`driver:${driver.id}`).emit('fleet_alert', {
            type: 'reposition',
            category: cluster.category,
            city: cluster.city,
            center: { lat: parseFloat(cluster.center_lat), lng: parseFloat(cluster.center_lng) },
            userCount: cluster.user_count,
            distanceKm: parseFloat(driver.distance_km).toFixed(1),
            message: `${cluster.user_count} users browsing ${cluster.category} nearby — position yourself in ${cluster.city || 'this area'} for incoming orders.`,
          });
        }
      }
    }

    return clusters.rows;
  } catch (err) {
    console.error('[Fleet Intelligence] Error:', err.message);
    return [];
  }
}

// ─── GET CURRENT DEMAND CLUSTERS ─────────────────────────────────────────────
router.get('/clusters', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const clusters = await pool.query(`
      SELECT category, city,
             ROUND(AVG(lat)::numeric, 4) as center_lat,
             ROUND(AVG(lng)::numeric, 4) as center_lng,
             COUNT(DISTINCT user_id) as user_count
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '20 minutes'
        AND lat IS NOT NULL AND category IS NOT NULL
      GROUP BY category, city
      HAVING COUNT(DISTINCT user_id) >= 2
      ORDER BY user_count DESC
      LIMIT 10
    `);
    res.json({ clusters: clusters.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch clusters' });
  }
});

// ─── MANUAL TRIGGER (admin) ───────────────────────────────────────────────────
router.post('/run', authenticate, requireRole('admin'), async (req, res) => {
  const io = req.app.get('io');
  const clusters = await runFleetIntelligence(io);
  res.json({ success: true, clustersFound: clusters.length, clusters });
});

module.exports = router;
module.exports.runFleetIntelligence = runFleetIntelligence;
