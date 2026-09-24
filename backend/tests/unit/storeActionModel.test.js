'use strict';
/**
 * tests/unit/storeActionModel.test.js
 *
 * StoreAction — the store-scoped audit log. Two properties are worth pinning:
 *
 *   1. log() must never be able to break the operation it is recording. It is
 *      called after a successful write (order accepted, stock changed, staff
 *      created) and is deliberately fire-and-forget: if the audit insert fails,
 *      the store owner's action has already happened and must still succeed.
 *      A throw here would turn a completed action into a 500.
 *   2. Every row carries store_id directly, so "did this manager touch an order
 *      that wasn't theirs" is answerable from the log alone, without joining
 *      back through the actor.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const StoreAction = require('../../src/models/StoreAction');

const STORE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TARGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

beforeEach(() => jest.clearAllMocks());

describe('log', () => {
  test('records actor, store, action and target', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await StoreAction.log(USER_ID, STORE_A, 'order_accept', 'orders', TARGET_ID);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO store_actions/);
    expect(params.slice(0, 5)).toEqual([USER_ID, STORE_A, 'order_accept', 'orders', TARGET_ID]);
  });

  test('metadata is serialised as JSON, and absent metadata is null not "null"', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await StoreAction.log(USER_ID, STORE_A, 'a', 't', TARGET_ID, { role: 'owner' });
    expect(pool.query.mock.calls[0][1][5]).toBe(JSON.stringify({ role: 'owner' }));

    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    await StoreAction.log(USER_ID, STORE_A, 'a');
    expect(pool.query.mock.calls[0][1][5]).toBeNull();
  });

  test('optional target fields default to null rather than undefined', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await StoreAction.log(USER_ID, STORE_A, 'store_login');

    const params = pool.query.mock.calls[0][1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  // The important one: this runs after the real action has already committed.
  test('a failing audit insert is swallowed, never thrown at the caller', async () => {
    pool.query.mockRejectedValue(new Error('store_actions is unavailable'));

    await expect(
      StoreAction.log(USER_ID, STORE_A, 'order_accept', 'orders', TARGET_ID),
    ).resolves.toBeUndefined();
  });
});

describe('getRecent', () => {
  test('is scoped to one store and joins the actor for display', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });
    await StoreAction.getRecent(STORE_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE sa\.store_id = \$1/);
    expect(sql).toMatch(/JOIN store_users su ON su\.id = sa\.store_user_id/);
    expect(params[0]).toBe(STORE_A);
  });

  test('newest first, with a bounded default limit', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await StoreAction.getRecent(STORE_A);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY sa\.created_at DESC LIMIT \$2/);
    expect(params[1]).toBe(100);
  });

  test('an explicit limit is bound as a parameter', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await StoreAction.getRecent(STORE_A, 10);
    expect(pool.query.mock.calls[0][1][1]).toBe(10);
  });

  // Unlike log(), this one is a read in a request path -- a failure should
  // surface, not be silently swallowed into an empty audit view.
  test('a read failure propagates rather than pretending the log is empty', async () => {
    pool.query.mockRejectedValue(new Error('connection lost'));
    await expect(StoreAction.getRecent(STORE_A)).rejects.toThrow('connection lost');
  });
});
