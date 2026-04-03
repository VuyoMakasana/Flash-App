const BaseModel = require("./BaseModel");

class DriverWallet extends BaseModel {
  static async ensureWallet(client, driverId) {
    await client.query(
      `INSERT INTO driver_wallets (driver_id, wallet_balance, pending_balance)
       VALUES ($1, 0, 0)
       ON CONFLICT (driver_id) DO NOTHING`,
      [driverId],
    );
  }

  static async addPending(client, driverId, amount, orderId, note = "pending_credit") {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET pending_balance = pending_balance + $1, updated_at = NOW()
       WHERE driver_id = $2`,
      [amount, driverId],
    );
    await client.query(
      `INSERT INTO driver_wallet_ledger (driver_id, order_id, amount, entry_type, note)
       VALUES ($1, $2, $3, 'pending_credit', $4)`,
      [driverId, orderId, amount, note],
    );
  }

  static async releasePending(client, driverId, amount, orderId, note = "delivery_completed") {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET pending_balance = GREATEST(0, pending_balance - $1),
           wallet_balance = wallet_balance + $1,
           updated_at = NOW()
       WHERE driver_id = $2`,
      [amount, driverId],
    );
    await client.query(
      `INSERT INTO driver_wallet_ledger (driver_id, order_id, amount, entry_type, note)
       VALUES ($1, $2, $3, 'available_credit', $4)`,
      [driverId, orderId, amount, note],
    );
  }

  static async reversePending(client, driverId, amount, orderId, note = "assignment_cancelled") {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET pending_balance = GREATEST(0, pending_balance - $1),
           updated_at = NOW()
       WHERE driver_id = $2`,
      [amount, driverId],
    );
    await client.query(
      `INSERT INTO driver_wallet_ledger (driver_id, order_id, amount, entry_type, note)
       VALUES ($1, $2, $3, 'pending_debit', $4)`,
      [driverId, orderId, amount, note],
    );
  }

  static async getWallet(driverId) {
    const result = await this.query(
      `SELECT driver_id, wallet_balance, pending_balance, updated_at
       FROM driver_wallets WHERE driver_id = $1`,
      [driverId],
    );
    return result.rows[0] || { driver_id: driverId, wallet_balance: "0.00", pending_balance: "0.00" };
  }

  static async createPayoutRequest(driverId, amount) {
    return await this.transaction(async (client) => {
      await this.ensureWallet(client, driverId);
      const walletRes = await client.query(
        `SELECT wallet_balance FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
        [driverId],
      );
      const walletBalance = parseFloat(walletRes.rows[0].wallet_balance || 0);
      const requested = parseFloat(amount || 0);
      if (requested <= 0) throw new Error("Invalid payout amount");
      if (walletBalance < requested) throw new Error("Insufficient available wallet balance");

      await client.query(
        `UPDATE driver_wallets SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE driver_id = $2`,
        [requested, driverId],
      );

      const payout = await client.query(
        `INSERT INTO driver_payout_requests (driver_id, amount, status)
         VALUES ($1, $2, 'requested') RETURNING *`,
        [driverId, requested],
      );

      await client.query(
        `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
         VALUES ($1, $2, 'payout_debit', 'payout_requested')`,
        [driverId, requested],
      );

      return payout.rows[0];
    });
  }
}

module.exports = DriverWallet;
