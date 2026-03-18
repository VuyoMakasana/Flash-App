const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── SIZE MATCH ALGORITHM (unchanged — preserved exactly) ────────────────────
function calculateSizeMatch(userProfile, sizeMappings) {
  if (!sizeMappings || !sizeMappings.length) return null;
  let bestMatch = null;
  let bestScore = 0;

  for (const mapping of sizeMappings) {
    let score = 0;
    let checks = 0;

    if (userProfile.chest_cm && mapping.chest_min && mapping.chest_max) {
      const inRange = userProfile.chest_cm >= mapping.chest_min && userProfile.chest_cm <= mapping.chest_max;
      const proximity = 1 - Math.min(
        Math.abs(userProfile.chest_cm - mapping.chest_min),
        Math.abs(userProfile.chest_cm - mapping.chest_max)
      ) / 20;
      score += inRange ? 1 : Math.max(0, proximity);
      checks++;
    }
    if (userProfile.waist_cm && mapping.waist_min && mapping.waist_max) {
      const inRange = userProfile.waist_cm >= mapping.waist_min && userProfile.waist_cm <= mapping.waist_max;
      const proximity = 1 - Math.min(
        Math.abs(userProfile.waist_cm - mapping.waist_min),
        Math.abs(userProfile.waist_cm - mapping.waist_max)
      ) / 20;
      score += inRange ? 1 : Math.max(0, proximity);
      checks++;
    }
    if (userProfile.hips_cm && mapping.hips_min && mapping.hips_max) {
      const inRange = userProfile.hips_cm >= mapping.hips_min && userProfile.hips_cm <= mapping.hips_max;
      score += inRange ? 1 : 0.3;
      checks++;
    }
    if (userProfile.height_cm && mapping.height_min && mapping.height_max) {
      const inRange = userProfile.height_cm >= mapping.height_min && userProfile.height_cm <= mapping.height_max;
      score += inRange ? 1 : 0.4;
      checks++;
    }

    const avgScore = checks > 0 ? score / checks : 0;
    if (avgScore > bestScore) {
      bestScore = avgScore;
      bestMatch = { size: mapping.size_label, confidence: Math.round(avgScore * 100) };
    }
  }
  return bestMatch;
}

// ─── Part 5: Measurement guidance data ───────────────────────────────────────
const MEASUREMENT_GUIDE = {
  chest: {
    label: 'Chest',
    unit: 'cm',
    instruction: 'Wrap the tape measure around the fullest part of your chest, keeping it horizontal. Breathe normally and do not pull it tight.',
    tip: 'Measure over a light t-shirt for the most accurate fit.',
    video_url: null,
  },
  waist: {
    label: 'Waist',
    unit: 'cm',
    instruction: 'Measure around your natural waistline — the narrowest part of your torso, usually about 2-3 cm above your belly button.',
    tip: 'Stand up straight and do not suck in your stomach.',
    video_url: null,
  },
  hips: {
    label: 'Hips',
    unit: 'cm',
    instruction: 'Measure around the fullest part of your hips and buttocks, keeping the tape parallel to the floor.',
    tip: 'Usually about 20 cm below your natural waist.',
    video_url: null,
  },
  shoulder: {
    label: 'Shoulder Width',
    unit: 'cm',
    instruction: 'Measure from the edge of one shoulder (where the shoulder seam sits) across to the other shoulder edge.',
    tip: 'It is easier to measure this on a shirt that fits you well.',
    video_url: null,
  },
  inseam: {
    label: 'Inseam',
    unit: 'cm',
    instruction: 'Measure from the crotch seam down to the bottom of your leg (where you want the trousers to end).',
    tip: 'Measure a pair of trousers that fits you perfectly for the most accurate result.',
    video_url: null,
  },
  height: {
    label: 'Height',
    unit: 'cm',
    instruction: 'Stand barefoot against a wall with your heels touching the wall. Mark the wall at the top of your head and measure from the floor.',
    tip: 'Measure in the morning — you are slightly taller then.',
    video_url: null,
  },
  weight: {
    label: 'Weight',
    unit: 'kg',
    instruction: 'Use a bathroom scale. Weigh yourself in the morning before eating for consistency.',
    tip: 'Weight helps refine recommendations for stretch and fit fabrics.',
    video_url: null,
  },
  shoe_size: {
    label: 'Shoe Size',
    unit: 'EU size',
    instruction: 'Trace your foot on paper, measure the longest distance from heel to toe in cm. Use the SA/EU size chart: 24cm=38, 25cm=39, 26cm=40, 27cm=41, 28cm=42, 29cm=43, 30cm=44, 31cm=45.',
    tip: 'Measure in the afternoon — feet swell slightly during the day.',
    video_url: null,
  },
  shirt_size: {
    label: 'Shirt Size',
    unit: 'label',
    instruction: 'SA standard shirt sizes: XS (chest 84-88cm), S (88-92cm), M (92-96cm), L (96-100cm), XL (100-104cm), XXL (104-108cm), XXXL (108-112cm).',
    tip: 'If between sizes, go up for a relaxed fit or down for a slim fit.',
    video_url: null,
  },
  jeans_size: {
    label: 'Jeans Size',
    unit: 'waist/length',
    instruction: 'Jeans use waist (in inches) and inseam length. Measure waist in cm then divide by 2.54. Common sizes: 28W=71cm, 30W=76cm, 32W=81cm, 34W=86cm, 36W=91cm. Inseam: 30L=76cm, 32L=81cm, 34L=86cm.',
    tip: 'For stretch denim, go one size down from your measurement.',
    video_url: null,
  },
};

// ─── GET MEASUREMENT GUIDE (Part 5) ──────────────────────────────────────────
router.get('/guide', async (req, res) => {
  res.json({ guide: MEASUREMENT_GUIDE });
});

// ─── GET SIZE PROFILE (Part 5: profile persists across devices via DB) ────────
router.get('/profile', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM size_profiles WHERE user_id=$1', [req.userId]);
    res.json({ profile: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch size profile' });
  }
});

// ─── SAVE / UPDATE SIZE PROFILE ───────────────────────────────────────────────
// Part 5: Profile is stored in DB — persists across logout, login, device changes.
router.post('/profile', authenticate, requireRole('user'), async (req, res) => {
  const {
    height_cm, weight_kg, chest_cm, waist_cm, hips_cm,
    shoulder_cm, inseam_cm,
    reference_brand_1, reference_size_1,
    reference_brand_2, reference_size_2,
  } = req.body;

  // Validate ranges to prevent junk data breaking the algorithm
  const validate = (val, min, max, name) => {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    if (isNaN(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return n;
  };

  try {
    const clean = {
      height_cm:    validate(height_cm,   50,  280, 'Height'),
      weight_kg:    validate(weight_kg,    2,  300, 'Weight'),
      chest_cm:     validate(chest_cm,    40,  200, 'Chest'),
      waist_cm:     validate(waist_cm,    30,  200, 'Waist'),
      hips_cm:      validate(hips_cm,     40,  200, 'Hips'),
      shoulder_cm:  validate(shoulder_cm, 20,  80,  'Shoulder'),
      inseam_cm:    validate(inseam_cm,   30,  120, 'Inseam'),
    };

    const result = await pool.query(
      `INSERT INTO size_profiles
         (user_id, height_cm, weight_kg, chest_cm, waist_cm, hips_cm, shoulder_cm, inseam_cm,
          reference_brand_1, reference_size_1, reference_brand_2, reference_size_2)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id) DO UPDATE SET
         height_cm=$2, weight_kg=$3, chest_cm=$4, waist_cm=$5, hips_cm=$6,
         shoulder_cm=$7, inseam_cm=$8,
         reference_brand_1=$9, reference_size_1=$10,
         reference_brand_2=$11, reference_size_2=$12,
         updated_at=NOW()
       RETURNING *`,
      [
        req.userId,
        clean.height_cm, clean.weight_kg, clean.chest_cm,
        clean.waist_cm,  clean.hips_cm,   clean.shoulder_cm, clean.inseam_cm,
        reference_brand_1 || null, reference_size_1 || null,
        reference_brand_2 || null, reference_size_2 || null,
      ]
    );
    res.json({ profile: result.rows[0] });
  } catch (err) {
    if (err.message.includes('must be between')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to save size profile' });
  }
});

// ─── GET SIZE RECOMMENDATION ──────────────────────────────────────────────────
// Part 5: Never crashes — always returns a safe fallback.
router.get('/recommend/:storeId/:category', authenticate, requireRole('user'), async (req, res) => {
  const { storeId, category } = req.params;

  try {
    const profileResult = await pool.query(
      'SELECT * FROM size_profiles WHERE user_id=$1',
      [req.userId]
    );

    // Safe fallback: no profile set up
    if (!profileResult.rows.length) {
      return res.json({
        recommendation: null,
        fallback: true,
        message: 'Set up your measurements for a size recommendation.',
        guide: '/api/sizing/guide',
      });
    }

    const profile = profileResult.rows[0];
    const hasAnyMeasurement =
      profile.chest_cm || profile.waist_cm || profile.hips_cm || profile.height_cm;

    // Safe fallback: profile exists but has no useful measurements
    if (!hasAnyMeasurement) {
      return res.json({
        recommendation: null,
        fallback: true,
        message: 'Add at least one body measurement to get a size recommendation.',
      });
    }

    const mappings = await pool.query(
      'SELECT * FROM brand_size_mappings WHERE store_id=$1 AND category=$2 ORDER BY size_label',
      [storeId, category]
    );

    // Safe fallback: no size chart for this store yet
    if (!mappings.rows.length) {
      return res.json({
        recommendation: null,
        fallback: true,
        message: 'Size chart not yet available for this store. Check the product description for sizing.',
      });
    }

    const recommendation = calculateSizeMatch(profile, mappings.rows);

    // Safe fallback: algorithm returned nothing (shouldn't happen but defensive)
    if (!recommendation) {
      return res.json({
        recommendation: null,
        fallback: true,
        message: 'Could not determine your size for this product. Try adding more measurements.',
      });
    }

    res.json({
      recommendation,
      profile: {
        chest: profile.chest_cm,
        waist: profile.waist_cm,
        hips:  profile.hips_cm,
      },
      fallback: false,
    });
  } catch (err) {
    // Never let the sizing endpoint crash the app — always return gracefully
    console.error('[Sizing] Error:', err.message);
    res.json({
      recommendation: null,
      fallback: true,
      message: 'Size recommendation temporarily unavailable.',
    });
  }
});

// ─── SEED SIZE MAPPINGS ───────────────────────────────────────────────────────
router.post('/mappings/seed', authenticate, async (req, res) => {
  const { storeId, brandName, category, mappings } = req.body;
  if (!storeId || !brandName || !category || !Array.isArray(mappings)) {
    return res.status(400).json({ error: 'storeId, brandName, category and mappings[] required' });
  }
  try {
    let seeded = 0;
    for (const m of mappings) {
      await pool.query(
        `INSERT INTO brand_size_mappings
           (store_id, brand_name, category, size_label,
            chest_min, chest_max, waist_min, waist_max,
            hips_min, hips_max, height_min, height_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [
          storeId, brandName, category, m.size,
          m.chest_min, m.chest_max, m.waist_min, m.waist_max,
          m.hips_min,  m.hips_max,  m.height_min, m.height_max,
        ]
      );
      seeded++;
    }
    res.json({ success: true, message: `${seeded} size mappings saved for ${brandName}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to seed size mappings' });
  }
});

module.exports = router;
