'use strict';

const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const pool = require('../config/database');
const StoreTransferRecipient = require('../models/StoreTransferRecipient');
const StoreAction = require('../models/StoreAction');
const paystackService = require('../services/paystackService');
const { namesPlausiblyMatch } = require('../utils/accountNameMatch');
const { sendStorePayoutDestinationChangedEmail } = require('../services/emailService');

// Phase 2a — where a store's settlement money goes.
//
// No money moves yet; 2c does that. But this is the record 2c will pay against,
// so getting it wrong here means paying the wrong account later, which is the
// single most damaging thing this system could do to a real merchant.
//
// Four controls, each for a different failure:
//   1. Owner only (route-level) — reading financials and REDIRECTING money are
//      different privileges, so Finance is deliberately excluded.
//   2. Password re-authentication — a hijacked session must not be enough to
//      redirect a store's income. Mirrors the driver flow, which already does
//      this for the same reason.
//   3. Bank name verification — the account number is resolved with the bank
//      and the holder's name compared, so a mistyped digit cannot silently
//      point settlement at a stranger.
//   4. Notify + audit — a real owner gets an immediate signal if it was not
//      them, and every change leaves a store_actions row.
//
// Suspended stores need no separate guard: authenticateStore already refuses
// any request from a store that is not active and approved.
class StoreBankingController {
  // GET /api/store-banking — what is on file, if anything.
  static async getDestination(req, res) {
    try {
      const destination = await StoreTransferRecipient.getActiveForStore(req.storeId);
      // Explicitly `null` rather than 404: "this store has no payout
      // destination yet" is a normal state the portal must render, not an error.
      return res.json({ destination: destination || null });
    } catch (err) {
      console.error('[StoreBanking] getDestination error:', err.message);
      return res.status(500).json({ error: 'Could not load your payout details.' });
    }
  }

  // GET /api/store-banking/banks — the bank list for the form's dropdown.
  static async listBanks(req, res) {
    try {
      const result = await paystackService.getBankList();
      if (!result || !result.status || !Array.isArray(result.data)) {
        return res.status(502).json({ error: 'Could not load the bank list. Please try again.' });
      }
      // Only what the form needs. Paystack's rows carry a good deal more.
      return res.json({
        banks: result.data
          .map((b) => ({ name: b.name, code: b.code }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (err) {
      console.error('[StoreBanking] listBanks error:', err.message);
      return res.status(502).json({ error: 'Could not load the bank list. Please try again.' });
    }
  }

  // POST /api/store-banking — set or replace the payout destination.
  static async setDestination(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { account_number, bank_code, account_name, password } = req.body;

    try {
      // ── 1. Re-authenticate ────────────────────────────────────────────────
      // Also pulls the owner's email and the store's name in the same read, so
      // the notification at step 4 needs no second round trip. Scoped by
      // store_id as well as user id — belt and braces on top of requireOwnStore.
      const userRes = await pool.query(
        `SELECT su.password_hash, su.email, su.name AS owner_name, s.name AS store_name
           FROM store_users su
           JOIN stores s ON s.id = su.store_id
          WHERE su.id = $1 AND su.store_id = $2 AND su.is_active = true`,
        [req.storeUserId, req.storeId],
      );
      if (!userRes.rows.length) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const actor = userRes.rows[0];
      const passwordValid = await bcrypt.compare(password, actor.password_hash);
      if (!passwordValid) {
        // Deliberately not rate-limited here beyond the route's own limiter:
        // this endpoint already requires a valid session, so this is not an
        // anonymous password-guessing surface.
        return res.status(401).json({ error: 'Incorrect password.' });
      }

      // ── 2. Confirm the account exists and belongs to this name ────────────
      let resolved;
      try {
        resolved = await paystackService.verifyBankAccount(account_number, bank_code);
      } catch (verifyErr) {
        console.error('[StoreBanking] verifyBankAccount threw:', verifyErr.message);
        return res.status(502).json({ error: 'Could not reach the bank to verify this account. Please try again.' });
      }

      if (!resolved || !resolved.status || !resolved.data || !resolved.data.account_name) {
        // Paystack could not resolve it at all — usually a wrong account
        // number or the wrong bank selected.
        return res.status(400).json({
          error: 'We could not verify that account number with the selected bank. Please check both and try again.',
        });
      }

      const bankHeldName = resolved.data.account_name;

      if (!namesPlausiblyMatch(account_name, bankHeldName)) {
        // THE NAME IS NOT ECHOED BACK. Returning the bank-held name would turn
        // this endpoint into an account-holder lookup oracle: submit any
        // account number with a deliberately wrong name and read the real
        // owner's name out of the error. Paystack's resolve endpoint is such an
        // oracle; Flash must not re-expose it to a store portal session.
        console.warn(
          `[StoreBanking] name mismatch for store ${req.storeId} — submitted name did not match the bank's record`,
        );
        return res.status(400).json({
          error: "The account holder's name doesn't match the name on that account. "
            + 'Please enter it exactly as your bank has it, or contact Flash support.',
        });
      }

      // ── 3. Register with Paystack, then persist only the token ────────────
      let recipient;
      try {
        recipient = await paystackService.createTransferRecipient({
          name: bankHeldName, // the bank's own spelling, not the submitted one
          accountNumber: account_number,
          bankCode: bank_code,
          description: `Flash store – ${req.storeId}`,
        });
      } catch (recipientErr) {
        console.error('[StoreBanking] createTransferRecipient threw:', recipientErr.message);
        return res.status(502).json({ error: 'Could not register this account with our payment provider. Please try again.' });
      }

      const recipientCode = recipient && recipient.data && recipient.data.recipient_code;
      if (!recipient.status || !recipientCode) {
        return res.status(502).json({ error: 'Could not register this account with our payment provider. Please try again.' });
      }

      const destination = await StoreTransferRecipient.replaceForStore(req.storeId, {
        recipientCode,
        bankCode: bank_code,
        bankName: resolved.data.bank_name || null,
        // The ONLY part of the account number that is persisted.
        accountLast4: String(account_number).slice(-4),
        accountName: bankHeldName,
        createdBy: req.storeUserId,
      });

      // ── 4. Audit, then notify ─────────────────────────────────────────────
      StoreAction.log(req.storeUserId, req.storeId, 'payout_destination_changed', 'store_transfer_recipients', destination.id);

      // Fire-and-forget, after the write is committed: an email cannot be
      // rolled back, and a mail failure must not undo a change the owner
      // successfully made. Logged loudly, because a silently undelivered
      // notification is exactly the signal a hijacked owner would need — and
      // bounce visibility now records it if it fails.
      sendStorePayoutDestinationChangedEmail(actor.email, {
        ownerName: actor.owner_name,
        storeName: actor.store_name,
        bankName: destination.bank_name,
        accountLast4: destination.account_last4,
      }).catch((mailErr) => {
        console.error(`[StoreBanking] change notification failed for store ${req.storeId}:`, mailErr.message);
      });

      return res.json({
        destination,
        message: 'Payout account updated. Future settlements will be sent to this account.',
      });
    } catch (err) {
      console.error('[StoreBanking] setDestination error:', err.message);
      return res.status(500).json({ error: 'Could not update your payout details. Please try again.' });
    }
  }
}

module.exports = StoreBankingController;
