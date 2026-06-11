'use strict';
/**
 * driverCommissionService.js
 *
 * Handles the R20 cash commission system:
 *   - Records commission debt after each cash delivery
 *   - Auto-deducts from wallet when balance allows
 *   - Blocks driver when thresholds exceeded (R200 debt OR 10 unpaid deliveries)
 *   - Deducts outstanding debt before every payout
 *
 * All writes that touch order completion MUST be called inside the same
 * DB transaction that marks the order completed.
 */

const pool = require('../config/database');

const COMMISSION_AMOUNT = 20.00;   // R per cash delivery
const DEBT_THRESHOLD    = 200.00;  // Block driver if debt >= R200
const COUNT_THRESHOLD   = 10;      // Block driver if unpaid deliveries >= 10

// ─────────────────────────────────────────────────────────────────────────────
// recordCashCommission
//
// Called inside confirmCashReceived transaction AFTER order is marked paid.
// Idempotent: the driver_commission_debts table has UNIQUE(order_id).
//
// @param {pg.PoolClient} client  — open transaction client
// @param {string}        driverId
// @param {string}        orderId
// ─────────────────────────────────────────────────────────────────────────────
async function recordCashCommission(client, driverId, orderId) {
  // 1. Insert commission debt row (idempotent via ON CONFLICT DO NOTHING)
  const insertResult = await client.query(
    `INSERT INTO driver_commission_debts
       (driver_id, order_id, commission_amount, status)
     VALUES ($1, $2, $3, 'outstanding')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id`,
    [driverId, orderId, COMMISSION_AMOUNT],
  );

  // If nothing was inserted it means this order already had a debt row — skip.
  if (!insertResult.rows.length) {
    return;
  }

  // 2. Increment debt counters on driver_wallets
  await client.query(
    `INSERT INTO driver_wallets (driver_id, wallet_balance, pending_balance,
                                 cash_commission_debt, unpaid_cash_deliveries)
     VALUES ($1, 0, 0, $2, 1)
     ON CONFLICT (driver_id) DO UPDATE
       SET cash_commission_debt      = driver_wallets.cash_commission_debt + $2,
           unpaid_cash_deliveries    = driver_wallets.unpaid_cash_deliveries + 1,
           updated_at                = NOW()`,
    [driverId, COMMISSION_AMOUNT],
  );

  // 3. Check if wallet balance covers the commission → auto-deduct
  const walletRes = await client.query(
    `SELECT wallet_balance, cash_commission_debt, unpaid_cash_deliveries
     FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
    [driverId],
  );

  const wallet = walletRes.rows[0];
  if (!wallet) {
    throw new Error(`[Commission] Wallet not found for driver ${driverId}`);
  }

  const walletBalance   = parseFloat(wallet.wallet_balance);
  const currentDebt     = parseFloat(wallet.cash_commission_debt);
  const unpaidCount     = parseInt(wallet.unpaid_cash_deliveries, 10);

  if (walletBalance >= COMMISSION_AMOUNT) {
    // Auto-deduct from wallet
    await client.query(
      `UPDATE driver_wallets
       SET wallet_balance         = wallet_balance - $1,
           cash_commission_debt   = GREATEST(0, cash_commission_debt - $1),
           unpaid_cash_deliveries = GREATEST(0, unpaid_cash_deliveries - 1),
           updated_at             = NOW()
       WHERE driver_id = $2`,
      [COMMISSION_AMOUNT, driverId],
    );

    await client.query(
      `UPDATE driver_commission_debts
       SET status = 'collected_wallet', settled_at = NOW()
       WHERE order_id = $1`,
      [orderId],
    );

    // After auto-deduct, re-read to check thresholds
    const updatedWallet = await client.query(
      `SELECT cash_commission_debt, unpaid_cash_deliveries
       FROM driver_wallets WHERE driver_id = $1`,
      [driverId],
    );
    const updatedDebt  = parseFloat(updatedWallet.rows[0]?.cash_commission_debt || 0);
    const updatedCount = parseInt(updatedWallet.rows[0]?.unpaid_cash_deliveries || 0, 10);

    if (updatedDebt >= DEBT_THRESHOLD || updatedCount >= COUNT_THRESHOLD) {
      await _blockDriver(client, driverId);
    } else {
      // Ensure driver is not blocked if thresholds are clear
      await client.query(
        `UPDATE drivers SET commission_blocked = false WHERE id = $1 AND commission_blocked = true`,
        [driverId],
      );
    }
  } else {
    // Cannot auto-deduct — check thresholds with new values
    if (currentDebt >= DEBT_THRESHOLD || unpaidCount >= COUNT_THRESHOLD) {
      await _blockDriver(client, driverId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkCommissionBlock
//
// Returns block status for a driver. Used before going online or accepting
// an order. Does NOT write.
//
// @param {string} driverId
// @returns {{ blocked: boolean, debtAmount: number, unpaidDeliveries: number }}
// ─────────────────────────────────────────────────────────────────────────────
async function checkCommissionBlock(driverId) {
  const result = await pool.query(
    `SELECT d.commission_blocked,
            COALESCE(dw.cash_commission_debt, 0)    AS cash_commission_debt,
            COALESCE(dw.unpaid_cash_deliveries, 0)  AS unpaid_cash_deliveries
     FROM drivers d
     LEFT JOIN driver_wallets dw ON dw.driver_id = d.id
     WHERE d.id = $1`,
    [driverId],
  );

  if (!result.rows.length) {
    return { blocked: false, debtAmount: 0, unpaidDeliveries: 0 };
  }

  const row          = result.rows[0];
  const debtAmount   = parseFloat(row.cash_commission_debt);
  const unpaidCount  = parseInt(row.unpaid_cash_deliveries, 10);
  const flagged      = row.commission_blocked === true;

  // Recompute from live wallet values in case the column is stale
  const blocked = flagged || debtAmount >= DEBT_THRESHOLD || unpaidCount >= COUNT_THRESHOLD;

  return { blocked, debtAmount, unpaidDeliveries: unpaidCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// deductDebtBeforePayout
//
// Called inside createPayoutRequest transaction BEFORE the payout amount is
// subtracted from wallet_balance.
//
// Returns the net amount available for payout after debt settlement.
//
// @param {pg.PoolClient} client
// @param {string}        driverId
// @param {number}        requestedAmount  — how much driver wants to withdraw
// @returns {number}  netPayout — amount to actually transfer
// ─────────────────────────────────────────────────────────────────────────────
async function deductDebtBeforePayout(client, driverId, requestedAmount) {
  const walletRes = await client.query(
    `SELECT cash_commission_debt, unpaid_cash_deliveries
     FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
    [driverId],
  );

  const debt = parseFloat(walletRes.rows[0]?.cash_commission_debt || 0);

  if (debt <= 0) {
    return requestedAmount; // nothing to deduct
  }

  if (debt >= requestedAmount) {
    // Entire payout absorbed by debt
    const absorbed = Math.min(debt, requestedAmount);

    await client.query(
      `UPDATE driver_wallets
       SET cash_commission_debt      = GREATEST(0, cash_commission_debt - $1),
           unpaid_cash_deliveries    = 0,
           updated_at                = NOW()
       WHERE driver_id = $2`,
      [absorbed, driverId],
    );

    await client.query(
      `UPDATE driver_commission_debts
       SET status = 'collected_payout', settled_at = NOW()
       WHERE driver_id = $1 AND status = 'outstanding'`,
      [driverId],
    );

    await _maybeUnblockDriver(client, driverId);

    throw new Error(
      `Your payout of R${requestedAmount.toFixed(2)} was fully absorbed by your outstanding commission debt of R${debt.toFixed(2)}. ` +
      `Your debt balance is now R${Math.max(0, debt - absorbed).toFixed(2)}.`,
    );
  }

  // Partial deduction
  await client.query(
    `UPDATE driver_wallets
     SET cash_commission_debt      = 0,
         unpaid_cash_deliveries    = 0,
         updated_at                = NOW()
     WHERE driver_id = $1`,
    [driverId],
  );

  await client.query(
    `UPDATE driver_commission_debts
     SET status = 'collected_payout', settled_at = NOW()
     WHERE driver_id = $1 AND status = 'outstanding'`,
    [driverId],
  );

  await _maybeUnblockDriver(client, driverId);

  return requestedAmount - debt;
}

// ─────────────────────────────────────────────────────────────────────────────
// getWalletWithDebt
//
// Returns wallet + commission fields for GET /api/drivers/wallet
// ─────────────────────────────────────────────────────────────────────────────
async function getWalletWithDebt(driverId) {
  const result = await pool.query(
    `SELECT dw.wallet_balance,
            dw.pending_balance,
            COALESCE(dw.cash_commission_debt, 0)   AS cash_commission_debt,
            COALESCE(dw.unpaid_cash_deliveries, 0) AS unpaid_cash_deliveries,
            d.commission_blocked
     FROM driver_wallets dw
     JOIN drivers d ON d.id = dw.driver_id
     WHERE dw.driver_id = $1`,
    [driverId],
  );

  if (!result.rows.length) {
    return {
      wallet_balance:        '0.00',
      pending_balance:       '0.00',
      cash_commission_debt:  '0.00',
      unpaid_cash_deliveries: 0,
      commission_blocked:    false,
      unblock_amount_needed: 0,
    };
  }

  const row           = result.rows[0];
  const debt          = parseFloat(row.cash_commission_debt);
  const unpaid        = parseInt(row.unpaid_cash_deliveries, 10);
  const blocked       = row.commission_blocked || debt >= DEBT_THRESHOLD || unpaid >= COUNT_THRESHOLD;
  const amountNeeded  = blocked
    ? Math.max(0, DEBT_THRESHOLD - parseFloat(row.wallet_balance))
    : 0;

  return {
    wallet_balance:         parseFloat(row.wallet_balance).toFixed(2),
    pending_balance:        parseFloat(row.pending_balance).toFixed(2),
    cash_commission_debt:   debt.toFixed(2),
    unpaid_cash_deliveries: unpaid,
    commission_blocked:     blocked,
    unblock_amount_needed:  amountNeeded > 0 ? parseFloat(amountNeeded.toFixed(2)) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _blockDriver(client, driverId) {
  await client.query(
    `UPDATE drivers
     SET commission_blocked = true,
         is_online          = false,
         updated_at         = NOW()
     WHERE id = $1`,
    [driverId],
  );
}

async function _maybeUnblockDriver(client, driverId) {
  // Re-read fresh values to decide
  const res = await client.query(
    `SELECT cash_commission_debt, unpaid_cash_deliveries
     FROM driver_wallets WHERE driver_id = $1`,
    [driverId],
  );

  const debt  = parseFloat(res.rows[0]?.cash_commission_debt || 0);
  const count = parseInt(res.rows[0]?.unpaid_cash_deliveries || 0, 10);

  if (debt < DEBT_THRESHOLD && count < COUNT_THRESHOLD) {
    await client.query(
      `UPDATE drivers
       SET commission_blocked = false, updated_at = NOW()
       WHERE id = $1`,
      [driverId],
    );
  }
}

module.exports = {
  recordCashCommission,
  checkCommissionBlock,
  deductDebtBeforePayout,
  getWalletWithDebt,
  COMMISSION_AMOUNT,
  DEBT_THRESHOLD,
  COUNT_THRESHOLD,
};
