const BaseModel = require("./BaseModel");

const MEASUREMENT_GUIDE = {
  chest: {
    label: "Chest",
    unit: "cm",
    instruction:
      "Wrap the tape measure around the fullest part of your chest, keeping it horizontal. Breathe normally and do not pull it tight.",
    tip: "Measure over a light t-shirt for the most accurate fit.",
    video_url: null,
  },
  waist: {
    label: "Waist",
    unit: "cm",
    instruction:
      "Measure around your natural waistline — the narrowest part of your torso, usually about 2-3 cm above your belly button.",
    tip: "Stand up straight and do not suck in your stomach.",
    video_url: null,
  },
  hips: {
    label: "Hips",
    unit: "cm",
    instruction:
      "Measure around the fullest part of your hips and buttocks, keeping the tape parallel to the floor.",
    tip: "Usually about 20 cm below your natural waist.",
    video_url: null,
  },
  // ... other measurement guides
};

class Sizing extends BaseModel {
  static getMeasurementGuide() {
    return MEASUREMENT_GUIDE;
  }

  static async getSizeProfile(userId) {
    const result = await this.query(
      "SELECT * FROM size_profiles WHERE user_id=$1",
      [userId],
    );
    return result.rows[0];
  }

  static async saveSizeProfile(userId, data) {
    const {
      height_cm,
      weight_kg,
      chest_cm,
      waist_cm,
      hips_cm,
      shoulder_cm,
      inseam_cm,
      reference_brand_1,
      reference_size_1,
      reference_brand_2,
      reference_size_2,
    } = data;

    const clean = this.validateMeasurements({
      height_cm,
      weight_kg,
      chest_cm,
      waist_cm,
      hips_cm,
      shoulder_cm,
      inseam_cm,
    });

    const result = await this.query(
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
        userId,
        clean.height_cm,
        clean.weight_kg,
        clean.chest_cm,
        clean.waist_cm,
        clean.hips_cm,
        clean.shoulder_cm,
        clean.inseam_cm,
        reference_brand_1 || null,
        reference_size_1 || null,
        reference_brand_2 || null,
        reference_size_2 || null,
      ],
    );
    return result.rows[0];
  }

  static validateMeasurements(measurements) {
    const validate = (val, min, max, name) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(val);
      if (isNaN(n) || n < min || n > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
      }
      return n;
    };

    return {
      height_cm: validate(measurements.height_cm, 50, 280, "Height"),
      weight_kg: validate(measurements.weight_kg, 2, 300, "Weight"),
      chest_cm: validate(measurements.chest_cm, 40, 200, "Chest"),
      waist_cm: validate(measurements.waist_cm, 30, 200, "Waist"),
      hips_cm: validate(measurements.hips_cm, 40, 200, "Hips"),
      shoulder_cm: validate(measurements.shoulder_cm, 20, 80, "Shoulder"),
      inseam_cm: validate(measurements.inseam_cm, 30, 120, "Inseam"),
    };
  }

  static async getRecommendation(userId, storeId, category) {
    const profileResult = await this.query(
      "SELECT * FROM size_profiles WHERE user_id=$1",
      [userId],
    );

    if (!profileResult.rows.length) {
      return {
        recommendation: null,
        fallback: true,
        message: "Set up your measurements for a size recommendation.",
        guide: "/api/sizing/guide",
      };
    }

    const profile = profileResult.rows[0];
    const hasAnyMeasurement =
      profile.chest_cm ||
      profile.waist_cm ||
      profile.hips_cm ||
      profile.height_cm;

    if (!hasAnyMeasurement) {
      return {
        recommendation: null,
        fallback: true,
        message:
          "Add at least one body measurement to get a size recommendation.",
      };
    }

    const mappings = await this.query(
      "SELECT * FROM brand_size_mappings WHERE store_id=$1 AND category=$2 ORDER BY size_label",
      [storeId, category],
    );

    if (!mappings.rows.length) {
      return {
        recommendation: null,
        fallback: true,
        message:
          "Size chart not yet available for this store. Check the product description for sizing.",
      };
    }

    const recommendation = this.calculateSizeMatch(profile, mappings.rows);

    if (!recommendation) {
      return {
        recommendation: null,
        fallback: true,
        message:
          "Could not determine your size for this product. Try adding more measurements.",
      };
    }

    return {
      recommendation,
      profile: {
        chest: profile.chest_cm,
        waist: profile.waist_cm,
        hips: profile.hips_cm,
      },
      fallback: false,
    };
  }

  static calculateSizeMatch(userProfile, sizeMappings) {
    if (!sizeMappings || !sizeMappings.length) return null;
    let bestMatch = null;
    let bestScore = 0;

    for (const mapping of sizeMappings) {
      let score = 0;
      let checks = 0;

      if (userProfile.chest_cm && mapping.chest_min && mapping.chest_max) {
        const inRange =
          userProfile.chest_cm >= mapping.chest_min &&
          userProfile.chest_cm <= mapping.chest_max;
        const proximity =
          1 -
          Math.min(
            Math.abs(userProfile.chest_cm - mapping.chest_min),
            Math.abs(userProfile.chest_cm - mapping.chest_max),
          ) /
            20;
        score += inRange ? 1 : Math.max(0, proximity);
        checks++;
      }
      if (userProfile.waist_cm && mapping.waist_min && mapping.waist_max) {
        const inRange =
          userProfile.waist_cm >= mapping.waist_min &&
          userProfile.waist_cm <= mapping.waist_max;
        const proximity =
          1 -
          Math.min(
            Math.abs(userProfile.waist_cm - mapping.waist_min),
            Math.abs(userProfile.waist_cm - mapping.waist_max),
          ) /
            20;
        score += inRange ? 1 : Math.max(0, proximity);
        checks++;
      }
      if (userProfile.hips_cm && mapping.hips_min && mapping.hips_max) {
        const inRange =
          userProfile.hips_cm >= mapping.hips_min &&
          userProfile.hips_cm <= mapping.hips_max;
        score += inRange ? 1 : 0.3;
        checks++;
      }
      if (userProfile.height_cm && mapping.height_min && mapping.height_max) {
        const inRange =
          userProfile.height_cm >= mapping.height_min &&
          userProfile.height_cm <= mapping.height_max;
        score += inRange ? 1 : 0.4;
        checks++;
      }

      const avgScore = checks > 0 ? score / checks : 0;
      if (avgScore > bestScore) {
        bestScore = avgScore;
        bestMatch = {
          size: mapping.size_label,
          confidence: Math.round(avgScore * 100),
        };
      }
    }
    return bestMatch;
  }

  static async seedMappings(storeId, brandName, category, mappings) {
    let seeded = 0;
    for (const m of mappings) {
      await this.query(
        `INSERT INTO brand_size_mappings
           (store_id, brand_name, category, size_label,
            chest_min, chest_max, waist_min, waist_max,
            hips_min, hips_max, height_min, height_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [
          storeId,
          brandName,
          category,
          m.size,
          m.chest_min,
          m.chest_max,
          m.waist_min,
          m.waist_max,
          m.hips_min,
          m.hips_max,
          m.height_min,
          m.height_max,
        ],
      );
      seeded++;
    }
    return seeded;
  }
}

module.exports = Sizing;
