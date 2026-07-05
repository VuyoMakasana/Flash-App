const pool = require("../config/database");

// Flash Fleet demand-clustering is an internal ops/admin analytics tool —
// it must never be visible to drivers or trigger a driver-facing
// notification. Cluster + nearby-driver data is reported to the 'admin'
// room only, as informational context for an ops decision (e.g. manually
// messaging drivers, running a promotion), never pushed to a driver
// directly.
async function runFleetIntelligence(io) {
  try {
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
      const nearbyDrivers = await pool.query(
        `
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
      `,
        [cluster.center_lat, cluster.center_lng],
      );

      if (io && nearbyDrivers.rows.length) {
        io.to("admin").emit("fleet_alert", {
          type: "reposition",
          category: cluster.category,
          city: cluster.city,
          center: {
            lat: parseFloat(cluster.center_lat),
            lng: parseFloat(cluster.center_lng),
          },
          userCount: cluster.user_count,
          nearbyDrivers: nearbyDrivers.rows.map((d) => ({
            id: d.id,
            name: d.name,
            distanceKm: parseFloat(d.distance_km).toFixed(1),
          })),
          message: `${cluster.user_count} users browsing ${cluster.category} near ${cluster.city || "this area"} — ${nearbyDrivers.rows.length} driver(s) nearby.`,
        });
      }
    }

    return clusters.rows;
  } catch (err) {
    console.error("[Fleet Intelligence] Error:", err.message);
    return [];
  }
}

module.exports = { runFleetIntelligence };
