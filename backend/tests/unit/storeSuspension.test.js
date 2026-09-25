'use strict';
/**
 * tests/unit/storeSuspension.test.js
 *
 * The store suspension kill switch.
 *
 * Context for anyone reading this later: before this existed, Flash had no
 * working way to take a live store offline. `suspended` was in the
 * stores_status_check constraint but nothing set it; approve() and reject()
 * were both scoped to pending/under_review so nothing could act on an
 * approved store; and even after flipping is_active by hand in the database,
 * the store's staff kept full portal access — real HTTP 200s on orders,
 * inventory, analytics and staff — because authenticateStore only ever
 * checked store_users.is_active, never the store. Store tokens last 8h and
 * there is no refresh endpoint, so that was an eight-hour window.
 *
 * These tests are therefore mostly adversarial: each one asks "can someone
 * who has just been suspended still get in by some other route?"
 */

jest.mock('../../src/config/database');
jest.mock('jsonwebtoken');
jest.mock('../../src/services/emailService', () => ({
  sendStorePasswordResetEmail: jest.fn(),
  sendStoreWelcomeEmail: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const pool = require('../../src/config/database');
const jwt = require('jsonwebtoken');
const Store = require('../../src/models/Store');
const { STORE_STATUS_TRANSITIONS } = require('../../src/models/Store');
const { authenticateStore } = require('../../src/middleware/auth');
const emailService = require('../../src/services/emailService');

const STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

// The shape authenticateStore's joined query returns.
function accountRow({ storeActive = true, storeStatus = 'approved' } = {}) {
  return {
    is_active: true,
    password_changed_at: null,
    store_is_active: storeActive,
    store_status: storeStatus,
  };
}

function mockAuthReads(row) {
  pool.query
    .mockResolvedValueOnce({ rows: [] })        // revoked_tokens — not revoked
    .mockResolvedValueOnce({ rows: [row] });    // store_users JOIN stores
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STORE_JWT_SECRET = 'test-store-jwt-secret';
});

// ─────────────────────────────────────────────────────────────────────────────
// The kill switch itself
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateStore — suspended stores lose live access', () => {
  test('a VALID, UNEXPIRED token minted before suspension stops working immediately', async () => {
    // This is the whole point. The token is perfectly good — correctly
    // signed, not revoked, not expired, belonging to an active account. Only
    // the store changed. Before this fix it kept working for up to 8h.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'jti-1', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: false, storeStatus: 'suspended' }));

    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer pre.suspension.token' } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STORE_SUSPENDED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('403 and a machine-readable code, not 401 — the session is real, the store is forbidden', async () => {
    // A 401 would read to the portal as "log in again", sending a suspended
    // owner into a loop. The distinct code is what lets the UI say why.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: false, storeStatus: 'suspended' }));

    const res = makeRes();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('the store check reads the live database, not the token payload', async () => {
    // A token minted while the store was healthy still carries storeId and
    // role claims. If the middleware trusted those, suspension would be
    // invisible to it. Assert the query actually joins stores.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow());

    await authenticateStore({ headers: { authorization: 'Bearer t' } }, makeRes(), jest.fn());

    const [sql] = pool.query.mock.calls[1];
    expect(sql).toMatch(/JOIN\s+stores/i);
    expect(sql).toMatch(/s\.status\s+AS\s+store_status/i);
    expect(sql).toMatch(/WHERE\s+su\.id\s*=\s*\$1/i);
  });

  test.each([
    ['pending'],
    ['under_review'],
    ['rejected'],
    ['suspended'],
  ])('a store in %s is refused, not only an explicitly suspended one', async (status) => {
    // Fails closed: anything that is not an active, approved store is
    // refused, so a store parked in any other state can't be operated either.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: true, storeStatus: status }));

    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('is_active=false alone suspends access even if status still reads approved', async () => {
    // Defence in depth: the two flags are set together, but either one being
    // off is enough. A half-applied change must not leave a store operable.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: false, storeStatus: 'approved' }));

    const res = makeRes();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('an orphaned account (no store row) is refused rather than let through', async () => {
    // The inner join returns nothing. Must fail closed.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('a healthy approved store still passes — the switch is not simply blocking everyone', async () => {
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow());

    const req = { headers: { authorization: 'Bearer t' } };
    const res = makeRes();
    const next = jest.fn();
    await authenticateStore(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.storeId).toBe(STORE_ID);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('reactivation restores access with no other change', async () => {
    // Same account, same token; only the store's state differs.
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: false, storeStatus: 'suspended' }));
    const denied = makeRes();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, denied, jest.fn());
    expect(denied.status).toHaveBeenCalledWith(403);

    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: USER_ID, storeId: STORE_ID, role: 'owner', jti: 'j', iat: 1000 });
    mockAuthReads(accountRow({ storeActive: true, storeStatus: 'approved' }));
    const allowed = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer t' } }, allowed, next);

    expect(next).toHaveBeenCalled();
    expect(allowed.status).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The re-login bypass
// ─────────────────────────────────────────────────────────────────────────────

describe('login — a suspended store cannot mint a fresh token', () => {
  // Without this, the kill switch would stop nothing: staff would simply sign
  // in again and receive a brand-new 8h token.
  const bcrypt = require('bcryptjs');
  const StoreAuthController = require('../../src/controllers/storeAuthController');

  jest.mock('express-validator', () => ({
    validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
  }));

  async function owner() {
    return {
      id: USER_ID,
      store_id: STORE_ID,
      name: 'Owner',
      email: 'owner@example.com',
      password_hash: await bcrypt.hash('correct-horse-battery', 4),
      role: 'owner',
      is_active: true,
      force_password_reset: false,
    };
  }

  test('refuses to issue a token when the store is suspended', async () => {
    const user = await owner();
    pool.query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, is_active: false, status: 'suspended' }] });

    const res = makeRes();
    await StoreAuthController.login(
      { body: { email: user.email, password: 'correct-horse-battery' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STORE_SUSPENDED' }));
    // The critical assertion: no token came back.
    expect(res.json.mock.calls[0][0].token).toBeUndefined();
  });

  test('the store check happens AFTER the password is verified (anti-enumeration)', async () => {
    // Answering before credentials are proven would tell anyone who merely
    // guesses an email that it belongs to a suspended store — the same
    // discipline the marketing-role check already follows.
    const user = await owner();
    pool.query.mockResolvedValueOnce({ rows: [user] });

    const res = makeRes();
    await StoreAuthController.login(
      { body: { email: user.email, password: 'WRONG-password' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    // Generic credentials error, never the suspension code.
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'STORE_SUSPENDED' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('Store.suspend / Store.reactivate', () => {
  test('suspend is scoped to approved stores only', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.suspend(STORE_ID, ADMIN_ID, 'fraud investigation');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('approved'\)/);
    expect(sql).toMatch(/status = 'suspended'/);
    expect(sql).toMatch(/is_active = false/);
  });

  test('suspend returns null when the store is not approved (race / double click)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await Store.suspend(STORE_ID, ADMIN_ID, 'reason');
    expect(result).toBeNull();
  });

  test('reactivate is scoped to suspended stores only, and restores approved+active', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.reactivate(STORE_ID, ADMIN_ID);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('suspended'\)/);
    expect(sql).toMatch(/status = 'approved'/);
    expect(sql).toMatch(/is_active = true/);
    expect(sql).toMatch(/rejection_reason = NULL/);
  });

  test('reactivate touches NO tokens and sends NO email', async () => {
    // Reusing approve() here would have minted a fresh invite token and
    // emailed a welcome message to an owner who already has a password.
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.reactivate(STORE_ID, ADMIN_ID);

    const allSql = pool.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(allSql).not.toMatch(/store_password_tokens/i);
    expect(emailService.sendStoreWelcomeEmail).not.toHaveBeenCalled();
    expect(emailService.sendStorePasswordResetEmail).not.toHaveBeenCalled();
  });

  test('suspending a store does not touch any order rows', async () => {
    // Explicitly asserted because the decision that in-flight orders are left
    // alone is a business decision, not an accident of implementation: a
    // customer who has paid and has a driver on the way must not lose their
    // delivery because of a back-office action.
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
    await Store.suspend(STORE_ID, ADMIN_ID, 'reason');

    const allSql = pool.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(allSql).toMatch(/UPDATE stores/);
    expect(allSql).not.toMatch(/\borders\b/i);
    expect(allSql).not.toMatch(/order_cancellations/i);
    expect(allSql).not.toMatch(/DELETE/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The drift guard
// ─────────────────────────────────────────────────────────────────────────────

describe('STORE_STATUS_TRANSITIONS is the single source of truth', () => {
  // This is the regression test for the ROOT CAUSE, not the symptom. The
  // original gap existed because rejectStore's isAccessible and
  // Store.reject()'s WHERE clause were written out separately and both
  // hard-excluded 'approved' — the action was silently unreachable and
  // nothing failed loudly. These tests make that divergence impossible to
  // reintroduce quietly.

  test('every model WHERE clause renders exactly the states in the map', async () => {
    const cases = [
      ['approve', () => Store.approve(STORE_ID, ADMIN_ID)],
      ['reject', () => Store.reject(STORE_ID, ADMIN_ID, 'r')],
      ['suspend', () => Store.suspend(STORE_ID, ADMIN_ID, 'r')],
      ['reactivate', () => Store.reactivate(STORE_ID, ADMIN_ID)],
    ];

    for (const [name, run] of cases) {
      pool.query.mockClear();
      pool.query.mockResolvedValue({ rows: [{ id: STORE_ID }] });
      await run();
      const [sql] = pool.query.mock.calls[0];
      const expected = STORE_STATUS_TRANSITIONS[name].map((s) => `'${s}'`).join(',');
      expect(sql).toContain(`status IN (${expected})`);
    }
  });

  test('every AdminJS store action derives isAccessible from the map, never a literal list', async () => {
    // Read as source rather than by importing adminPanel.js, which pulls in
    // the whole AdminJS stack. Crude, but it pins the exact thing that broke:
    // a hand-written state list drifting from the model.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'adminPanel.js'),
      'utf8',
    );

    for (const action of ['approve', 'reject', 'suspend', 'reactivate']) {
      expect(source).toContain(`STORE_STATUS_TRANSITIONS.${action}.includes(record.param('status'))`);
    }

    // And no store action may go back to restating the states inline.
    const storeActionRegion = source.slice(source.indexOf("db.table('stores')"));
    expect(storeActionRegion).not.toMatch(/\['pending', 'under_review'\]\.includes\(record\.param\('status'\)\)/);
  });

  test('the map covers exactly the four transitions, so a new one cannot be half-wired', () => {
    expect(Object.keys(STORE_STATUS_TRANSITIONS).sort())
      .toEqual(['approve', 'reactivate', 'reject', 'suspend']);
  });

  test('every state referenced by the map is legal under stores_status_check', () => {
    // Guards against adding a transition whose source state the database
    // constraint would reject — the UPDATE would silently match zero rows.
    const allowed = ['pending', 'under_review', 'approved', 'rejected', 'suspended'];
    for (const states of Object.values(STORE_STATUS_TRANSITIONS)) {
      for (const state of states) expect(allowed).toContain(state);
    }
  });
});
