'use strict';
/**
 * tests/unit/storeModel.test.js
 *
 * Storefront port, Piece 2 — Store.listActive/findPublicById, the
 * customer-facing storefront's public store-directory reads (ported from
 * multi-tenant-stage7-customer-storefront). Asserts the PUBLIC_COLUMNS
 * allowlist actually reaches the query (never owner_name/owner_email/
 * owner_phone — staff-only contact info per
 * DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §1, same allowlist discipline
 * Inventory.js's PUBLIC_COLUMNS already established for products) and that
 * both methods filter to is_active stores only.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const Store = require('../../src/models/Store');

beforeEach(() => jest.clearAllMocks());

describe('Store.listActive', () => {
  test('selects only the public column allowlist, never owner contact info', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Store.listActive(1, 20);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/id, name, logo_url, banner_url, description, address/);
    expect(sql).not.toMatch(/owner_name|owner_email|owner_phone/);
    expect(sql).toMatch(/FROM stores WHERE is_active = true/);
  });

  test('paginates via LIMIT/OFFSET computed from page and limit', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Store.listActive(3, 10);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([10, 20]); // limit=10, offset=(3-1)*10
  });

  test('returns the rows from the query result', async () => {
    const rows = [{ id: 's1', name: 'Flash Closet' }];
    pool.query.mockResolvedValue({ rows });
    const result = await Store.listActive();
    expect(result).toBe(rows);
  });
});

describe('Store.findPublicById', () => {
  test('selects only the public column allowlist and filters by id + is_active', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 's1' }] });
    await Store.findPublicById('s1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/owner_name|owner_email|owner_phone/);
    expect(sql).toMatch(/WHERE id=\$1 AND is_active = true/);
    expect(params).toEqual(['s1']);
  });

  test('returns null when no row matches (not undefined)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await Store.findPublicById('missing');
    expect(result).toBeNull();
  });
});
