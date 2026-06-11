'use strict';
/**
 * tests/unit/driverCommission.test.js
 *
 * Tests for the R20 cash commission system.
 * Covers: recording, auto-deduction, threshold blocking, payout deduction.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const commissionService = require('../../src/services/driverCommissionService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

// ─── recordCashCommission ─────────────────────────────────────────────────────

describe('recordCashCommission', () => {
  const DRIVER_ID = 'driver-uuid-001';
  const ORDER_ID  = 'order-uuid-001';

  beforeEach(() => jest.clearAllMocks());

  test('inserts debt row and increments counters', async () => {
    const client = makeClient();

    // INSERT returns a new row (not a duplicate)
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'debt-uuid' }] })   // INSERT debt
      .mockResolvedValueOnce({ rows: [] })                       // upsert wallet
      .mockResolvedValueOnce({                                   // wallet SELECT FOR UPDATE
        rows: [{ wallet_balance: '0.00', cash_commission_debt: '20.00', unpaid_cash_deliveries: '1' }],
      });

    await commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID);

    // First call: INSERT into driver_commission_debts
    expect(client.query.mock.calls[0][0]).toMatch(/INSERT INTO driver_commission_debts/);
    // Second call: upsert driver_wallets
    expect(client.query.mock.calls[1][0]).toMatch(/INSERT INTO driver_wallets/);
  });

  test('auto-deducts from wallet when balance >= R20', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'debt-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ wallet_balance: '50.00', cash_commission_debt: '20.00', unpaid_cash_deliveries: '1' }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE wallet (deduct)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE debt status
      .mockResolvedValueOnce({ rows: [{ cash_commission_debt: '0.00', unpaid_cash_deliveries: '0' }] }); // re-read

    await commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID);

    const updateCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('wallet_balance = wallet_balance - $1'),
    );
    expect(updateCall).toBeDefined();
  });

  test('blocks driver when debt >= R200 threshold', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'debt-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ wallet_balance: '0.00', cash_commission_debt: '200.00', unpaid_cash_deliveries: '10' }],
      });

    await commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID);

    const blockCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('commission_blocked = true'),
    );
    expect(blockCall).toBeDefined();
  });

  test('blocks driver when unpaid_cash_deliveries >= 10', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'debt-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ wallet_balance: '0.00', cash_commission_debt: '180.00', unpaid_cash_deliveries: '10' }],
      });

    await commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID);

    const blockCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('commission_blocked = true'),
    );
    expect(blockCall).toBeDefined();
  });

  test('is idempotent — duplicate order_id inserts nothing', async () => {
    const client = makeClient();

    // ON CONFLICT DO NOTHING returns no rows
    client.query.mockResolvedValueOnce({ rows: [] });

    await commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID);

    // Only the INSERT was called; no further wallet updates
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('throws when wallet row missing after insert', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'debt-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // wallet not found

    await expect(
      commissionService.recordCashCommission(client, DRIVER_ID, ORDER_ID),
    ).rejects.toThrow(/Wallet not found/);
  });
});

// ─── checkCommissionBlock ─────────────────────────────────────────────────────

describe('checkCommissionBlock', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns blocked=false when no debt', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        commission_blocked: false,
        cash_commission_debt: '0.00',
        unpaid_cash_deliveries: '0',
      }],
    });

    const result = await commissionService.checkCommissionBlock('driver-001');
    expect(result.blocked).toBe(false);
    expect(result.debtAmount).toBe(0);
  });

  test('returns blocked=true when commission_blocked column is true', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        commission_blocked: true,
        cash_commission_debt: '40.00',
        unpaid_cash_deliveries: '2',
      }],
    });

    const result = await commissionService.checkCommissionBlock('driver-001');
    expect(result.blocked).toBe(true);
    expect(result.debtAmount).toBe(40);
  });

  test('recomputes blocked from live wallet values even if column is false', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        commission_blocked: false,
        cash_commission_debt: '200.00',
        unpaid_cash_deliveries: '10',
      }],
    });

    const result = await commissionService.checkCommissionBlock('driver-001');
    expect(result.blocked).toBe(true);
  });

  test('returns blocked=false for unknown driver', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await commissionService.checkCommissionBlock('unknown-driver');
    expect(result.blocked).toBe(false);
  });
});

// ─── deductDebtBeforePayout ───────────────────────────────────────────────────

describe('deductDebtBeforePayout', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns full amount when no debt', async () => {
    const client = makeClient({
      query: jest.fn().mockResolvedValue({
        rows: [{ cash_commission_debt: '0.00', unpaid_cash_deliveries: '0' }],
      }),
    });

    const net = await commissionService.deductDebtBeforePayout(client, 'driver-001', 150);
    expect(net).toBe(150);
  });

  test('deducts partial debt and returns net payout', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({                          // SELECT FOR UPDATE
        rows: [{ cash_commission_debt: '40.00', unpaid_cash_deliveries: '2' }],
      })
      .mockResolvedValueOnce({ rows: [] })              // UPDATE wallet debt to 0
      .mockResolvedValueOnce({ rows: [] })              // UPDATE debt records
      .mockResolvedValueOnce({                          // re-read for unblock check
        rows: [{ cash_commission_debt: '0.00', unpaid_cash_deliveries: '0' }],
      })
      .mockResolvedValueOnce({ rows: [] });             // unblock drivers

    const net = await commissionService.deductDebtBeforePayout(client, 'driver-001', 150);
    expect(net).toBe(110); // 150 - 40
  });

  test('throws when debt >= payout amount (entire payout absorbed)', async () => {
    const client = makeClient();

    client.query
      .mockResolvedValueOnce({
        rows: [{ cash_commission_debt: '200.00', unpaid_cash_deliveries: '10' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cash_commission_debt: '100.00', unpaid_cash_deliveries: '5' }] });

    await expect(
      commissionService.deductDebtBeforePayout(client, 'driver-001', 150),
    ).rejects.toThrow(/fully absorbed/);
  });
});

// ─── getWalletWithDebt ────────────────────────────────────────────────────────

describe('getWalletWithDebt', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns formatted wallet with commission fields', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        wallet_balance: '120.00',
        pending_balance: '30.00',
        cash_commission_debt: '40.00',
        unpaid_cash_deliveries: '2',
        commission_blocked: false,
      }],
    });

    const w = await commissionService.getWalletWithDebt('driver-001');
    expect(w.wallet_balance).toBe('120.00');
    expect(w.cash_commission_debt).toBe('40.00');
    expect(w.unpaid_cash_deliveries).toBe(2);
    expect(w.commission_blocked).toBe(false);
    expect(w.unblock_amount_needed).toBe(0);
  });

  test('returns zero defaults for unknown driver', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const w = await commissionService.getWalletWithDebt('unknown');
    expect(w.wallet_balance).toBe('0.00');
    expect(w.commission_blocked).toBe(false);
  });

  test('computes commission_blocked true from live thresholds', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        wallet_balance: '0.00',
        pending_balance: '0.00',
        cash_commission_debt: '200.00',
        unpaid_cash_deliveries: '10',
        commission_blocked: false,
      }],
    });

    const w = await commissionService.getWalletWithDebt('driver-001');
    expect(w.commission_blocked).toBe(true);
    expect(w.unblock_amount_needed).toBeGreaterThan(0);
  });
});
