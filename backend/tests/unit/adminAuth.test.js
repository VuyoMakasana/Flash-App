'use strict';
/**
 * tests/unit/adminAuth.test.js
 *
 * Admin Platform Phase 2 — sign-in, sign-out, forgot/reset/change password
 * for the `admins` table. Mirrors tests/unit/auth.test.js's conventions
 * (manual DB mock, mocked bcryptjs/jsonwebtoken) so these exercise the real
 * controller/middleware logic without needing a live Postgres.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

const pool = require('../../src/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendAdminPasswordResetEmail } = require('../../src/services/emailService');

const AdminController = require('../../src/controllers/adminController');
const { authenticate, requireAdminPasswordCurrent } = require('../../src/middleware/auth');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
  process.env.JWT_SECRET = 'test-user-jwt-secret';
});

// ─── Login ──────────────────────────────────────────────────────────────────

describe('AdminController.login', () => {
  test('returns 401 for an unknown email — same message as a wrong password (no enumeration)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // Admin.findByEmail
    const req = { body: { email: 'nobody@flash.test', password: 'whatever' } };
    const res = makeRes();

    await AdminController.login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid credentials' });
  });

  test('returns 401 for a wrong password against a real account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'admin-1', password_hash: 'hash', email: 'a@flash.test' }] });
    bcrypt.compare.mockResolvedValue(false);
    const req = { body: { email: 'a@flash.test', password: 'wrong' } };
    const res = makeRes();

    await AdminController.login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid credentials' });
  });

  test('successful login for a normal account returns forcePasswordReset: false', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'admin-1', name: 'Vuyo', email: 'a@flash.test', role: 'admin', password_hash: 'hash', force_password_reset: false }],
    });
    bcrypt.compare.mockResolvedValue(true);
    jwt.sign.mockReturnValue('mock.jwt.token');
    const req = { body: { email: 'a@flash.test', password: 'right' } };
    const res = makeRes();

    await AdminController.login(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      token: 'mock.jwt.token',
      forcePasswordReset: false,
    }));
  });

  // Admin Platform Phase 2 — the seeded/temporary-password path
  // (migrate.js v35). A login that succeeds must still tell the client the
  // account is in a forced-reset state, even though the real enforcement is
  // server-side (requireAdminPasswordCurrent), not this flag.
  test('successful login for a force_password_reset account returns forcePasswordReset: true', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'admin-1', name: 'Vuyo', email: 'makasanaivyson@gmail.com', role: 'admin', password_hash: 'hash', force_password_reset: true }],
    });
    bcrypt.compare.mockResolvedValue(true);
    jwt.sign.mockReturnValue('mock.jwt.token');
    const req = { body: { email: 'makasanaivyson@gmail.com', password: 'temp-password' } };
    const res = makeRes();

    await AdminController.login(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ forcePasswordReset: true }));
  });
});

// ─── Change password ───────────────────────────────────────────────────────

describe('AdminController.changePassword', () => {
  function req(body, userId = 'admin-1') {
    return { body, userId };
  }

  test('rejects when the current password is wrong', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'admin-1', password_hash: 'old-hash', role: 'admin' }] });
    bcrypt.compare.mockResolvedValue(false);
    const res = makeRes();

    await AdminController.changePassword(req({ currentPassword: 'wrong', newPassword: 'NewStrongPass123' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Current password is incorrect' });
    // Must never reach the UPDATE — only the SELECT by id happened.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('404s if the authenticated admin id no longer has a row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();

    await AdminController.changePassword(req({ currentPassword: 'x', newPassword: 'NewStrongPass123' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('on success: hashes at cost 12, clears force_password_reset, sets password_changed_at, and returns a fresh token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'admin-1', password_hash: 'old-hash', role: 'admin' }] }) // SELECT current
      .mockResolvedValueOnce({ rows: [] }); // UPDATE admins
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('new-hash');
    jwt.sign.mockReturnValue('fresh.jwt.token');
    const res = makeRes();

    await AdminController.changePassword(req({ currentPassword: 'right', newPassword: 'NewStrongPass123' }), res);

    expect(bcrypt.hash).toHaveBeenCalledWith('NewStrongPass123', 12);
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/force_password_reset = false/);
    expect(updateCall[0]).toMatch(/password_changed_at = NOW\(\)/);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, token: 'fresh.jwt.token' }));
  });
});

// ─── Forgot password ────────────────────────────────────────────────────────

describe('AdminController.forgotPassword', () => {
  test('returns success even when the email does not match a real admin (no enumeration)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // Admin.findByEmail
    const res = makeRes();

    await AdminController.forgotPassword({ body: { email: 'nobody@flash.test' } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(sendAdminPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('on a real account: deletes old tokens, inserts a new one, and sends the reset email (not awaited)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'admin-1', email: 'a@flash.test' }] }) // findByEmail
      .mockResolvedValueOnce({ rows: [] }) // DELETE old tokens
      .mockResolvedValueOnce({ rows: [] }); // INSERT new token
    sendAdminPasswordResetEmail.mockResolvedValue({});
    const res = makeRes();

    await AdminController.forgotPassword({ body: { email: 'a@flash.test' } }, res);

    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringMatching(/DELETE FROM admin_password_tokens/), ['admin-1']);
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringMatching(/INSERT INTO admin_password_tokens/), expect.arrayContaining(['admin-1']));
    expect(sendAdminPasswordResetEmail).toHaveBeenCalledWith('a@flash.test', expect.any(String));
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});

// ─── Reset password ─────────────────────────────────────────────────────────

describe('AdminController.resetPassword', () => {
  test('rejects an invalid/expired/used token', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();

    await AdminController.resetPassword({ body: { token: 'bad-token', newPassword: 'NewStrongPass123' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('on a valid token: updates password_hash, clears force_password_reset, marks the token used, all inside one transaction', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'token-1', admin_id: 'admin-1' }] }); // SELECT token
    pool.connect.mockResolvedValueOnce(mockClient);
    bcrypt.hash.mockResolvedValue('new-hash');
    const res = makeRes();

    await AdminController.resetPassword({ body: { token: 'good-token', newPassword: 'NewStrongPass123' } }, res);

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE admins SET password_hash/),
      ['new-hash', 'admin-1'],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE admin_password_tokens SET used_at/),
      ['token-1'],
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ─── requireAdminPasswordCurrent gate ──────────────────────────────────────

describe('requireAdminPasswordCurrent', () => {
  test('blocks with 403/FORCE_PASSWORD_RESET_REQUIRED when the flag is set', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ force_password_reset: true }] });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPasswordCurrent({ userId: 'admin-1' }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORCE_PASSWORD_RESET_REQUIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when the flag is false', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ force_password_reset: false }] });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPasswordCurrent({ userId: 'admin-1' }, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── authenticate(): password_changed_at session invalidation ─────────────

describe('authenticate() — admin token invalidation on password change', () => {
  function req(token) {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  test('rejects an admin token issued BEFORE the most recent password change', async () => {
    const decoded = { id: 'admin-1', role: 'admin', jti: 'jti-1', iat: 1000 };
    jwt.verify
      .mockImplementationOnce(() => { const e = new Error('bad sig'); e.name = 'JsonWebTokenError'; throw e; }) // JWT_SECRET attempt fails
      .mockReturnValueOnce(decoded); // ADMIN_JWT_SECRET attempt succeeds
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // revoked_tokens check — not revoked
      .mockResolvedValueOnce({ rows: [{ password_changed_at: new Date((1000 + 60) * 1000) }] }); // changed 60s after iat
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req('sometoken'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/password change/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts an admin token issued in the SAME second as password_changed_at (the fresh replacement token)', async () => {
    const decoded = { id: 'admin-1', role: 'admin', jti: 'jti-2', iat: 1000 };
    jwt.verify
      .mockImplementationOnce(() => { const e = new Error('bad sig'); e.name = 'JsonWebTokenError'; throw e; })
      .mockReturnValueOnce(decoded);
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // revoked_tokens — not revoked
      .mockResolvedValueOnce({ rows: [{ password_changed_at: new Date(1000 * 1000 + 900) }] }); // same second, +900ms
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req('sometoken'), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('never blocked for a user/driver token — the password_changed_at query only runs for admin-role tokens', async () => {
    const decoded = { id: 'user-1', role: 'user', jti: 'jti-3', iat: 1000 };
    jwt.verify.mockReturnValueOnce(decoded); // JWT_SECRET succeeds immediately, no admin-secret retry
    pool.query.mockResolvedValueOnce({ rows: [] }); // revoked_tokens check only
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req('sometoken'), res, next);

    expect(next).toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // only the revoked_tokens check, no admins lookup
  });
});
