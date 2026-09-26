'use strict';

const BaseModel = require('./BaseModel');

// Phase 2a — a store's payout destination.
//
// The account number is deliberately absent from this table and from every
// method here. Once Paystack has issued a `recipient_code`, that code is all
// Flash needs to send money; the account number stays with Paystack. What is
// kept is only what is needed to SHOW an owner which account is on file:
// bank name, last four digits, and the holder's name.
//
// See migration v38's own comment for why not-holding beats encrypting, and
// OPEN_FOLLOWUPS #17 for the driver table that does the weaker thing.
const PUBLIC_COLUMNS = `
  id, bank_name, bank_code, account_last4, account_name, created_at, updated_at
`;

class StoreTransferRecipient extends BaseModel {
  // What the portal shows the owner. Never selects recipient_code: that is a
  // payment credential, needed only server-side at transfer time, and a store
  // has no use for it.
  static async getActiveForStore(storeId) {
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM store_transfer_recipients
       WHERE store_id = $1 AND is_active = true`,
      [storeId],
    );
    return result.rows[0] || null;
  }

  // Used at settlement time (2c), server-side only.
  static async getActiveRecipientCode(storeId) {
    const result = await this.query(
      `SELECT recipient_code FROM store_transfer_recipients
       WHERE store_id = $1 AND is_active = true`,
      [storeId],
    );
    return result.rows[0] ? result.rows[0].recipient_code : null;
  }

  // Replaces whatever destination was on file, in ONE transaction.
  //
  // The deactivate-then-insert pair has to be atomic: committing the
  // deactivation separately would leave a window in which a store has no
  // active payout destination at all, and a settlement run landing in that
  // window would find nowhere to send money. The partial unique index from v38
  // (one active row per store) is what turns the ordering into a real
  // guarantee rather than a convention — two concurrent replacements cannot
  // both insert an active row, so the loser fails loudly instead of silently
  // creating a second destination.
  //
  // The superseded row is kept, never deleted, so "which account did this
  // store's money go to in March" stays answerable.
  static async replaceForStore(storeId, { recipientCode, bankCode, bankName, accountLast4, accountName, createdBy }) {
    const pool = require('../config/database');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE store_transfer_recipients
         SET is_active = false, updated_at = NOW()
         WHERE store_id = $1 AND is_active = true`,
        [storeId],
      );

      const inserted = await client.query(
        `INSERT INTO store_transfer_recipients
           (store_id, recipient_code, bank_code, bank_name, account_last4, account_name, created_by, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         RETURNING ${PUBLIC_COLUMNS}`,
        [storeId, recipientCode, bankCode, bankName || null, accountLast4, accountName, createdBy || null],
      );

      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = StoreTransferRecipient;
module.exports.PUBLIC_COLUMNS = PUBLIC_COLUMNS;
