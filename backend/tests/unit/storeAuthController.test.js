'use strict';
/**
 * tests/unit/storeAuthController.test.js
 *
 * Store portal authentication. The properties pinned here are security
 * properties, so each is asserted as observable behaviour rather than as a
 * restatement of the implementation:
 *
 *   - tokens are signed with STORE_JWT_SECRET and nothing else, and carry the
 *     store scope the rest of the system relies on (storeId + jti)
 *   - a wrong password and an unknown account are indistinguishable
 *   - forgot-password never reveals whether an account exists, and never lets
 *     a failed email send surface as a failed request
 *   - a used or expired reset token cannot be replayed
 *   - completing a reset invalidates every existing session
 *   - an owner cannot self-delete the store out from under itself
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService', () => ({ sendStorePasswordResetEmail: jest.fn() }));
jest.mock('express-validator', () => ({ validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })) }));

const pool = require('../../src/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendStorePasswordResetEmail } = require('../../src/services/emailService');
const { validationResult } = require('express-validator');
const StoreAuthController = require('../../src/controllers/storeAuthController');

const STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STORE_SECRET = 'store_secret_used_only_by_this_test'.padEnd(64, 'x');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function activeOwner(password = 'correct-horse-battery') {
  return {
    id: USER_ID,
    store_id: STORE_ID,
    name: 'Owner',
    email: 'owner@example.com',
    password_hash: await bcrypt.hash(password, 4), // low cost: test speed only
    role: 'owner',
    is_active: true,
    force_password_reset: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STORE_JWT_SECRET = STORE_SECRET;
  validationResult.mockReturnValue({ isEmpty: () => true, array: () => [] });
});

describe('login', () => {
  test('issues a token signed with STORE_JWT_SECRET carrying the store scope', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.login(
      { body: { email: user.email, password: 'correct-horse-battery' } }, res,
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.token).toEqual(expect.any(String));

    // Verifies against the store secret specifically: a token signed with any
    // other secret would throw here.
    const decoded = jwt.verify(payload.token, STORE_SECRET);
    expect(decoded.id).toBe(USER_ID);
    expect(decoded.storeId).toBe(STORE_ID);
    expect(decoded.role).toBe('owner');
    expect(decoded.jti).toEqual(expect.any(String)); // needed for logout revocation
  });

  test('never returns the password hash to the client', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.login(
      { body: { email: user.email, password: 'correct-horse-battery' } }, res,
    );

    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/\$2[aby]\$/);
  });

  test('a wrong password and an unknown account are indistinguishable', async () => {
    const user = await activeOwner();

    pool.query.mockResolvedValue({ rows: [user] });
    const wrongPw = mockRes();
    await StoreAuthController.login({ body: { email: user.email, password: 'nope' } }, wrongPw);

    // Deliberately NOT jest.clearAllMocks() here -- that would also wipe the
    // recorded calls on wrongPw, which is exactly what the comparison below
    // needs. Only the database stub is re-pointed.
    pool.query.mockResolvedValue({ rows: [] });
    const unknown = mockRes();
    await StoreAuthController.login({ body: { email: 'ghost@example.com', password: 'nope' } }, unknown);

    expect(wrongPw.status).toHaveBeenCalledWith(401);
    expect(unknown.status).toHaveBeenCalledWith(401);
    expect(wrongPw.json.mock.calls[0][0]).toEqual(unknown.json.mock.calls[0][0]);
  });

  test('a deactivated account cannot log in even with the right password', async () => {
    const user = { ...(await activeOwner()), is_active: false };
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.login(
      { body: { email: user.email, password: 'correct-horse-battery' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('missing credentials are rejected before any lookup', async () => {
    const res = mockRes();
    await StoreAuthController.login({ body: { email: 'a@b.c' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Marketing accounts exist but have no screens; the rejection happens only
  // AFTER the password is verified, so it cannot be used to enumerate which
  // emails belong to marketing users.
  test('a marketing account is refused only after its password is verified', async () => {
    const user = { ...(await activeOwner()), role: 'marketing' };
    pool.query.mockResolvedValue({ rows: [user] });

    const goodPw = mockRes();
    await StoreAuthController.login({ body: { email: user.email, password: 'correct-horse-battery' } }, goodPw);
    expect(goodPw.status).toHaveBeenCalledWith(403);

    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [user] });
    const badPw = mockRes();
    await StoreAuthController.login({ body: { email: user.email, password: 'wrong' } }, badPw);
    expect(badPw.status).toHaveBeenCalledWith(401); // not 403 — no enumeration
  });

  test('a misconfigured secret is a 500, never an unsigned token', async () => {
    delete process.env.STORE_JWT_SECRET;
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.login(
      { body: { email: user.email, password: 'correct-horse-battery' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].token).toBeUndefined();
  });
});

describe('logout', () => {
  test('revokes the presented token by jti', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const token = jwt.sign({ id: USER_ID, storeId: STORE_ID, jti: 'jti-123' }, STORE_SECRET, { expiresIn: '8h' });
    const res = mockRes();

    await StoreAuthController.logout({ headers: { authorization: `Bearer ${token}` } }, res);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO revoked_tokens/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/); // logging out twice is not an error
    expect(params[0]).toBe('jti-123');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test('a malformed or absent token still logs out cleanly', async () => {
    const res = mockRes();
    await StoreAuthController.logout({ headers: { authorization: 'Bearer not-a-jwt' } }, res);
    expect(res.json).toHaveBeenCalledWith({ success: true });

    const res2 = mockRes();
    await StoreAuthController.logout({ headers: {} }, res2);
    expect(res2.json).toHaveBeenCalledWith({ success: true });
  });
});

describe('forgotPassword', () => {
  test('an unknown email still reports success and writes no token', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = mockRes();

    await StoreAuthController.forgotPassword({ body: { email: 'ghost@example.com' } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    const inserts = pool.query.mock.calls.filter(([s]) => /INSERT INTO store_password_tokens/.test(String(s)));
    expect(inserts).toHaveLength(0);
    expect(sendStorePasswordResetEmail).not.toHaveBeenCalled();
  });

  test('a real account gets exactly one live token, replacing any previous one', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    sendStorePasswordResetEmail.mockResolvedValue({});
    const res = mockRes();

    await StoreAuthController.forgotPassword({ body: { email: user.email } }, res);

    const issued = pool.query.mock.calls.map(([s]) => String(s));
    expect(issued.some((s) => /DELETE FROM store_password_tokens/.test(s))).toBe(true);
    expect(issued.some((s) => /INSERT INTO store_password_tokens/.test(s))).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test('the emailed token is long, random, and not derived from the account', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    sendStorePasswordResetEmail.mockResolvedValue({});

    await StoreAuthController.forgotPassword({ body: { email: user.email } }, mockRes());

    const [, token] = sendStorePasswordResetEmail.mock.calls[0];
    expect(token).toMatch(/^[0-9a-f]{96}$/);
    expect(token).not.toContain(USER_ID);
    expect(token).not.toContain(STORE_ID);
  });

  // The failure mode that actually bit this project in production: a dead mail
  // transport must not turn into a 500, but it must also not be invisible.
  test('a failing email send does not fail the request', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    sendStorePasswordResetEmail.mockRejectedValue(new Error('Resend API 401'));
    const res = mockRes();

    await StoreAuthController.forgotPassword({ body: { email: user.email } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('a deactivated account is treated exactly like an unknown one', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...(await activeOwner()), is_active: false }] });
    const res = mockRes();

    await StoreAuthController.forgotPassword({ body: { email: 'owner@example.com' } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(sendStorePasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  test('an unmatched, used or expired token is refused', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = mockRes();

    await StoreAuthController.resetPassword({ body: { token: 'stale', newPassword: 'a-long-password' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    // The lookup itself must exclude spent and expired tokens.
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/used_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
  });

  test('a successful reset stores a bcrypt hash, stamps password_changed_at and spends the token', async () => {
    const client = {
      query: jest.fn(async () => ({ rows: [] })),
      release: jest.fn(),
    };
    pool.query.mockResolvedValue({ rows: [{ id: 'tok-1', store_user_id: USER_ID }] });
    pool.connect.mockResolvedValue(client);
    const res = mockRes();

    await StoreAuthController.resetPassword({ body: { token: 'good', newPassword: 'a-long-password' } }, res);

    const statements = client.query.mock.calls.map(([s]) => String(s));
    expect(statements.some((s) => /BEGIN/.test(s))).toBe(true);
    expect(statements.some((s) => /COMMIT/.test(s))).toBe(true);

    const update = client.query.mock.calls.find(([s]) => /UPDATE store_users/.test(String(s)));
    expect(update[0]).toMatch(/password_changed_at = NOW\(\)/); // invalidates live sessions
    expect(update[0]).toMatch(/force_password_reset = false/);
    expect(update[1][0]).toMatch(/^\$2[aby]\$/); // a real hash, not the plaintext
    expect(update[1][0]).not.toBe('a-long-password');

    expect(statements.some((s) => /UPDATE store_password_tokens SET used_at/.test(s))).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('a failure mid-reset rolls back rather than half-applying', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/BEGIN|ROLLBACK/i.test(String(sql))) return { rows: [] };
        throw new Error('write failed');
      }),
      release: jest.fn(),
    };
    pool.query.mockResolvedValue({ rows: [{ id: 'tok-1', store_user_id: USER_ID }] });
    pool.connect.mockResolvedValue(client);
    const res = mockRes();

    await StoreAuthController.resetPassword({ body: { token: 'good', newPassword: 'a-long-password' } }, res);

    expect(client.query.mock.calls.some(([s]) => /ROLLBACK/.test(String(s)))).toBe(true);
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('validation failures are rejected as 400 before any lookup', async () => {
    validationResult.mockReturnValue({ isEmpty: () => false, array: () => [{ msg: 'too short' }] });
    const res = mockRes();

    await StoreAuthController.resetPassword({ body: { token: 't', newPassword: 'short' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('changePassword', () => {
  test('requires the current password to be correct', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'wrong', newPassword: 'a-long-new-password' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    // Nothing may be written when the current password does not check out.
    expect(pool.query.mock.calls.filter(([s]) => /UPDATE store_users/.test(String(s)))).toHaveLength(0);
  });

  test('stores a bcrypt hash of the new password, never the plaintext', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'correct-horse-battery', newPassword: 'a-long-new-password' } },
      mockRes(),
    );

    const update = pool.query.mock.calls.find(([s]) => /UPDATE store_users/.test(String(s)));
    expect(update[1][0]).toMatch(/^\$2[aby]\$/);
    expect(update[1][0]).not.toBe('a-long-new-password');
  });

  // Same guarantee as resetPassword: changing the password must end every
  // other live session, which authenticateStore enforces via password_changed_at.
  test('stamps password_changed_at so existing sessions stop working', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'correct-horse-battery', newPassword: 'a-long-new-password' } },
      mockRes(),
    );

    const update = pool.query.mock.calls.find(([s]) => /UPDATE store_users/.test(String(s)));
    expect(update[0]).toMatch(/password_changed_at = NOW\(\)/);
    expect(update[0]).toMatch(/force_password_reset = false/);
  });

  // ...and hands back a fresh token, so the caller who just changed their own
  // password is not logged out by their own request.
  test('returns a newly signed token valid under the store secret', async () => {
    const user = await activeOwner();
    pool.query.mockResolvedValue({ rows: [user] });
    const res = mockRes();

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'correct-horse-battery', newPassword: 'a-long-new-password' } },
      res,
    );

    const { token, success } = res.json.mock.calls[0][0];
    expect(success).toBe(true);
    const decoded = jwt.verify(token, STORE_SECRET);
    expect(decoded.storeId).toBe(STORE_ID);
  });

  test('a missing account is 404', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = mockRes();

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'x', newPassword: 'a-long-new-password' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('validation failures are rejected before any lookup', async () => {
    validationResult.mockReturnValue({ isEmpty: () => false, array: () => [{ msg: 'too short' }] });
    const res = mockRes();

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'x', newPassword: 'short' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a database failure is a 500, not an unhandled rejection', async () => {
    pool.query.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();

    await StoreAuthController.changePassword(
      { storeUserId: USER_ID, body: { currentPassword: 'x', newPassword: 'a-long-new-password' } }, res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteAccount', () => {
  test('an owner cannot self-delete the store out from under itself', async () => {
    const res = mockRes();
    await StoreAuthController.deleteAccount(
      { storeRole: 'owner', storeUserId: USER_ID, storeId: STORE_ID, headers: {} }, res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('non-owner staff are anonymized and their token revoked', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: USER_ID }] });
    const token = jwt.sign({ id: USER_ID, jti: 'jti-9' }, STORE_SECRET, { expiresIn: '8h' });
    const res = mockRes();

    await StoreAuthController.deleteAccount(
      {
        storeRole: 'sales_staff', storeUserId: USER_ID, storeId: STORE_ID,
        headers: { authorization: `Bearer ${token}` },
      },
      res,
    );

    const issued = pool.query.mock.calls.map(([s]) => String(s));
    expect(issued.some((s) => /UPDATE store_users/.test(s))).toBe(true);
    expect(issued.some((s) => /DELETE FROM store_users/.test(s))).toBe(false);
    expect(issued.some((s) => /INSERT INTO revoked_tokens/.test(s))).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
