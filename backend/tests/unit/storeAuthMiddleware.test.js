'use strict';
/**
 * tests/unit/storeAuthMiddleware.test.js
 *
 * Admin Platform Phase 4 — adversarial verification of the Store Admin
 * Portal's tenant-isolation and RBAC middleware (middleware/auth.js:
 * authenticateStore/requireStoreRole/requireOwnStore/
 * requireStorePasswordCurrent). This IS the single property the whole
 * multi-tenant feature depends on (FLASH_STORE_ADMIN_DESIGN.md §5.1) — same
 * live-verified-not-assumed standard already applied and confirmed via a
 * real end-to-end run against a live Docker Postgres sandbox (two real
 * stores, two real store_users, real JWTs, real cross-store IDOR/role-
 * escalation attempts — all correctly rejected; see docs/ for the write-up).
 * These are the permanent, fast, CI-running regression tests for the same
 * logic.
 */

jest.mock('../../src/config/database');
jest.mock('jsonwebtoken');

const pool = require('../../src/config/database');
const jwt = require('jsonwebtoken');
const {
  authenticateStore,
  requireStoreRole,
  requireOwnStore,
  requireStorePasswordCurrent,
} = require('../../src/middleware/auth');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STORE_JWT_SECRET = 'test-store-jwt-secret';
});

describe('authenticateStore', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a token that fails STORE_JWT_SECRET verification (e.g. an admin or user token)', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid signature'); });
    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer some.other.token' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a deactivated store account even with a validly-signed token', async () => {
    jwt.verify.mockReturnValue({ id: 'su-1', storeId: 'store-1', role: 'owner', jti: 'jti-1', iat: 1000 });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // revoked_tokens — not revoked
      .mockResolvedValueOnce({ rows: [{ is_active: false, password_changed_at: null }] }); // store_users — deactivated
    const res = makeRes();
    const next = jest.fn();
    await authenticateStore({ headers: { authorization: 'Bearer good.token' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/deactivated/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  test('sets req.storeId/req.storeUserId/req.storeRole from the verified token only — never from anywhere client-suppliable', async () => {
    jwt.verify.mockReturnValue({ id: 'su-1', storeId: 'store-A', role: 'sales_staff', jti: 'jti-1', iat: 1000 });
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      // The account row now arrives joined to its store, because
      // authenticateStore re-checks the STORE's live status on every request
      // too (the suspension kill switch). An approved, active store here so
      // this test still exercises what it is actually about — that req.storeId
      // comes from the token and never from the request body/query.
      .mockResolvedValueOnce({
        rows: [{
          is_active: true,
          password_changed_at: null,
          store_is_active: true,
          store_status: 'approved',
        }],
      });
    // The request tries to smuggle a DIFFERENT storeId via body/query —
    // authenticateStore must never read from these; only the verified
    // token's own storeId claim ends up on req.
    const req = {
      headers: { authorization: 'Bearer good.token' },
      body: { storeId: 'store-B-attacker-supplied' },
      query: { storeId: 'store-C-also-attacker-supplied' },
    };
    const res = makeRes();
    const next = jest.fn();
    await authenticateStore(req, res, next);
    expect(req.storeId).toBe('store-A');
    expect(req.storeUserId).toBe('su-1');
    expect(req.storeRole).toBe('sales_staff');
    expect(next).toHaveBeenCalled();
  });
});

describe('requireStoreRole — the server-side "no role can act outside its permissions" boundary', () => {
  test('blocks a role not in the allow-list', () => {
    const res = makeRes();
    const next = jest.fn();
    requireStoreRole('owner')({ storeRole: 'sales_staff' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows a role in the allow-list', () => {
    const res = makeRes();
    const next = jest.fn();
    requireStoreRole('owner', 'store_manager')({ storeRole: 'store_manager' }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('blocks when no storeRole was ever set (unauthenticated)', () => {
    const res = makeRes();
    const next = jest.fn();
    requireStoreRole('owner')({}, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireOwnStore — the single most important tenant-isolation guard', () => {
  test('rejects when a client-supplied storeId in the body mismatches the token-derived req.storeId', () => {
    const res = makeRes();
    const next = jest.fn();
    requireOwnStore({ storeId: 'store-A', body: { storeId: 'store-B' }, params: {}, query: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects when a client-supplied storeId in the params mismatches', () => {
    const res = makeRes();
    const next = jest.fn();
    requireOwnStore({ storeId: 'store-A', body: {}, params: { storeId: 'store-B' }, query: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('allows when no storeId was supplied by the client at all (the normal case for every real route in this tree)', () => {
    const res = makeRes();
    const next = jest.fn();
    requireOwnStore({ storeId: 'store-A', body: {}, params: {}, query: {} }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows when the client-supplied storeId happens to MATCH the real one (not just absent)', () => {
    const res = makeRes();
    const next = jest.fn();
    requireOwnStore({ storeId: 'store-A', body: { storeId: 'store-A' }, params: {}, query: {} }, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireStorePasswordCurrent', () => {
  test('blocks with FORCE_PASSWORD_RESET_REQUIRED when the flag is set', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ force_password_reset: true }] });
    const res = makeRes();
    const next = jest.fn();
    await requireStorePasswordCurrent({ storeUserId: 'su-1' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORCE_PASSWORD_RESET_REQUIRED' }));
  });

  test('allows through when the flag is false', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ force_password_reset: false }] });
    const res = makeRes();
    const next = jest.fn();
    await requireStorePasswordCurrent({ storeUserId: 'su-1' }, res, next);
    expect(next).toHaveBeenCalled();
  });
});
