'use strict';
/**
 * tests/unit/storeAuth.test.js
 *
 * Multi-tenant Stage 2 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §5) —
 * adversarial coverage for the store-scoped auth system: real attack
 * attempts against authenticateStore/requireStoreRole/requireOwnStore and
 * storeAuthController, not assumed safety. Deliberately does NOT mock
 * jsonwebtoken (unlike tests/unit/auth.test.js) — the whole point of these
 * tests is proving real cryptographic secret isolation (a token signed with
 * JWT_SECRET/ADMIN_JWT_SECRET must be REJECTED by authenticateStore, and
 * vice versa), which a mocked jwt.verify would just assert away.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test_user_driver_secret_32_chars_min';
process.env.ADMIN_JWT_SECRET = 'test_admin_secret_completely_different';
process.env.STORE_JWT_SECRET = 'test_store_secret_yet_another_value';

const { authenticateStore, requireStoreRole, requireOwnStore } = require('../../src/middleware/auth');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function signStore(payload, secret = process.env.STORE_JWT_SECRET, opts = {}) {
  return jwt.sign(payload, secret, { expiresIn: '8h', ...opts });
}

const REAL_ROLES = ['owner', 'store_manager', 'inventory_staff', 'sales_staff', 'finance', 'marketing'];

// ─── authenticateStore — cross-secret and revocation rejection ────────────────

describe('authenticateStore', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects with no Authorization header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    await authenticateStore(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('accepts a genuine STORE_JWT_SECRET token for an active store user, populates req correctly', async () => {
    const token = signStore({ id: 'su1', storeId: 'store-a', role: 'owner', jti: 'jti-1' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    pool.query
      .mockResolvedValueOnce({ rows: [] })                      // revoked_tokens check — not revoked
      .mockResolvedValueOnce({ rows: [{ is_active: true }] });  // store_users.is_active

    await authenticateStore(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.storeUserId).toBe('su1');
    expect(req.storeId).toBe('store-a');
    expect(req.storeRole).toBe('owner');
  });

  // The core adversarial case this whole design exists to prevent
  // (FLASH_STORE_ADMIN_DESIGN.md §3.1's proven three-secret-isolation
  // pattern): a real user/driver token must be cryptographically
  // meaningless to the store-auth boundary, not just logically gated.
  test('rejects a real user/driver token (signed with JWT_SECRET) with 401', async () => {
    const userToken = jwt.sign({ id: 'u1', role: 'user', jti: 'jti-u1' }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const req = { headers: { authorization: `Bearer ${userToken}` } };
    const res = mockRes();
    const next = jest.fn();

    await authenticateStore(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(pool.query).not.toHaveBeenCalled(); // must fail at signature verification, never reach the DB
  });

  test('rejects a real Flash-admin token (signed with ADMIN_JWT_SECRET) with 401', async () => {
    const adminToken = jwt.sign({ id: 'a1', role: 'admin', jti: 'jti-a1' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '8h' });
    const req = { headers: { authorization: `Bearer ${adminToken}` } };
    const res = mockRes();
    const next = jest.fn();

    await authenticateStore(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects an expired store token with TOKEN_EXPIRED', async () => {
    const expiredToken = signStore({ id: 'su1', storeId: 'store-a', role: 'owner', jti: 'jti-2' }, undefined, { expiresIn: '-1s' });
    const req = { headers: { authorization: `Bearer ${expiredToken}` } };
    const res = mockRes();
    await authenticateStore(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'TOKEN_EXPIRED' });
  });

  test('rejects a genuinely-signed store token whose jti was revoked (logout already happened)', async () => {
    const token = signStore({ id: 'su1', storeId: 'store-a', role: 'owner', jti: 'revoked-jti' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    pool.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // revoked_tokens: found

    await authenticateStore(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token revoked' });
  });

  // A deactivated store account (§2 of DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md
  // — Flash's own incident-response override for a compromised store account)
  // must be rejected immediately, not just once the token naturally expires.
  test('rejects a store user whose is_active is false, even with a valid, non-revoked token', async () => {
    const token = signStore({ id: 'su1', storeId: 'store-a', role: 'owner', jti: 'jti-3' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ is_active: false }] });

    await authenticateStore(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account deactivated' });
  });

  test('rejects a store user id that no longer exists at all (deleted row)', async () => {
    const token = signStore({ id: 'deleted-user', storeId: 'store-a', role: 'owner', jti: 'jti-4' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // no store_users row found

    await authenticateStore(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account deactivated' });
  });
});

// ─── requireStoreRole — privilege escalation across all six real roles ────────

describe('requireStoreRole — privilege escalation matrix', () => {
  test('has no req.storeRole at all → 401, not silently permissive', () => {
    const req = {};
    const res = mockRes();
    requireStoreRole('owner')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // Exhaustive matrix: every one of the six real roles (FLASH_STORE_ADMIN_
  // DESIGN.md §5.3) must pass its own gate and be rejected by every other
  // role's gate — not approximated by testing one or two pairs.
  for (const actualRole of REAL_ROLES) {
    test(`${actualRole} passes a gate for its own role`, () => {
      const req = { storeRole: actualRole };
      const res = mockRes();
      const next = jest.fn();
      requireStoreRole(actualRole)(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    const otherRoles = REAL_ROLES.filter((r) => r !== actualRole);
    test(`${actualRole} is rejected (403) by every other role's gate`, () => {
      for (const requiredRole of otherRoles) {
        const req = { storeRole: actualRole };
        const res = mockRes();
        const next = jest.fn();
        requireStoreRole(requiredRole)(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
      }
    });
  }

  test('a multi-role gate (e.g. Accept/Reject/Mark-Ready) admits any listed role and rejects the rest', () => {
    const allowed = ['owner', 'store_manager', 'sales_staff'];
    for (const role of REAL_ROLES) {
      const req = { storeRole: role };
      const res = mockRes();
      const next = jest.fn();
      requireStoreRole(...allowed)(req, res, next);
      if (allowed.includes(role)) {
        expect(next).toHaveBeenCalledWith();
      } else {
        expect(res.status).toHaveBeenCalledWith(403);
      }
    }
  });
});

// ─── requireOwnStore — tenant isolation ────────────────────────────────────────

describe('requireOwnStore — tenant isolation', () => {
  test('not authenticated at all → 401', () => {
    const req = { params: {} };
    const res = mockRes();
    requireOwnStore(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('no storeId referenced anywhere in the request → passes through', () => {
    const req = { storeId: 'store-a', params: {}, body: {}, query: {} };
    const res = mockRes();
    const next = jest.fn();
    requireOwnStore(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  test('route param storeId matches the token — passes', () => {
    const req = { storeId: 'store-a', params: { storeId: 'store-a' }, body: {}, query: {} };
    const res = mockRes();
    const next = jest.fn();
    requireOwnStore(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  // The exact attack FLASH_STORE_ADMIN_DESIGN.md §5.1 names as CRITICAL: a
  // compromised/malicious Store A account sends Store B's real store_id and
  // attempts to read Store B's data via a route param.
  test('route param storeId naming a DIFFERENT real store than the token → 403', () => {
    const req = { storeId: 'store-a', params: { storeId: 'store-b-real-uuid' }, body: {}, query: {} };
    const res = mockRes();
    const next = jest.fn();
    requireOwnStore(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('body storeId naming a different store → 403', () => {
    const req = { storeId: 'store-a', params: {}, body: { storeId: 'store-b-real-uuid' }, query: {} };
    const res = mockRes();
    requireOwnStore(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('query storeId naming a different store → 403', () => {
    const req = { storeId: 'store-a', params: {}, body: {}, query: { storeId: 'store-b-real-uuid' } };
    const res = mockRes();
    requireOwnStore(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── storeAuthController — login/logout ────────────────────────────────────────

jest.mock('bcryptjs');
jest.mock('../../src/models/StoreUser');

describe('StoreAuthController', () => {
  const StoreUser = require('../../src/models/StoreUser');
  const StoreAuthController = require('../../src/controllers/storeAuthController');

  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when email or password missing', async () => {
    const req = { body: { email: 'owner@store.test' } };
    const res = mockRes();
    await StoreAuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 401 for unknown email (no user enumeration)', async () => {
    StoreUser.findByEmail.mockResolvedValue(null);
    const req = { body: { email: 'nobody@store.test', password: 'whatever' } };
    const res = mockRes();
    await StoreAuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 401 for a deactivated account with the SAME message as unknown email', async () => {
    StoreUser.findByEmail.mockResolvedValue({ id: 'su1', is_active: false, password_hash: 'hash' });
    const req = { body: { email: 'deactivated@store.test', password: 'whatever' } };
    const res = mockRes();
    await StoreAuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid credentials' });
  });

  test('returns 401 for wrong password', async () => {
    StoreUser.findByEmail.mockResolvedValue({ id: 'su1', is_active: true, password_hash: 'hash' });
    bcrypt.compare.mockResolvedValue(false);
    const req = { body: { email: 'owner@store.test', password: 'wrong' } };
    const res = mockRes();
    await StoreAuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns a real STORE_JWT_SECRET-signed token with correct claims on success', async () => {
    StoreUser.findByEmail.mockResolvedValue({
      id: 'su1', store_id: 'store-a', name: 'Real Owner', email: 'owner@store.test',
      role: 'owner', is_active: true, password_hash: 'hash',
    });
    bcrypt.compare.mockResolvedValue(true);
    const req = { body: { email: 'owner@store.test', password: 'correct' } };
    const res = mockRes();

    await StoreAuthController.login(req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    const response = res.json.mock.calls[0][0];
    expect(response.token).toBeDefined();
    const decoded = jwt.verify(response.token, process.env.STORE_JWT_SECRET);
    expect(decoded.id).toBe('su1');
    expect(decoded.storeId).toBe('store-a');
    expect(decoded.role).toBe('owner');
    expect(decoded.jti).toBeDefined();
    // Must NOT verify against the other two secrets — cryptographic proof
    // this token cannot be replayed against user/driver or admin routes.
    expect(() => jwt.verify(response.token, process.env.JWT_SECRET)).toThrow();
    expect(() => jwt.verify(response.token, process.env.ADMIN_JWT_SECRET)).toThrow();
  });

  test('logout inserts the token jti into the shared revoked_tokens table', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const token = signStore({ id: 'su1', storeId: 'store-a', role: 'owner', jti: 'logout-jti' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();

    await StoreAuthController.logout(req, res);

    const revokeCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].toLowerCase().includes('revoked_tokens'),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall[1][0]).toBe('logout-jti');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
