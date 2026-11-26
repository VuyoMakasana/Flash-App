'use strict';
/**
 * tests/unit/featureSwitches.test.js
 *
 * L0.5b (#98): the featureSwitches service, the requireFeature guard, and the
 * two guards that aren't routes (new accounts through Google/Apple sign-in,
 * and PayoutService.processRequestedPayout).
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/googleAuthService', () => ({ verifyGoogleToken: jest.fn() }));
jest.mock('../../src/services/appleAuthService', () => ({ verifyAppleToken: jest.fn() }));

const pool = require('../../src/config/database');
const {
  createFeatureSwitches, KEYS, FAIL_CLOSED, MESSAGES, CACHE_MS,
} = require('../../src/services/featureSwitches');
const { requireFeature } = require('../../src/middleware/requireFeature');

const allRows = (overrides = {}) => ({ rows: KEYS.map((key) => ({ key, enabled: overrides[key] ?? true })) });
const quietLog = { warn: jest.fn(), log: jest.fn() };

function make({ query, env = {}, connect } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sw = createFeatureSwitches({ query, env, connect, now: clock.now, log: quietLog });
  return { sw, clock };
}

afterEach(() => jest.clearAllMocks());

describe('featureSwitches.isEnabled', () => {
  test('reads the table once, then serves from a 15 s cache', async () => {
    const query = jest.fn().mockResolvedValue(allRows({ cash_orders: false }));
    const { sw, clock } = make({ query });
    expect(await sw.isEnabled('cash_orders')).toBe(false);
    expect(await sw.isEnabled('card_payments')).toBe(true);
    clock.advance(CACHE_MS - 1);
    expect(await sw.isEnabled('cash_orders')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await sw.isEnabled('cash_orders');
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('a change in the table applies after at most 15 s', async () => {
    const query = jest.fn().mockResolvedValueOnce(allRows()).mockResolvedValue(allRows({ new_orders: false }));
    const { sw, clock } = make({ query });
    expect(await sw.isEnabled('new_orders')).toBe(true);
    clock.advance(CACHE_MS);
    expect(await sw.isEnabled('new_orders')).toBe(false);
  });

  test('concurrent checks share one read', async () => {
    let resolve;
    const query = jest.fn(() => new Promise((r) => { resolve = r; }));
    const { sw } = make({ query });
    const checks = Promise.all([sw.isEnabled('signups'), sw.isEnabled('premium'), sw.isEnabled('new_orders')]);
    resolve(allRows({ signups: false }));
    expect(await checks).toEqual([false, true, true]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('if a read fails, the last known values are kept (and retried 15 s later)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(allRows({ card_payments: false, driver_payouts: true }))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(allRows());
    const { sw, clock } = make({ query });
    expect(await sw.isEnabled('card_payments')).toBe(false);
    clock.advance(CACHE_MS);
    expect(await sw.isEnabled('card_payments')).toBe(false);   // read failed: last known
    expect(await sw.isEnabled('driver_payouts')).toBe(true);   // last known, not the cold-start default
    expect(query).toHaveBeenCalledTimes(2);
    clock.advance(CACHE_MS);
    expect(await sw.isEnabled('card_payments')).toBe(true);
  });

  test('cold start with no value: money-moving switches fail CLOSED, the rest fail OPEN', async () => {
    const { sw } = make({ query: jest.fn().mockRejectedValue(new Error('database down')) });
    for (const key of KEYS) {
      expect(await sw.isEnabled(key)).toBe(!FAIL_CLOSED.has(key));
    }
    expect([...FAIL_CLOSED].sort()).toEqual(['boosts', 'driver_payouts', 'premium']);
  });

  test('a key missing from the table uses the same cold-start default', async () => {
    const { sw } = make({ query: jest.fn().mockResolvedValue({ rows: [{ key: 'card_payments', enabled: true }] }) });
    expect(await sw.isEnabled('driver_payouts')).toBe(false);
    expect(await sw.isEnabled('new_orders')).toBe(true);
  });

  test('an environment value of "off" always wins, even when the table says on, and needs no read', async () => {
    const query = jest.fn().mockResolvedValue(allRows());
    const { sw } = make({ query, env: { FEATURE_CARD_PAYMENTS: ' OFF ', FEATURE_NEW_ORDERS: 'on', FEATURE_SIGNUPS: 'false' } });
    expect(await sw.isEnabled('card_payments')).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(await sw.isEnabled('new_orders')).toBe(true);   // only "off" is an override
    expect(await sw.isEnabled('signups')).toBe(true);      // "false" is not "off"
  });

  test('an env "on" cannot switch on something the table has off', async () => {
    const { sw } = make({ query: jest.fn().mockResolvedValue(allRows({ boosts: false })), env: { FEATURE_BOOSTS: 'on' } });
    expect(await sw.isEnabled('boosts')).toBe(false);
  });

  test('an unknown key is a programming error', async () => {
    const { sw } = make({ query: jest.fn().mockResolvedValue(allRows()) });
    await expect(sw.isEnabled('maintenance_mode')).rejects.toThrow(/Unknown feature switch/);
  });

  test('getStatus lists every key with on/off and its fixed message', async () => {
    const { sw } = make({ query: jest.fn().mockResolvedValue(allRows({ premium: false })), env: { FEATURE_CASH_ORDERS: 'off' } });
    const status = await sw.getStatus();
    expect(Object.keys(status)).toEqual(KEYS);
    expect(status.premium).toEqual({ enabled: false, message: MESSAGES.premium });
    expect(status.cash_orders).toEqual({ enabled: false, message: MESSAGES.cash_orders });
    expect(status.card_payments).toEqual({ enabled: true, message: MESSAGES.card_payments });
  });

  test('the messages are exactly the approved wording', () => {
    expect(MESSAGES).toEqual({
      card_payments: 'Card payments are paused for a few minutes. Nothing has been charged, and your cart is saved. Please try again shortly.',
      new_orders: "Flash isn't taking new orders right now. Your cart is saved. Please try again a little later.",
      cash_orders: "Cash isn't available right now. Please pay the delivery fee by card.",
      driver_payouts: 'Payouts are paused for now. Your earnings are safe and will be paid when payouts resume.',
      store_portal_writes: 'Store settings are read-only for a few minutes while we do maintenance. Orders still work as normal.',
      signups: 'New sign-ups are paused right now. Please try again later.',
      premium: "This feature isn't available yet.",
      boosts: "This feature isn't available yet.",
    });
  });
});

describe('featureSwitches.setSwitch (the admin change)', () => {
  function client(current) {
    const calls = [];
    const c = {
      query: jest.fn(async (sql, params) => {
        calls.push([String(sql).trim(), params]);
        if (/SELECT enabled FROM feature_switches/.test(sql)) return { rows: current === undefined ? [] : [{ enabled: current }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    return { c, calls };
  }
  const ADMIN = '55555555-5555-4555-8555-555555555555';

  test('updates the row and writes the audit row in ONE transaction, then applies at once on this server', async () => {
    const { c, calls } = client(true);
    const query = jest.fn().mockResolvedValue(allRows());
    const { sw } = make({ query, connect: async () => c });
    expect(await sw.isEnabled('card_payments')).toBe(true);
    query.mockResolvedValue(allRows({ card_payments: false }));

    const result = await sw.setSwitch('card_payments', false, ADMIN, '  Paystack incident  ');

    expect(result).toEqual({ changed: true, key: 'card_payments', previous: true, enabled: false });
    const sqls = calls.map(([s]) => s);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/SELECT enabled FROM feature_switches WHERE key = \$1 FOR UPDATE/);
    expect(sqls[2]).toMatch(/UPDATE feature_switches SET enabled = \$2, updated_at = NOW\(\), updated_by = \$3 WHERE key = \$1/);
    expect(calls[2][1]).toEqual(['card_payments', false, ADMIN]);
    expect(sqls[3]).toMatch(/INSERT INTO admin_actions/);
    expect(calls[3][1][0]).toBe(ADMIN);
    expect(JSON.parse(calls[3][1][1])).toEqual({ key: 'card_payments', old_value: true, new_value: false, reason: 'Paystack incident' });
    expect(sqls[4]).toBe('COMMIT');
    expect(c.release).toHaveBeenCalled();
    expect(quietLog.log).toHaveBeenCalledWith(expect.stringMatching(/card_payments switched OFF \(was on\) by admin 5555/));
    expect(quietLog.log.mock.calls.flat().join(' ')).not.toMatch(/Paystack incident/); // the free-text reason isn't logged
    expect(await sw.isEnabled('card_payments')).toBe(false); // cache dropped: no 15 s wait here
  });

  test('switching to the state it is already in changes nothing and writes no audit row', async () => {
    const { c, calls } = client(false);
    const { sw } = make({ query: jest.fn().mockResolvedValue(allRows()), connect: async () => c });
    expect(await sw.setSwitch('cash_orders', false, ADMIN, 'Sunday test')).toEqual({ changed: false, key: 'cash_orders', previous: false, enabled: false });
    expect(calls.map(([s]) => s)).toEqual(['BEGIN', expect.stringMatching(/FOR UPDATE/), 'ROLLBACK']);
  });

  test.each([['an empty reason', '   '], ['a missing reason', undefined], ['a reason over 500 characters', 'x'.repeat(501)]])(
    '%s is refused before any database write', async (_label, reason) => {
      const connect = jest.fn();
      const { sw } = make({ query: jest.fn(), connect });
      await expect(sw.setSwitch('signups', false, ADMIN, reason)).rejects.toThrow(/reason/);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  test('a failure rolls the whole change back', async () => {
    const c = {
      query: jest.fn(async (sql) => {
        if (/SELECT enabled/.test(sql)) return { rows: [{ enabled: true }] };
        if (/INSERT INTO admin_actions/.test(sql)) throw new Error('disk full');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const { sw } = make({ query: jest.fn(), connect: async () => c });
    await expect(sw.setSwitch('new_orders', false, ADMIN, 'test')).rejects.toThrow('disk full');
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
    expect(c.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

describe('requireFeature (the route guard)', () => {
  const res = () => {
    const r = { set: jest.fn(), status: jest.fn(), json: jest.fn() };
    r.status.mockReturnValue(r); r.json.mockReturnValue(r);
    return r;
  };

  test('on: the request goes through', async () => {
    const next = jest.fn();
    await requireFeature('new_orders', { isEnabled: async () => true })({}, res(), next);
    expect(next).toHaveBeenCalled();
  });

  test('off: 503, Retry-After 300 and the approved body, and the handler never runs', async () => {
    const next = jest.fn();
    const r = res();
    await requireFeature('new_orders', { isEnabled: async () => false })({}, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.set).toHaveBeenCalledWith('Retry-After', '300');
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith({ error: MESSAGES.new_orders, code: 'FEATURE_OFF', feature: 'new_orders' });
  });

  test('if the check itself throws, the cold-start rule decides (payouts closed, orders open)', async () => {
    const broken = { isEnabled: async () => { throw new Error('boom'); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const nextOrders = jest.fn();
    await requireFeature('new_orders', broken)({}, res(), nextOrders);
    expect(nextOrders).toHaveBeenCalled();
    const nextPayouts = jest.fn();
    await requireFeature('driver_payouts', broken)({}, res(), nextPayouts);
    expect(nextPayouts).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('an unknown key fails at startup, not on a request', () => {
    expect(() => requireFeature('typo_key')).toThrow(/Unknown feature switch/);
  });
});

describe('driver_payouts guards PayoutService itself (for L3 and any future caller)', () => {
  afterEach(() => { delete process.env.FEATURE_DRIVER_PAYOUTS; });

  test('off: processRequestedPayout refuses before touching the database or Paystack', async () => {
    process.env.FEATURE_DRIVER_PAYOUTS = 'off';
    const PayoutService = require('../../src/services/payoutService');
    pool.connect = jest.fn();
    await expect(PayoutService.processRequestedPayout('66666666-6666-4666-8666-666666666666'))
      .rejects.toMatchObject({ code: 'FEATURE_OFF', feature: 'driver_payouts' });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('signups also stops NEW accounts through Google and Apple sign-in (existing accounts still sign in)', () => {
  const { verifyGoogleToken } = require('../../src/services/googleAuthService');
  const { verifyAppleToken } = require('../../src/services/appleAuthService');
  const AuthController = require('../../src/controllers/authController');
  const res = () => {
    const r = { set: jest.fn(), status: jest.fn(), json: jest.fn() };
    r.status.mockReturnValue(r); r.json.mockReturnValue(r); r.set.mockReturnValue(r);
    return r;
  };
  beforeEach(() => {
    process.env.FEATURE_SIGNUPS = 'off';
    verifyGoogleToken.mockResolvedValue({ sub: 'g-123', email: 'new@example.test', name: 'New' });
    verifyAppleToken.mockResolvedValue({ sub: 'a-123', email: 'new@example.test' });
  });
  afterEach(() => { delete process.env.FEATURE_SIGNUPS; });

  test.each([
    ['googleSignInUser', { idToken: 't' }, /INSERT INTO users/],
    ['googleSignInDriver', { idToken: 't' }, /INSERT INTO drivers/],
    ['appleSignInUser', { identityToken: 't' }, /INSERT INTO users/],
    ['appleSignInDriver', { identityToken: 't' }, /INSERT INTO drivers/],
  ])('%s: a brand-new account is refused with the signups message, and nothing is created', async (handler, body, insertRe) => {
    pool.query = jest.fn().mockResolvedValue({ rows: [] }); // no existing account by provider id or email
    const r = res();
    await AuthController[handler]({ body }, r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.set).toHaveBeenCalledWith('Retry-After', '300');
    expect(r.json).toHaveBeenCalledWith({ error: MESSAGES.signups, code: 'FEATURE_OFF', feature: 'signups' });
    expect(pool.query.mock.calls.some(([sql]) => insertRe.test(String(sql)))).toBe(false);
  });

  test('an existing Google user still signs in while signups is off', async () => {
    pool.query = jest.fn(async (sql) => {
      if (/FROM users WHERE google_id/.test(sql)) return { rows: [{ id: '77777777-7777-4777-8777-777777777777', email: 'old@example.test', password_hash: 'x' }] };
      return { rows: [] };
    });
    const r = res();
    await AuthController.googleSignInUser({ body: { idToken: 't' } }, r);
    expect(r.status).not.toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ isNewUser: false }));
  });
});
