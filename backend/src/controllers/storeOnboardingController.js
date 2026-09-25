'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const Store = require('../models/Store');
const StoreUser = require('../models/StoreUser');
const { validationResult } = require('express-validator');

// Phase 3 — self-service store onboarding.
//
// Structurally mirrors how drivers already join the platform (public
// registration -> pending -> Flash review -> approved/rejected) rather than
// inventing a second approval model. Nothing here grants access: an
// application creates an inactive store and an inactive owner account, and
// only an admin approval turns either on.
class StoreOnboardingController {
  // POST /api/store-onboarding/apply — public, rate-limited.
  static async apply(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { store_name, address, owner_name, owner_email, owner_phone } = req.body;
    if (!store_name || !owner_name || !owner_email) {
      return res.status(400).json({ error: 'store_name, owner_name and owner_email are required' });
    }

    const email = String(owner_email).trim().toLowerCase();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The store and its owner account are created together. If the email is
      // already taken the whole thing rolls back, so a rejected INSERT can
      // never leave an orphan store row behind with no way to sign into it.
      const store = await Store.createApplication(
        {
          name: store_name,
          address,
          ownerName: owner_name,
          ownerEmail: email,
          ownerPhone: owner_phone,
        },
        client,
      );

      // The applicant never chooses a password at this point. A real password
      // is set only after approval, through the emailed single-use link. This
      // placeholder is a genuine bcrypt hash of random bytes that are then
      // discarded -- unusable by anyone, including us, rather than a guessable
      // sentinel like "pending" that would become a live credential the moment
      // the account is activated.
      const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

      await StoreUser.create(
        {
          storeId: store.id,
          name: owner_name,
          email,
          passwordHash: unusableHash,
          role: 'owner',
          forcePasswordReset: true,
        },
        client,
      );

      // The owner account stays inactive until approval. authenticateStore
      // checks is_active live on every request, so this alone prevents sign-in
      // even if a token were somehow obtained.
      await client.query(`UPDATE store_users SET is_active = false WHERE store_id = $1`, [store.id]);

      await client.query('COMMIT');

      // Deliberately does not echo the store id back. An applicant has no use
      // for it before approval, and returning it would let anyone probe whether
      // an application succeeded for a given email.
      return res.status(201).json({
        success: true,
        message: 'Application received. Flash will review it and email you the next steps.',
      });
    } catch (err) {
      await client.query('ROLLBACK');

      // store_users.email carries a real UNIQUE constraint, globally rather
      // than per-store. A duplicate is a client error, not a server fault --
      // but the response deliberately matches the success message so this
      // endpoint cannot be used to test which emails are already registered.
      if (err.code === '23505') {
        return res.status(201).json({
          success: true,
          message: 'Application received. Flash will review it and email you the next steps.',
        });
      }

      console.error('[StoreOnboarding] apply error:', err.message);
      return res.status(500).json({ error: 'Could not submit your application. Please try again.' });
    } finally {
      client.release();
    }
  }
}

module.exports = StoreOnboardingController;
