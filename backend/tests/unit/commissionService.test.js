'use strict';
/**
 * tests/unit/commissionService.test.js
 *
 * Phase 2b — resolving the commission rate and computing what Flash earns on a
 * completed order. No money moves yet; this produces the number 2c will pay
 * against, so the arithmetic and the rate selection both have to be exactly
 * right before anything is transferable.
 *
 * The rate query carries most of the risk. A naive `WHERE is_active = true`
 * looks correct and passes a casual test, but silently applies a promotional
 * rate before it starts or after it ends. Several tests below exist purely to
 * pin the date predicates.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const {
  resolveCommissionRate,
  computeCommissionAmount,
  computeStoreCommission,
} = require('../../src/services/commissionService');

const STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RATE_ID = 'cf490038-de34-4d75-85a9-99a8878d0bf0';

beforeEach(() => jest.clearAllMocks());

describe('computeCommissionAmount', () => {
  test.each([
    ['100.00', 0.10, 10],
    ['279.00', 0.10, 27.9],
    ['33.33', 0.10, 3.33],
    ['0.01', 0.10, 0],       // rounds to zero cents, not a fraction of one
    ['99.99', 0.10, 10],
  ])('%s at %s -> %s', (subtotal, rate, expected) => {
    expect(computeCommissionAmount(subtotal, rate)).toBe(expected);
  });

  test('rounds to whole cents rather than leaving sub-cent precision', () => {
    // 12.345 would be a half-cent. Left unrounded it reaches a NUMERIC(10,2)
    // column and is truncated there instead, so the value JavaScript believes
    // and the value Postgres stores would differ -- the kind of gap that makes
    // a settlement total impossible to reconcile against its line items.
    const result = computeCommissionAmount('123.45', 0.10);
    expect(result).toBe(12.35);
    expect(Number.isInteger(Math.round(result * 100))).toBe(true);
  });

  test.each([
    [null], [undefined], [0], ['0.00'], ['-50.00'], ['not a number'],
  ])('a non-positive or unusable subtotal (%s) yields 0, never NaN', (subtotal) => {
    expect(computeCommissionAmount(subtotal, 0.10)).toBe(0);
  });
});

describe('resolveCommissionRate — the date window is actually enforced', () => {
  function mockRows(rows) {
    pool.query.mockResolvedValue({ rows });
  }

  test('the query constrains BOTH starts_at and ends_at against NOW()', async () => {
    // This is the assertion that stops the naive version shipping. Without
    // these predicates a promotional row flagged active would apply outside
    // its own window.
    mockRows([{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }]);
    await resolveCommissionRate(pool, STORE_ID);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/starts_at IS NULL OR starts_at <= NOW\(\)/);
    expect(sql).toMatch(/ends_at\s+IS NULL OR ends_at\s+>= NOW\(\)/);
    expect(sql).toMatch(/is_active = true/);
  });

  test('precedence is promotional, then store, then global', async () => {
    mockRows([{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }]);
    await resolveCommissionRate(pool, STORE_ID);

    const [sql] = pool.query.mock.calls[0];
    // Ordered by specificity so a store override beats the global default
    // without any code change -- the tiers are data, not branches.
    expect(sql).toMatch(/WHEN 'promotional' THEN 1/);
    expect(sql).toMatch(/WHEN 'store'\s+THEN 2/);
    expect(sql).toMatch(/ELSE 3/);
  });

  test('store-scoped rows are matched against the store, global against everyone', async () => {
    mockRows([{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }]);
    await resolveCommissionRate(pool, STORE_ID);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/scope_type = 'global'/);
    expect(sql).toMatch(/scope_type IN \('store', 'promotional'\) AND store_id = \$1/);
    expect(params).toEqual([STORE_ID]);
  });

  test('returns the rate as a number, not the string Postgres hands back', async () => {
    mockRows([{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }]);
    const result = await resolveCommissionRate(pool, STORE_ID);

    expect(result).toEqual({ id: RATE_ID, rate: 0.1, scopeType: 'global' });
    expect(typeof result.rate).toBe('number');
  });

  test('no configured rate returns null — never a silent zero', async () => {
    // Zero would mean "Flash takes nothing" and would settle the full item
    // value to the store. Null means "do not stamp", which is recoverable.
    mockRows([]);
    expect(await resolveCommissionRate(pool, STORE_ID)).toBeNull();
  });

  test('reads through the client it is given, so it joins the caller transaction', async () => {
    // Must see uncommitted state and be rolled back with the completion if
    // that transaction fails.
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await resolveCommissionRate(client, STORE_ID);

    expect(client.query).toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('computeStoreCommission', () => {
  test('returns amount, rate and rate id together for provenance', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }],
    });

    const result = await computeStoreCommission(pool, { storeId: STORE_ID, subtotal: '279.00' });

    expect(result).toEqual({
      amount: 27.9,
      rate: 0.1,
      rateId: RATE_ID,
      scopeType: 'global',
    });
  });

  test('returns null when no rate is configured, so the caller leaves columns NULL', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await computeStoreCommission(pool, { storeId: STORE_ID, subtotal: '100.00' })).toBeNull();
  });

  test('a zero-subtotal order still resolves, with zero commission', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: RATE_ID, rate: '0.1000', scope_type: 'global' }],
    });
    const result = await computeStoreCommission(pool, { storeId: STORE_ID, subtotal: '0.00' });
    expect(result.amount).toBe(0);
    // Still stamped, so the order is distinguishable from one never processed.
    expect(result.rateId).toBe(RATE_ID);
  });
});
