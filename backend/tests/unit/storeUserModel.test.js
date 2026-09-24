'use strict';
/**
 * tests/unit/storeUserModel.test.js
 *
 * StoreUser — store-scoped staff accounts. Two things matter here and both are
 * asserted against the SQL actually issued rather than against a restatement
 * of the model's logic:
 *
 *   1. Every multi-row operation is scoped by store_id IN THE QUERY, not merely
 *      checked beforehand. A caller passing the wrong store must update zero
 *      rows, not the wrong store's row.
 *   2. Account deletion anonymizes rather than hard-deletes, so store_actions'
 *      audit trail (which references store_user_id) survives.
 *
 * findByEmail/findById are deliberately NOT store-scoped: they identify a user
 * before any store scope exists (login, and authenticateStore's own lookup).
 * That asymmetry is intentional and is pinned here so it cannot be "fixed" by
 * accident later.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const StoreUser = require('../../src/models/StoreUser');

const STORE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => jest.clearAllMocks());

describe('lookups used before a store scope exists', () => {
  test('findByEmail matches on email alone, by design', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.findByEmail('owner@example.com');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM store_users WHERE email=\$1/);
    expect(params).toEqual(['owner@example.com']);
  });

  test('findByEmail returns null rather than undefined when nothing matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(StoreUser.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  test('findById returns null when nothing matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(StoreUser.findById(USER_ID)).resolves.toBeNull();
  });
});

describe('create', () => {
  test('binds the caller-supplied store and never selects the password hash back', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.create({
      storeId: STORE_A,
      name: 'Sam',
      email: 'sam@example.com',
      passwordHash: 'hashed',
      role: 'store_manager',
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe(STORE_A);
    expect(sql).toMatch(/INSERT INTO store_users/);
    // The RETURNING clause must not leak the hash back to a caller that may
    // serialise it straight into a response.
    expect(sql).not.toMatch(/RETURNING[\s\S]*password_hash/);
  });

  test('new staff are active, and not forced into a password reset unless asked', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.create({
      storeId: STORE_A, name: 'Sam', email: 's@e.com', passwordHash: 'h', role: 'sales_staff',
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/is_active[\s\S]*VALUES[\s\S]*true/);
    expect(params[5]).toBe(false);
  });

  test('forcePasswordReset is honoured when a temporary password is issued', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.create({
      storeId: STORE_A, name: 'Sam', email: 's@e.com', passwordHash: 'h',
      role: 'owner', forcePasswordReset: true,
    });

    expect(pool.query.mock.calls[0][1][5]).toBe(true);
  });
});

describe('store scoping on reads and writes', () => {
  test('listByStore filters to the given store', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await StoreUser.listByStore(STORE_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE store_id = \$1/);
    expect(params).toEqual([STORE_A]);
    expect(sql).not.toMatch(/password_hash/);
  });

  test('deactivate scopes by store in the UPDATE itself', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.deactivate(USER_ID, STORE_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND store_id = \$2/);
    expect(params).toEqual([USER_ID, STORE_A]);
  });

  // The isolation guarantee, stated as a behaviour rather than a code shape:
  // targeting another store's staff must change nothing and report nothing.
  test('deactivating another store\'s staff member affects no row and returns null', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // scoped UPDATE matched nothing
    await expect(StoreUser.deactivate(USER_ID, STORE_B)).resolves.toBeNull();
  });
});

describe('anonymize — deletion without destroying the audit trail', () => {
  test('replaces identity, disables the account, and stays store-scoped', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.anonymize(USER_ID, STORE_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE store_users/);
    expect(sql).not.toMatch(/DELETE/);
    expect(sql).toMatch(/is_active = false/);
    expect(sql).toMatch(/WHERE id = \$1 AND store_id = \$4/);
    expect(params[1]).toBe(`deleted-${USER_ID}@flash.invalid`);
    expect(params[3]).toBe(STORE_A);
  });

  test('the replacement password hash is real bcrypt and not a known value', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.anonymize(USER_ID, STORE_A);

    const hash = pool.query.mock.calls[0][1][2];
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toMatch(/deleted|flash\.invalid|password/i);
  });

  test('the anonymized email is unique per user, satisfying the UNIQUE constraint', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'other' }] });
    await StoreUser.anonymize('other-id', STORE_A);
    const emailForOther = pool.query.mock.calls[0][1][1];

    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    await StoreUser.anonymize(USER_ID, STORE_A);
    const emailForThis = pool.query.mock.calls[0][1][1];

    expect(emailForOther).not.toBe(emailForThis);
  });

  test('anonymizing another store\'s staff member affects no row', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(StoreUser.anonymize(USER_ID, STORE_B)).resolves.toBeNull();
  });
});
