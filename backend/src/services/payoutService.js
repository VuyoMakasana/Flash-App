const db = require("../config/database");

class PayoutService {
  static async processRequestedPayout(payoutRequestId) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const requestResult = await client.query(
        `SELECT *
         FROM driver_payout_requests
         WHERE id = $1
         FOR UPDATE`,
        [payoutRequestId],
      );

      if (!requestResult.rows.length) {
        throw new Error("Payout request not found");
      }

      const payoutRequest = requestResult.rows[0];
      if (payoutRequest.status !== "requested") {
        await client.query("COMMIT");
        return payoutRequest;
      }

      await client.query(
        `UPDATE driver_payout_requests
         SET status = 'processing', updated_at = NOW()
         WHERE id = $1`,
        [payoutRequestId],
      );

      const payoutResult = await client.query(
        `INSERT INTO driver_payouts (payout_request_id, driver_id, amount, status, reference, notes)
         VALUES ($1, $2, $3, 'completed', $4, $5)
         RETURNING *`,
        [
          payoutRequestId,
          payoutRequest.driver_id,
          payoutRequest.amount,
          `flash_payout_${payoutRequestId}`,
          "Simulated payout completed",
        ],
      );

      await client.query(
        `UPDATE driver_payout_requests
         SET status = 'completed', updated_at = NOW()
         WHERE id = $1`,
        [payoutRequestId],
      );

      await client.query(
        `UPDATE driver_payouts
         SET completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [payoutResult.rows[0].id],
      );

      await client.query(
        `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
         VALUES ($1, $2, 'payout_debit', 'payout_completed')`,
        [payoutRequest.driver_id, payoutRequest.amount],
      );

      await client.query("COMMIT");
      return payoutResult.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      await db.query(
        `UPDATE driver_payout_requests
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [payoutRequestId],
      ).catch(() => null);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = PayoutService;
