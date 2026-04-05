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

      await client.query(
        `UPDATE driver_wallets
         SET wallet_balance = wallet_balance - $2, updated_at = NOW()
         WHERE driver_id = $1 AND wallet_balance >= $2`,
        [driverId, amount],
      );

      await client.query(
        `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
         VALUES ($1, $2, 'payout_debit', $3)`,
        [driverId, amount, `payout_ref_${payoutRequestId}`],
      );

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
  static async handleFailedPayout(reference) {
    await db.query(
      `UPDATE payout_transactions
       SET status = 'failed', updated_at = NOW()
       WHERE reference = $1`,
      [reference],
    );
    // Mark the payout request as failed so the driver can retry.
    await db.query(
      `UPDATE driver_payout_requests pr
       SET status = 'failed', updated_at = NOW()
       FROM payout_transactions pt
       WHERE pt.payout_request_id = pr.id AND pt.reference = $1`,
      [reference],
    );
  }
}

module.exports = PayoutService;
