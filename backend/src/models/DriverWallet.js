'use strict';

const BaseModel = require('./BaseModel');
const { deductDebtBeforePayout } = require('../services/driverCommissionService');

class DriverWallet extends BaseModel {
  static async ensureWallet(client, driverId) {
    await client.query(
      `INSERT INTO driver_wallets
         (driver_id, wallet_balance, pending_balance, cash_commission_debt, unpaid_cash_deliveries)
       VALUES ($1, 0, 0, 0, 0)
       ON CONFLICT (driver_id) DO NOTHING`,
      [driverId],
    );
  }

  static async addPending(client, driverId, amount, orderId, note = 'pending_credit') {
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

  static async releasePending(client, driverId, amount, orderId, note = 'delivery_completed') {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET pending_balance = GREATEST(0, pending_balance - $1),
           wallet_balance  = wallet_balance + $1,
           updated_at      = NOW()
       WHERE driver_id = $2`,
      [amount, driverId],
    );
    await client.query(
      `INSERT INTO driver_wallet_ledger (driver_id, order_id, amount, entry_type, note)
       VALUES ($1, $2, $3, 'available_credit', $4)`,
      [driverId, orderId, amount, note],
    );
  }

  // Immediate credit with no pending stage — used for compensation that
  // isn't tied to a future delivery-completion event (e.g. the driver's
  // pre-pickup cancellation share), where there's nothing left to "release"
  // later. Mirrors releasePending's wallet_balance credit exactly, minus the
  // pending_balance subtraction since nothing was ever added to pending for it.
  static async creditAvailable(client, driverId, amount, orderId, note = 'available_credit') {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET wallet_balance = wallet_balance + $1, updated_at = NOW()
       WHERE driver_id = $2`,
      [amount, driverId],
    );
    await client.query(
      `INSERT INTO driver_wallet_ledger (driver_id, order_id, amount, entry_type, note)
       VALUES ($1, $2, $3, 'available_credit', $4)`,
      [driverId, orderId, amount, note],
    );
  }

  static async reversePending(client, driverId, amount, orderId, note = 'assignment_cancelled') {
    await this.ensureWallet(client, driverId);
    await client.query(
      `UPDATE driver_wallets
       SET pending_balance = GREATEST(0, pending_balance - $1), updated_at = NOW()
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
      `SELECT dw.driver_id, dw.wallet_balance, dw.pending_balance,
              COALESCE(dw.cash_commission_debt, 0)   AS cash_commission_debt,
              COALESCE(dw.unpaid_cash_deliveries, 0) AS unpaid_cash_deliveries,
              dw.updated_at
       FROM driver_wallets dw
       WHERE dw.driver_id = $1`,
      [driverId],
    );
    return result.rows[0] || {
      driver_id: driverId,
      wallet_balance: '0.00',
      pending_balance: '0.00',
      cash_commission_debt: '0.00',
      unpaid_cash_deliveries: 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createPayoutRequest
  //
  // COMMISSION DEDUCTION: any outstanding commission debt is deducted from
  // the requested payout amount before the net transfer is made.
  // ─────────────────────────────────────────────────────────────────────────
  static async createPayoutRequest(driverId, amount) {
    return await this.transaction(async (client) => {
      await this.ensureWallet(client, driverId);

      const walletRes = await client.query(
        `SELECT wallet_balance, cash_commission_debt
         FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
        [driverId],
      );

      const walletBalance = parseFloat(walletRes.rows[0]?.wallet_balance || 0);
      const requested     = parseFloat(amount || 0);

      if (requested <= 0)            throw new Error('Invalid payout amount');
      if (walletBalance < requested) throw new Error('Insufficient available wallet balance');

      // Deduct commission debt — may throw if entire payout is absorbed
      const netPayout = await deductDebtBeforePayout(client, driverId, requested);

      // Deduct net payout from wallet balance
      await client.query(
        `UPDATE driver_wallets
         SET wallet_balance = wallet_balance - $1, updated_at = NOW()
         WHERE driver_id = $2`,
        [netPayout, driverId],
      );

      const payout = await client.query(
        `INSERT INTO driver_payout_requests (driver_id, amount, status)
         VALUES ($1, $2, 'requested') RETURNING *`,
        [driverId, netPayout],
      );

      await client.query(
        `INSERT INTO driver_wallet_ledger (driver_id, amount, entry_type, note)
         VALUES ($1, $2, 'payout_debit', 'payout_requested')`,
        [driverId, netPayout],
      );

      return payout.rows[0];
    });
  }
}

module.exports = DriverWallet;
