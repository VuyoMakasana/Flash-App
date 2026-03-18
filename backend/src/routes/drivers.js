const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const { authenticate, requireRole, requireApprovedDriver } = require('../middleware/auth');

// Multer config - memory storage, then upload to S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, and PNG files are allowed'));
    }
  },
});

// Upload to S3 helper
async function uploadToS3(buffer, filename, mimetype) {
  // If AWS is not configured, store locally for dev
  if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === 'your_aws_access_key') {
    console.log(`[DEV] Would upload ${filename} to S3`);
    return `https://placeholder-s3-url.com/${filename}`;
  }

  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION });

  const key = `driver-docs/${Date.now()}-${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    ServerSideEncryption: 'AES256',
  }));

  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// ─────────────────────────────────────────
// GET DRIVER PROFILE
// ─────────────────────────────────────────
router.get('/me', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, vehicle_type, vehicle_plate, profile_photo_url,
              status, is_online, rating, total_deliveries, created_at
       FROM drivers WHERE id = $1`,
      [req.userId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Driver not found' });

    // Get document upload status
    const docs = await pool.query(
      'SELECT document_type, verified, uploaded_at FROM driver_documents WHERE driver_id = $1',
      [req.userId]
    );

    res.json({ driver: result.rows[0], documents: docs.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─────────────────────────────────────────
// UPDATE DRIVER PROFILE
// ─────────────────────────────────────────
router.put('/me', authenticate, requireRole('driver'), async (req, res) => {
  const { name, phone, vehicle_type, vehicle_plate } = req.body;
  try {
    const result = await pool.query(
      `UPDATE drivers SET name=$1, phone=$2, vehicle_type=$3, vehicle_plate=$4, updated_at=NOW()
       WHERE id=$5 RETURNING id, name, email, phone, vehicle_type, vehicle_plate, status`,
      [name, phone, vehicle_type, vehicle_plate, req.userId]
    );
    res.json({ driver: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─────────────────────────────────────────
// UPLOAD KYC DOCUMENT
// ─────────────────────────────────────────
const REQUIRED_DOCS = [
  'government_id',
  'drivers_license',
  'police_certified',
  'profile_photo',
  'vehicle_registration',
];

router.post(
  '/documents/upload',
  authenticate,
  requireRole('driver'),
  upload.single('document'),
  async (req, res) => {
    const { document_type } = req.body;

    if (!REQUIRED_DOCS.includes(document_type)) {
      return res.status(400).json({ error: `Invalid document type. Must be one of: ${REQUIRED_DOCS.join(', ')}` });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const filename = `${req.userId}-${document_type}-${Date.now()}`;
      const fileUrl = await uploadToS3(req.file.buffer, filename, req.file.mimetype);

      // Upsert document record
      const result = await pool.query(
        `INSERT INTO driver_documents (driver_id, document_type, file_url, file_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (driver_id, document_type) DO UPDATE
         SET file_url=$3, file_name=$4, verified=false, uploaded_at=NOW()
         RETURNING *`,
        [req.userId, document_type, fileUrl, req.file.originalname]
      );

      // Check if all required docs are uploaded
      const allDocs = await pool.query(
        'SELECT document_type FROM driver_documents WHERE driver_id = $1',
        [req.userId]
      );

      const uploadedTypes = allDocs.rows.map(r => r.document_type);
      const allUploaded = REQUIRED_DOCS.every(d => uploadedTypes.includes(d));

      if (allUploaded) {
        await pool.query(
          "UPDATE drivers SET status='documents_submitted', updated_at=NOW() WHERE id=$1 AND status='pending_documents'",
          [req.userId]
        );
      }

      res.json({
        document: result.rows[0],
        uploadedDocuments: uploadedTypes,
        allUploaded,
        message: allUploaded
          ? 'All documents uploaded! Your application is now under review.'
          : `Document uploaded. Still needed: ${REQUIRED_DOCS.filter(d => !uploadedTypes.includes(d)).join(', ')}`,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

// ─────────────────────────────────────────
// SET DRIVER ONLINE / OFFLINE
// ─────────────────────────────────────────
router.post('/online', authenticate, requireRole('driver'), requireApprovedDriver, async (req, res) => {
  const { online } = req.body;
  try {
    await pool.query('UPDATE drivers SET is_online=$1, updated_at=NOW() WHERE id=$2', [!!online, req.userId]);
    res.json({ online: !!online });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─── Haversine distance in km ─────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Estimate minutes based on distance (assume ~25km/h in city)
function estimateMinutes(km) {
  return Math.max(1, Math.round(km / 25 * 60));
}

// ─────────────────────────────────────────
// UPDATE DRIVER LOCATION
// Throttled DB writes: socket broadcast every ping, DB write every 5th ping (~15s)
// This cuts driver_locations inserts by 80% under load.
// ─────────────────────────────────────────
const locationWriteCounter = new Map(); // driverId → ping count

router.post('/location', authenticate, requireRole('driver'), async (req, res) => {
  const { lat, lng, orderId } = req.body;
  const io = req.app.get('io');

  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  try {
    // Always update current live position
    await pool.query(
      'UPDATE drivers SET current_lat=$1, current_lng=$2, updated_at=NOW() WHERE id=$3',
      [lat, lng, req.userId]
    );

    // Write history row only every 5th ping to reduce DB write volume
    const pingCount = (locationWriteCounter.get(req.userId) || 0) + 1;
    locationWriteCounter.set(req.userId, pingCount);
    if (pingCount % 5 === 0) {
      await pool.query(
        'INSERT INTO driver_locations (driver_id, order_id, lat, lng) VALUES ($1, $2, $3, $4)',
        [req.userId, orderId || null, lat, lng]
      );
    }

    if (io && orderId) {
      // Always broadcast live location to tracking screen
      io.to(`order:${orderId}`).emit('driver_location', {
        driverId: req.userId, orderId, lat, lng,
        timestamp: new Date().toISOString(),
      });

      // ── Arrival notifications ─────────────────────────────────────────────
      // Fetch order's dropoff coords and user ID
      const orderRow = await pool.query(
        'SELECT user_id, dropoff_lat, dropoff_lng, is_cash_delivery, status FROM orders WHERE id=$1',
        [orderId]
      );
      if (orderRow.rows.length) {
        const order = orderRow.rows[0];
        const distKm = haversineKm(
          parseFloat(lat), parseFloat(lng),
          parseFloat(order.dropoff_lat), parseFloat(order.dropoff_lng)
        );

        if (distKm !== null && order.status === 'en_route') {
          const mins = estimateMinutes(distKm);

          // Fire milestones — each fires once by checking previous distance
          // We use simple threshold checks; the frontend deduplicates by milestone key
          let milestone = null;
          if (distKm <= 0.15) {
            milestone = { key: 'arrived', message: '🚗 Your driver has arrived!' };
          } else if (mins <= 2) {
            milestone = { key: '2min', message: '⚡ Driver is 2 minutes away!' };
          } else if (mins <= 5) {
            milestone = { key: '5min', message: '📍 Driver is 5 minutes away' };
          } else if (mins <= 10) {
            milestone = { key: '10min', message: '🕐 Driver is about 10 minutes away' };
          } else if (mins <= 15) {
            milestone = { key: '15min', message: '🕐 Driver is about 15 minutes away' };
          }

          if (milestone) {
            io.to(`user:${order.user_id}`).emit('arrival_update', {
              orderId,
              milestone: milestone.key,
              message: milestone.message,
              distanceKm: distKm.toFixed(2),
              estimatedMins: mins,
            });

            // Cash warning: remind user when driver is 5 min away
            if (order.is_cash_delivery && milestone.key === '5min') {
              io.to(`user:${order.user_id}`).emit('cash_reminder', {
                orderId,
                message: '💵 Please have your cash ready — driver is almost there!',
              });
            }
          }
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ─────────────────────────────────────────
// GET AVAILABLE ORDERS (for driver)
// Returns orders that are paid and not yet assigned
// ─────────────────────────────────────────
router.get('/available-orders', authenticate, requireRole('driver'), requireApprovedDriver, async (req, res) => {
  try {
    // Subscription gate check
    const { checkDriverSubscriptionAllowed } = require('./subscriptions');
    const subCheck = await checkDriverSubscriptionAllowed(req.userId);
    if (!subCheck.allowed) {
      return res.status(403).json({ error: subCheck.reason, requiresSubscription: true });
    }

    const result = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.delivery_mode, o.time_slot,
              o.total, o.driver_payout, o.pickup_address, o.dropoff_address,
              o.pickup_lat, o.pickup_lng, o.dropoff_lat, o.dropoff_lng,
              o.is_cash_delivery, o.created_at,
              COUNT(oi.id) as item_count
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'paid' AND o.driver_id IS NULL
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT 20`
    );

    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─────────────────────────────────────────
// ACCEPT AN ORDER
// ─────────────────────────────────────────
router.post('/orders/:orderId/accept', authenticate, requireRole('driver'), requireApprovedDriver, async (req, res) => {
  const { orderId } = req.params;
  const io = req.app.get('io');

  try {
    // Atomic update - only accept if still unassigned
    const result = await pool.query(
      `UPDATE orders SET driver_id=$1, status='driver_assigned', updated_at=NOW()
       WHERE id=$2 AND status='paid' AND driver_id IS NULL
       RETURNING *`,
      [req.userId, orderId]
    );

    if (!result.rows.length) {
      return res.status(409).json({ error: 'Order already taken or unavailable' });
    }

    const order = result.rows[0];

    // Notify the user their driver has been assigned
    if (io) {
      io.to(`order:${orderId}`).emit('order_update', {
        orderId,
        status: 'driver_assigned',
        driverId: req.userId,
      });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// ─────────────────────────────────────────
// DRIVER EARNINGS
// ─────────────────────────────────────────
router.get('/earnings', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.order_number, o.driver_payout, o.status, o.created_at,
              COUNT(oi.id) as item_count
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.driver_id = $1 AND o.status IN ('completed', 'delivered')
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.userId]
    );

    const total = result.rows.reduce((sum, r) => sum + parseFloat(r.driver_payout || 0), 0);
    res.json({ orders: result.rows, totalEarnings: total.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

module.exports = router;

// ─────────────────────────────────────────
// GET ONLINE DRIVERS NEAR A LOCATION (for checkout picker)
// Part 2: Real driver data with rating, deliveries, price, busy status
// ─────────────────────────────────────────
router.get('/nearby', async (req, res) => {
  const { lat, lng } = req.query;
  try {
    let query, params;
    if (lat && lng) {
      query = `
        SELECT d.id, d.name, d.rating, d.total_deliveries, d.vehicle_type,
               d.profile_photo_url, d.is_online,
               ROUND((6371 * acos(
                 cos(radians($1)) * cos(radians(d.current_lat)) *
                 cos(radians(d.current_lng) - radians($2)) +
                 sin(radians($1)) * sin(radians(d.current_lat))
               ))::numeric, 1) AS distance_km,
               EXISTS(
                 SELECT 1 FROM orders o
                 WHERE o.driver_id = d.id
                   AND o.status IN ('driver_assigned','en_route','picked_up')
               ) as is_busy
        FROM drivers d
        WHERE d.is_online = true AND d.status = 'approved'
          AND d.current_lat IS NOT NULL AND d.current_lng IS NOT NULL
        ORDER BY distance_km ASC
        LIMIT 10`;
      params = [parseFloat(lat), parseFloat(lng)];
    } else {
      query = `
        SELECT id, name, rating, total_deliveries, vehicle_type,
               profile_photo_url, is_online,
               NULL as distance_km,
               EXISTS(
                 SELECT 1 FROM orders o
                 WHERE o.driver_id = drivers.id
                   AND o.status IN ('driver_assigned','en_route','picked_up')
               ) as is_busy
        FROM drivers
        WHERE is_online = true AND status = 'approved'
        ORDER BY rating DESC LIMIT 10`;
      params = [];
    }
    const result = await pool.query(query, params);
    // Attach an estimated delivery fee for display
    const driversWithFee = result.rows.map(d => ({
      ...d,
      estimated_fee: d.distance_km
        ? Math.round(35 + parseFloat(d.distance_km || 0) * 2)
        : 35,
    }));
    res.json({ drivers: driversWithFee });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch nearby drivers' });
  }
});
