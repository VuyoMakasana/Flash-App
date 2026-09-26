'use strict';

const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const pool = require('../config/database');
const StoreTransferRecipient = require('../models/StoreTransferRecipient');
const StoreAction = require('../models/StoreAction');
const paystackService = require('../services/paystackService');
const { sendStorePayoutDestinationChangedEmail } = require('../services/emailService');

// Phase 2a — where a store's settlement money goes.
//
// No money moves yet; 2c does that. But this is the record 2c will pay against,
// so getting it wrong here means paying the wrong account later, which is the
// single most damaging thing this system could do to a real merchant.
//
// THREE controls, and one that was designed but proved impossible:
//   1. Owner only (route-level) — reading financials and REDIRECTING money are
//      different privileges, so Finance is deliberately excluded.
//   2. Password re-authentication — a hijacked session must not be enough to
//      redirect a store's income. Mirrors the driver flow, which already does
//      this for the same reason.
//   3. Notify + audit — a real owner gets an immediate signal if it was not
//      them, and every change leaves a store_actions row.
//
// The fourth was independent verification of the account holder's name. A live
// probe against Paystack proved /bank/resolve is Nigeria/Ghana only and
// rejects South African requests outright, so that control cannot be built
// today. Its replacement (/bank/validate, ZAR 3 per call, requires an ID
// number) is shelved until a live ZA-configured key exists. This is therefore
// UNVERIFIED registration -- the same posture the driver path has always had.
// A mistyped account number will be accepted, which is precisely why the
// notification email at step 4 matters more here than it otherwise would.
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

      // ── 2. Register with Paystack ─────────────────────────────────────────
      //
      // THE ACCOUNT IS NOT INDEPENDENTLY VERIFIED, and that is a deliberate,
      // documented decision rather than an omission.
      //
      // The original design resolved the account and compared the holder's
      // name. A live probe against Paystack proved that cannot work here:
      // /bank/resolve is a Nigeria/Ghana product and answers a South African
      // request with "Please supply one of the following valid currencies:
      // NGN, USD, GHS, KES". Building on it would have rejected 100% of real
      // South African stores while looking correct in every unit test.
      //
      // The South African equivalent, /bank/validate, is a separate paid
      // product (ZAR 3 per successful call) that additionally requires the
      // owner's ID or company registration number. It is shelved until Flash
      // has a live, ZA-configured Paystack account — there is no live key at
      // all today. See docs/audits/PHASE2A_PAYOUT_DESTINATION_RECORD.md §3.
      //
      // So registration is unverified, matching the existing driver path,
      // which calls createTransferRecipient with no prior resolve for exactly
      // the same reason. The real controls here are the password
      // re-authentication above, the notification email, and the audit row —
      // not a name check that cannot be performed.
      let recipient;
      try {
        recipient = await paystackService.createTransferRecipient({
          name: account_name,
          accountNumber: account_number,
          bankCode: bank_code,
          description: `Flash store – ${req.storeId}`,
        });
      } catch (recipientErr) {
        // Expected in production until a live key exists: paystackService
        // throws on any call when NODE_ENV is production and the key is
        // sk_test_. Surfaced as a 502 rather than swallowed, so a store owner
        // is told it failed instead of believing a destination was saved.
        console.error('[StoreBanking] createTransferRecipient threw:', recipientErr.message);
        return res.status(502).json({ error: 'Could not register this account with our payment provider. Please try again.' });
      }

      const recipientCode = recipient && recipient.data && recipient.data.recipient_code;
      if (!recipient.status || !recipientCode) {
        return res.status(502).json({ error: 'Could not register this account with our payment provider. Please try again.' });
      }

      // Paystack echoes the registered account back under data.details, which
      // a live probe confirmed carries account_number, account_name, bank_code
      // and bank_name. Preferring its values over the submitted ones means the
      // bank name is whatever the provider actually recorded rather than
      // something Flash inferred from a bank_code — and if Paystack ever does
      // normalise the holder's name, that normalisation is what gets stored.
      // Falls back to the submitted values, since for South African recipients
      // the echo may simply repeat what was sent.
      const details = (recipient.data && recipient.data.details) || {};

      const destination = await StoreTransferRecipient.replaceForStore(req.storeId, {
        recipientCode,
        bankCode: bank_code,
        bankName: details.bank_name || null,
        // The ONLY part of the account number that is persisted.
        accountLast4: String(account_number).slice(-4),
        accountName: details.account_name || account_name,
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
