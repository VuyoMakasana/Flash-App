const db = require("../config/database");
const paystackService = require("./paystackService");
const crypto = require("crypto");

class PayoutService {
  // Main entry-point called by DriverController.requestPayout.
  // Picks up the payout request, creates a real Paystack transfer,
  // and writes the result back to payout_transactions.
  static async processRequestedPayout(payoutRequestId) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Lock the payout request row so concurrent calls don't double-send.
      const requestResult = await client.query(
        `SELECT pr.*, w.wallet_balance
         FROM driver_payout_requests pr
         JOIN driver_wallets w ON w.driver_id = pr.driver_id
         WHERE pr.id = $1
         FOR UPDATE`,
        [payoutRequestId],
      );

      if (!requestResult.rows.length) {
        throw new Error("Payout request not found");
      }

      const req = requestResult.rows[0];

      // Idempotency: if already processed, just return the existing state.
      if (req.status !== "requested") {
        await client.query("COMMIT");
        return req;
      }

      // Guard against race conditions — balance must still cover the payout.
      if (parseFloat(req.wallet_balance) < parseFloat(req.amount)) {
        throw new Error("Insufficient wallet balance for payout");
      }

      // Look up the driver's registered bank recipient.
      const recipientResult = await client.query(
        `SELECT recipient_code FROM transfer_recipients
         WHERE driver_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [req.driver_id],
      );

      if (!recipientResult.rows.length) {
        throw new Error(
          "No bank account registered. Please add a bank account before requesting a payout.",
        );
      }

      const { recipient_code } = recipientResult.rows[0];

      // Generate a unique, idempotent reference fore this attempt.
      const reference = `flash_payout_${payoutRequestId}_${crypto.randomBytes(6).toString("hex")}`;

      // Mark processing before calling Paystack to avoid double-fires on retry.
      await client.query(
        `UPDATE driver_payout_requests
         SET status = 'processing', updated_at = NOW()
         WHERE id = $1`,
        [payoutRequestId],
      );

      // Pre-insert a payout_transactions row so we have a record even if
      // something goes wrong on the Paystack side before we can write back.
      const txResult = await client.query(
        `INSERT INTO payout_transactions
           (payout_request_id, driver_id, amount, status, reference, recipient_code)
         VALUES ($1, $2, $3, 'initiated', $4, $5)
         RETURNING id`,
        [payoutRequestId, req.driver_id, req.amount, reference, recipient_code],
      );
      const txId = txResult.rows[0].id;

      // Commit the "processing" state before making the external API call.
      // If the transfer call fails, we write 'failed' status directly in catch.
      await client.query("COMMIT");

      // ADDED: Pre-transfer balance check — prevents silent failures when Paystack account is underfunded
      const balanceResult = await paystackService.getBalance();
      if (balanceResult?.data) {
        const availableKobo = balanceResult.data.find(b => b.currency === 'ZAR')?.balance || 0;
        const requiredKobo = Math.round(req.amount * 100);
        if (availableKobo < requiredKobo) {
          throw new Error(
            `Insufficient Paystack balance. Available: R${(availableKobo/100).toFixed(2)}, Required: R${req.amount}. Please top up the Flash Paystack account.`
          );
        }
      }

      // ── Real Paystack Transfer ──────────────────────────────────────────
      let transferResult;
      try {
        transferResult = await paystackService.initiateTransfer({
          recipientCode: recipient_code,
          amountRands: req.amount,
          reference,
          reason: "Flash driver payout",
        });
      } catch (paystackErr) {
        await db.query(
          `UPDATE driver_payout_requests SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [payoutRequestId],
        );
        await db.query(
          `UPDATE payout_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [txId],
        );
        throw paystackErr;
      }

      if (!transferResult.status) {
        const errMsg = transferResult.message || "Paystack transfer failed";
        await db.query(
          `UPDATE driver_payout_requests SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [payoutRequestId],
        );
        await db.query(
          `UPDATE payout_transactions
           SET status = 'failed', provider_response = $2, updated_at = NOW()
           WHERE id = $1`,
          [txId, JSON.stringify(transferResult)],
        );
        throw new Error(errMsg);
      }

      const transferData = transferResult.data || {};
      const transferCode = transferData.transfer_code || null;
      // Paystack may respond 'success' (instant) or 'pending' (queued/OTP required).
      const transferStatus = transferData.status || "pending";

      await db.query(
        `UPDATE payout_transactions
         SET status = $2, transfer_code = $3, provider_response = $4, updated_at = NOW()
         WHERE id = $1`,
        [txId, transferStatus, transferCode, JSON.stringify(transferData)],
      );

      // If Paystack reports instant success, deduct wallet balance now.
      // Otherwise the transfer.success webhook will call finalizeSuccessfulPayout.
      if (transferStatus === "success") {
        await PayoutService.finalizeSuccessfulPayout(req.driver_id, req.amount, payoutRequestId, txId);
      } else {
        // Mark request as pending_transfer while we wait for the webhook.
        await db.query(
          `UPDATE driver_payout_requests
           SET status = 'pending_transfer', updated_at = NOW()
           WHERE id = $1`,
          [payoutRequestId],
        );
      }

      return {
        id: txId,
        reference,
        transfer_code: transferCode,
        status: transferStatus,
        amount: req.amount,
        driver_id: req.driver_id,
      };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      await db.query(
        `UPDATE driver_payout_requests
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND status IN ('requested','processing')`,
        [payoutRequestId],
      ).catch(() => null);
      throw err;
    } finally {
      client.release();
    }
  }

  // Called when Paystack fires a transfer.success webhook (or on inline success).
  // Atomically deducts wallet balance and writes a ledger entry.
  static async finalizeSuccessfulPayout(driverId, amount, payoutRequestId, txId) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const deductResult = await client.query(
        `UPDATE driver_wallets
         SET wallet_balance = wallet_balance - $2, updated_at = NOW()
         WHERE driver_id = $1 AND wallet_balance >= $2`,
        [driverId, amount],
      );

      // H5 FIX: the Paystack transfer has already succeeded by the time this
      // runs — the driver has been paid regardless. If the balance guard
      // above matched 0 rows (wallet_balance had already dropped below the
      // payout amount before this ran), the wallet was NOT decremented, and
      // silently continuing as if it had would let this same amount be paid
      // out again later. Flag it loudly for manual reconciliation instead —
      // the payout itself still completed successfully, so the request/
      // transaction status below is accurate either way.
      if (deductResult.rowCount === 0) {
        console.error(
          `[CRITICAL][Payout] Wallet deduction skipped for driverId=${driverId} amount=${amount} payoutRequestId=${payoutRequestId} — wallet_balance was already below the payout amount. Paystack transfer succeeded regardless. Manual wallet correction required.`,
        );
        await client.query(
          `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
           VALUES ($1, $2, 'payout_debit_reconcile_required', $3)`,
          [driverId, amount, `payout_ref_${payoutRequestId}_WALLET_NOT_DEDUCTED`],
        );
      } else {
        await client.query(
          `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
           VALUES ($1, $2, 'payout_debit', $3)`,
          [driverId, amount, `payout_ref_${payoutRequestId}`],
        );
      }

      await client.query(
        `UPDATE driver_payout_requests
         SET status = 'completed', updated_at = NOW()
         WHERE id = $1`,
        [payoutRequestId],
      );

      if (txId) {
        await client.query(
          `UPDATE payout_transactions
           SET status = 'success', completed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [txId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Called when Paystack fires a transfer.failed or transfer.reversed webhook.
  //
  // CRITICAL FIX: previously this only flipped statuses to 'failed' and
  // never checked whether the wallet had already been debited. Paystack can
  // report a transfer 'success' up front (finalizeSuccessfulPayout runs,
  // deducting the wallet immediately) and *later* reverse it via this exact
  // webhook event (e.g. an invalid bank account) — the driver's wallet
  // stayed permanently short by that amount even though the money bounced
  // back into Flash's own Paystack balance, confirmed live (§2.5, critical-
  // flow-edge-case audit). Re-crediting the exact deducted amount here is a
  // correction of a confirmed-wrong deduction (Paystack's own signed webhook
  // is the proof), not a new payment decision, so it's safe to apply
  // automatically — but it's logged loudly and ledgered so admins notice
  // and can check the driver's bank details before the next retry.
  static async handleFailedPayout(reference) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const txResult = await client.query(
        `SELECT id, driver_id, amount, payout_request_id, status
         FROM payout_transactions WHERE reference = $1 FOR UPDATE`,
        [reference],
      );
      if (!txResult.rows.length) {
        await client.query('COMMIT');
        return;
      }

      const tx = txResult.rows[0];
      const alreadyDeducted = tx.status === 'success';

      await client.query(
        `UPDATE payout_transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [tx.id],
      );
      if (tx.payout_request_id) {
        await client.query(
          `UPDATE driver_payout_requests SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [tx.payout_request_id],
        );
      }

      if (alreadyDeducted) {
        await client.query(
          `UPDATE driver_wallets SET wallet_balance = wallet_balance + $2, updated_at = NOW() WHERE driver_id = $1`,
          [tx.driver_id, tx.amount],
        );
        await client.query(
          `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
           VALUES ($1, $2, 'payout_reversed_recredit', $3)`,
          [tx.driver_id, tx.amount, `payout_ref_${tx.payout_request_id}_transfer_reversed_reference_${reference}`],
        );
        console.error(
          `[CRITICAL][Payout] Transfer reference=${reference} for driverId=${tx.driver_id} amount=${tx.amount} failed/reversed AFTER the wallet had already been debited — re-credited automatically. Admin should verify the driver's bank details before the next payout attempt.`,
        );
      }

      await client.query('COMMIT');
      return { driverId: tx.driver_id, amount: tx.amount, recredited: alreadyDeducted };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = PayoutService;
