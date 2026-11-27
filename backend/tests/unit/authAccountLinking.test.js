'use strict';
/**
 * tests/unit/authAccountLinking.test.js
 *
 * Step 1 (#102), FI-013 / audit P0-6: account takeover through Google or
 * Apple sign-in. Founder rule: never link accounts by a client-supplied
 * email; link only when BOTH emails are verified.
 *
 *   - Google linked an existing account by email without checking that
 *     Google had verified that email.
 *   - Apple fell back to `email` from the request body, which the app (or
 *     an attacker) chooses, to find, link, AND create accounts.
 *   - Drivers have no email verification at all, so a driver account is
 *     never linked by email: the driver signs in with their password.
 */
jest.mock('../../src/config/database');
jest.mock('../../src/services/googleAuthService', () => ({ verifyGoogleToken: jest.fn() }));
jest.mock('../../src/services/appleAuthService', () => ({ verifyAppleToken: jest.fn() }));
jest.mock('../../src/services/emailService', () => ({
  sendPasswordResetEmail: jest.fn(), sendEmailVerificationEmail: jest.fn(),
}));
jest.mock('../../src/middleware/requireFeature', () => ({
  featureIsOn: jest.fn().mockResolvedValue(true),
  refuseFeature: jest.fn(),
}));
jest.mock('../../src/models/User', () => ({
  createWithApple: jest.fn(async (u) => ({ id: 'new-user', ...u, password_hash: 'x' })),
}));

const pool = require('../../src/config/database');
const { verifyGoogleToken } = require('../../src/services/googleAuthService');
const { verifyAppleToken } = require('../../src/services/appleAuthService');
const User = require('../../src/models/User');
const AuthController = require('../../src/controllers/authController');

const VICTIM = { id: 'victim-1', email: 'victim@example.test', email_verified: true, password_hash: 'x', status: 'approved' };

function res() {
  const r = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  r.set = jest.fn(() => r);
  return r;
}

// existing: what a lookup BY EMAIL finds (users or drivers). Lookups by
// provider id find nothing (first sign-in with this Google/Apple identity).
function db(existing) {
  pool.query = jest.fn(async (sql, params) => {
    const s = String(sql);
    if (/WHERE (google_id|apple_id) = \$1/.test(s)) return { rows: [] };
    if (/WHERE email = \$1/.test(s)) return { rows: existing && params[0] === existing.email ? [{ ...existing }] : [] };
    if (/INSERT INTO (users|drivers)/.test(s)) return { rows: [{ id: 'new-account', email: params[1], password_hash: 'x' }] };
    return { rows: [] };
  });
}
const linked = () => pool.query.mock.calls.some(([s]) => /UPDATE (users|drivers) SET (google_id|apple_id)/.test(String(s)));
const created = () => pool.query.mock.calls.some(([s]) => /INSERT INTO (users|drivers)/.test(String(s)));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only-000000';
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('Google, customer accounts', () => {
  test('both emails verified: the Google identity is linked and the user signed in', async () => {
    db(VICTIM);
    verifyGoogleToken.mockResolvedValue({ sub: 'g-1', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.googleSignInUser({ body: { idToken: 't' } }, r);
    expect(linked()).toBe(true);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ isNewUser: false }));
  });

  test('Google has NOT verified the email: no link, no tokens (409)', async () => {
    db(VICTIM);
    verifyGoogleToken.mockResolvedValue({ sub: 'g-attacker', email: VICTIM.email, emailVerified: false });
    const r = res();
    await AuthController.googleSignInUser({ body: { idToken: 't' } }, r);
    expect(linked()).toBe(false);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCOUNT_EXISTS' }));
    expect(r.json.mock.calls[0][0]).not.toHaveProperty('token');
  });

  test('the existing Flash account never verified its email: no link (409)', async () => {
    db({ ...VICTIM, email_verified: false });
    verifyGoogleToken.mockResolvedValue({ sub: 'g-1', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.googleSignInUser({ body: { idToken: 't' } }, r);
    expect(linked()).toBe(false);
    expect(r.status).toHaveBeenCalledWith(409);
  });
});

describe('Google, driver accounts (drivers have no email verification)', () => {
  test('an existing driver with that email is never linked by email (409)', async () => {
    db(VICTIM);
    verifyGoogleToken.mockResolvedValue({ sub: 'g-attacker', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.googleSignInDriver({ body: { idToken: 't' } }, r);
    expect(linked()).toBe(false);
    expect(created()).toBe(false);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json.mock.calls[0][0]).not.toHaveProperty('token');
  });
});

describe('Apple, customer accounts', () => {
  test('the email in the request body is never used to find an account', async () => {
    db(VICTIM);
    // A real Apple token for the attacker's own Apple ID, carrying no email,
    // plus the victim's email typed into the request body.
    verifyAppleToken.mockResolvedValue({ sub: 'a-attacker', email: null, emailVerified: false });
    const r = res();
    await AuthController.appleSignInUser({ body: { identityToken: 't', email: VICTIM.email } }, r);
    expect(linked()).toBe(false);
    expect(pool.query.mock.calls.some(([s, p]) => /WHERE email = \$1/.test(String(s)) && p[0] === VICTIM.email)).toBe(false);
    // A new account is created, but never under the body email.
    expect(User.createWithApple).toHaveBeenCalledWith(expect.objectContaining({ email: expect.stringMatching(/@flash\.private$/) }));
  });

  test('the token\'s own verified email links when the Flash account is verified too', async () => {
    db(VICTIM);
    verifyAppleToken.mockResolvedValue({ sub: 'a-1', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.appleSignInUser({ body: { identityToken: 't' } }, r);
    expect(linked()).toBe(true);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ isNewUser: false }));
  });

  test('the Flash account never verified its email: no link (409)', async () => {
    db({ ...VICTIM, email_verified: false });
    verifyAppleToken.mockResolvedValue({ sub: 'a-1', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.appleSignInUser({ body: { identityToken: 't' } }, r);
    expect(linked()).toBe(false);
    expect(r.status).toHaveBeenCalledWith(409);
  });
});

describe('Apple, driver accounts', () => {
  test('never linked by email, and the body email is ignored', async () => {
    db(VICTIM);
    verifyAppleToken.mockResolvedValue({ sub: 'a-attacker', email: VICTIM.email, emailVerified: true });
    const r = res();
    await AuthController.appleSignInDriver({ body: { identityToken: 't', email: VICTIM.email } }, r);
    expect(linked()).toBe(false);
    expect(r.status).toHaveBeenCalledWith(409);
  });

  test('a new driver is created with the token email, never the body email', async () => {
    db(null);
    verifyAppleToken.mockResolvedValue({ sub: 'a-new', email: null, emailVerified: false });
    const r = res();
    await AuthController.appleSignInDriver({ body: { identityToken: 't', email: 'someone.else@example.test' } }, r);
    const insert = pool.query.mock.calls.find(([s]) => /INSERT INTO drivers/.test(String(s)));
    expect(insert[1][1]).toMatch(/@flash\.private$/);
  });
});
