'use strict';

const BaseModel = require('./BaseModel');

// Backs the public marketing site's (flash-website-rebuild) waitlist,
// contact, and driver/seller application forms — see migrate.js v29 for why
// these live here instead of a separate service.
class MarketingLead extends BaseModel {
  // Duplicate email is treated as an idempotent success (matches the
  // marketing site's own original behavior in flash-server/lib/waitlistStore.js):
  // ON CONFLICT returns the existing row rather than erroring, so someone
  // re-submitting the same email twice doesn't see a failure.
  static async addWaitlistSignup(email, role) {
    const result = await this.query(
      `INSERT INTO marketing_waitlist (email, role)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING *`,
      [email, role],
    );
    return result.rows[0];
  }

  static async addContactMessage(name, email, subject, message) {
    const result = await this.query(
      `INSERT INTO marketing_contact_messages (name, email, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, email, subject, message],
    );
    return result.rows[0];
  }

  static async addApplication(applicantType, name, email, city, message) {
    const result = await this.query(
      `INSERT INTO marketing_applications (applicant_type, name, email, city, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [applicantType, name, email, city ?? null, message ?? null],
    );
    return result.rows[0];
  }
}

module.exports = MarketingLead;
