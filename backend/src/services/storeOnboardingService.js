'use strict';

const crypto = require('crypto');
const pool = require('../config/database');
const Store = require('../models/Store');
const { sendStoreWelcomeEmail } = require('./emailService');

// How long an approved owner has to set their first password. Deliberately far
// longer than the 1-hour password-RESET window: a reset is requested by someone
// sitting at the screen right then, whereas this arrives unprompted after a
// review that may have taken days, and the recipient may not read mail daily.
// Still finite, and still single-use.
const INVITE_TOKEN_TTL_DAYS = 7;

// Phase 3 — the approval half of self-service onboarding.
//
// Kept as a service rather than inline in the AdminJS action so the money-
// adjacent parts (activating a store, minting a credential-setting token) are
// testable without booting AdminJS, and so a future "approve via API" path
// cannot drift from what the admin panel does.
class StoreOnboardingService {
  // Approves an application: activates the store, activates its owner account,
  // and issues a single-use link for the owner to set a real password.
  //
  // All of it runs in one transaction. A half-applied approval is the dangerous
  // case: an active store whose owner can never sign in, or an active owner
  // account still carrying the unusable placeholder hash from application time.
  static async approve(storeId, adminId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Store.approve is scoped to pending/under_review, so a duplicate click
      // or two admins racing the same application yields null on the loser
      // rather than re-approving and re-issuing a second invite.
      const store = await Store.approve(storeId, adminId, client);
      if (!store) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_pending' };
      }

      const ownerResult = await client.query(
        `UPDATE store_users SET is_active = true, updated_at = NOW()
         WHERE store_id = $1 AND role = 'owner'
         RETURNING id, email, name`,
        [storeId],
      );
      const owner = ownerResult.rows[0];
      if (!owner) {
        // An approved store with no owner account would be unusable and
        // unrecoverable through self-service. Refuse rather than half-apply.
        await client.query('ROLLBACK');
        return { ok: false, reason: 'no_owner' };
      }

      // Reuses store_password_tokens rather than adding a near-identical
      // invite table: "set your first password" and "reset your password" are
      // the same operation against the same account, and the existing
      // reset-password endpoint already spends the token atomically, stamps
      // password_changed_at and clears force_password_reset. One token
      // mechanism means one thing to keep secure.
      await client.query(`DELETE FROM store_password_tokens WHERE store_user_id = $1`, [owner.id]);
      const token = crypto.randomBytes(48).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO store_password_tokens (store_user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [owner.id, token, expiresAt],
      );

      await client.query('COMMIT');

      // Sent after COMMIT, never inside the transaction: an email cannot be
      // rolled back, so a mail failure must not be able to undo an approval
      // that has already happened. Fire-and-forget for the same reason the
      // reset flow is -- but logged loudly, because a silently undelivered
      // invite leaves an approved owner unable to get in.
      sendStoreWelcomeEmail(owner.email, owner.name, token).catch((err) => {
        console.error(
          `[StoreOnboarding] welcome email failed for storeId=${storeId} owner=${owner.email}:`,
          err.message,
        );
      });

      return { ok: true, store, owner: { id: owner.id, email: owner.email } };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[StoreOnboarding] approve error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // Rejection deliberately leaves the store and owner rows in place rather than
  // deleting them: the application is a record of a real decision, and
  // store_users.email is globally unique, so a delete would silently free an
  // address that a later duplicate application could then claim.
  static async reject(storeId, adminId, reason) {
    const store = await Store.reject(storeId, adminId, reason);
    if (!store) return { ok: false, reason: 'not_pending' };
    return { ok: true, store };
  }
}

module.exports = StoreOnboardingService;
module.exports.INVITE_TOKEN_TTL_DAYS = INVITE_TOKEN_TTL_DAYS;
