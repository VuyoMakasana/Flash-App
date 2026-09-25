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

// Phase 3 additions below the original storefront tests: the onboarding
// lifecycle methods, and the storefront gate that keeps an unapproved store
// out of the public directory.
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — onboarding lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STORE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('Store.createApplication', () => {
  test('creates the store inactive and pending, whatever the applicant sent', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.createApplication({
      name: 'Kwazakhele Threads',
      ownerName: 'Nomsa',
      ownerEmail: 'nomsa@example.com',
    });

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO stores/);
    expect(sql).toMatch(/false, 'pending'/);
  });
});

describe('Store.approve / Store.reject', () => {
  test('approve activates the store and records who decided', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.approve(STORE_ID, ADMIN_ID);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'approved'/);
    expect(sql).toMatch(/is_active = true/);
    expect(sql).toMatch(/reviewed_by = \$2/);
    expect(params).toEqual([STORE_ID, ADMIN_ID]);
  });

  // The race guard: both transitions are scoped to the states they are legal
  // from, so a second caller updates zero rows instead of re-deciding.
  test.each([['approve'], ['reject']])('%s only applies to an undecided application', async (method) => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = method === 'approve'
      ? await Store.approve(STORE_ID, ADMIN_ID)
      : await Store.reject(STORE_ID, ADMIN_ID, 'reason');

    expect(pool.query.mock.calls[0][0]).toMatch(/status IN \('pending','under_review'\)/);
    expect(result).toBeNull();
  });

  test('reject records the reason and leaves the store offline', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.reject(STORE_ID, ADMIN_ID, 'Outside service area');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'rejected'/);
    expect(sql).toMatch(/is_active = false/);
    expect(params).toContain('Outside service area');
  });

  test('approve clears any earlier rejection reason', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.approve(STORE_ID, ADMIN_ID);
    expect(pool.query.mock.calls[0][0]).toMatch(/rejection_reason = NULL/);
  });
});

describe('storefront visibility gate', () => {
  // An application must not be discoverable by customers before a human has
  // approved it -- is_active alone was not enough once pending stores existed.
  test('listActive requires approved status, not just is_active', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Store.listActive(1, 20);
    expect(pool.query.mock.calls[0][0]).toMatch(/is_active = true AND status = 'approved'/);
  });

  test('findPublicById requires approved status too', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Store.findPublicById(STORE_ID);
    expect(pool.query.mock.calls[0][0]).toMatch(/is_active = true AND status = 'approved'/);
  });

  test('the review queue never exposes the public column allowlist\'s omissions by accident', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await Store.listByStatus('pending');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE status = \$1/);
    expect(params[0]).toBe('pending');
    // This one is admin-facing, so owner contact details are expected here --
    // the opposite of listActive. Asserted so the two cannot be confused.
    expect(sql).toMatch(/owner_email/);
  });
});
