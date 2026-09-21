'use strict';
/**
 * tests/unit/auth.test.js
 *
 * Tests for authentication: registration (incl. a real success path, not
 * just validation failures), login, JWT, email verification, password
 * reset, Google/Apple Sign-In (all three real account states each can
 * land in: existing-by-provider-id, link-by-email, brand-new account),
 * refresh token.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/googleAuthService');
jest.mock('../../src/services/appleAuthService');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

const pool  = require('../../src/config/database');
const bcrypt = require('bcryptjs');
const jwt   = require('jsonwebtoken');
const { body } = require('express-validator');

// authRoutes.js declares its express-validator chains inline in the
// router.post(...) calls rather than as an exported constant, so calling
// the controller directly (as these unit tests do) skips them entirely.
// Mirroring the same rules here and running them against req before
// invoking the controller is what makes "returns 400 for invalid input"
// assertions test real behavior instead of a request object no real
// route would ever hand the controller.
const REGISTER_VALIDATORS = [
  body('name').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 10 }),
];
const LOGIN_VALIDATORS = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];
async function runValidators(req, validators) {
  await Promise.all(validators.map((v) => v.run(req)));
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe('AuthController.registerUser', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      body: {
        name: 'Test User',
        email: 'test@example.com',
        password: 'StrongPass123!',
        phone: '+27821234567',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  test('returns 400 when email missing', async () => {
    req.body.email = undefined;
    await runValidators(req, REGISTER_VALIDATORS);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.registerUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    // Must not have reached the DB - validation should short-circuit first.
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Replaces a prior test that asserted registration is blocked when
  // `termsAccepted` is false. That check does not exist anywhere in
  // registerUser or in authRoutes.js's validators - terms acceptance is a
  // separate, authenticated POST /user/accept-terms call made after
  // registration (AuthController.acceptTerms), not a registration gate.
  // The old test never caught this because the whole suite failed to run
  // at all (see H-2). Replaced with a real, currently-enforced rule
  // instead: passwords under 10 characters are rejected
  // (body('password').isLength({ min: 10 }), matching the password-length
  // unification fix elsewhere in this codebase).
  test('returns 400 when password is under 10 characters', async () => {
    req.body.password = 'short1';
    await runValidators(req, REGISTER_VALIDATORS);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.registerUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 409 when email already exists', async () => {
    await runValidators(req, REGISTER_VALIDATORS);
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] }); // email exists check

    const AuthController = require('../../src/controllers/authController');
    await AuthController.registerUser(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  // Coverage-remediation Phase 2 — only the failure paths above were ever
  // tested; nothing proved a real sign-up actually succeeds. Real-world
  // scenario: a new customer fills in the sign-up form and submits valid,
  // available details -> a real account is created, real tokens come
  // back, and the password hash is never included in the response body.
  test('creates the account and returns real tokens on a valid, available sign-up', async () => {
    await runValidators(req, REGISTER_VALIDATORS);
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // User.findByEmail -> no existing account
      .mockResolvedValueOnce({
        rows: [{
          id: 'new-user-1',
          name: 'Test User',
          email: 'test@example.com',
          password_hash: '$2b$12$shouldneverreachtheclient',
          phone: '+27821234567',
          terms_accepted: false,
        }],
      }) // User.create INSERT ... RETURNING *
      .mockResolvedValue({ rows: [] }); // refresh_tokens insert + fire-and-forget email_tokens insert

    bcrypt.hash.mockResolvedValue('$2b$12$fakehashedpassword');
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.registerUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.token).toBe('mock.jwt.token');
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toEqual(expect.objectContaining({ id: 'new-user-1', email: 'test@example.com' }));
    expect(body.user.password_hash).toBeUndefined();
    expect(body.emailVerificationSent).toBe(true);
  });
});

// ─── Google Sign-In (user) ──────────────────────────────────────────────────
//
// Real-world scenarios this describe block protects -- the three real
// account states a Google sign-in attempt can land in, plus token
// verification failure. googleAuthService is mocked at the OAuth-provider
// boundary (googleAuthService.test.js territory would be testing Google's
// own token format; this is testing OUR account-creation/linking logic
// given a verified token), same boundary-mocking precedent already used
// throughout this file for bcryptjs/jsonwebtoken.
describe('AuthController.googleSignInUser', () => {
  let req, res;
  const { verifyGoogleToken } = require('../../src/services/googleAuthService');

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { idToken: 'real-looking-google-id-token' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 when no idToken is sent', async () => {
    req.body.idToken = undefined;
    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(verifyGoogleToken).not.toHaveBeenCalled();
  });

  // Scenario: a returning customer who has signed in with Google before.
  test('logs in an existing account matched by google_id, isNewUser:false', async () => {
    verifyGoogleToken.mockResolvedValue({ sub: 'google-sub-1', email: 'existing@example.com', emailVerified: true, name: 'Existing User' });
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'existing@example.com', password_hash: 'x', google_id: 'google-sub-1' }] }) // byGoogle
      .mockResolvedValue({ rows: [] }); // refresh_tokens insert
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(false);
    expect(body.user.password_hash).toBeUndefined();
  });

  // Scenario: a customer who originally signed up with email/password now
  // signs in with Google for the first time -- their existing account
  // (matched by real email) is linked, not duplicated.
  test('links Google to an existing email/password account, isNewUser:false', async () => {
    verifyGoogleToken.mockResolvedValue({ sub: 'google-sub-2', email: 'existing2@example.com', emailVerified: true, name: 'Existing User Two' });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // byGoogle -> none
      .mockResolvedValueOnce({ rows: [{ id: 'user-2', email: 'existing2@example.com', password_hash: 'x' }] }) // byEmail -> found
      .mockResolvedValue({ rows: [] }); // UPDATE google_id + refresh_tokens insert
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(false);
    expect(body.user.google_id).toBe('google-sub-2');
    // The real linking UPDATE actually ran, not just the response claiming it did.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE users SET google_id/),
      ['google-sub-2', 'user-2'],
    );
  });

  // Scenario: a brand-new customer, never seen before, signs up via Google.
  test('creates a brand-new account when no match exists, isNewUser:true, 201', async () => {
    verifyGoogleToken.mockResolvedValue({ sub: 'google-sub-3', email: 'brandnew@example.com', emailVerified: true, name: 'Brand New' });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // byGoogle -> none
      .mockResolvedValueOnce({ rows: [] }) // byEmail -> none
      .mockResolvedValueOnce({ rows: [{ id: 'user-3', email: 'brandnew@example.com', password_hash: 'x', google_id: 'google-sub-3' }] }) // INSERT ... RETURNING *
      .mockResolvedValue({ rows: [] }); // refresh_tokens insert
    bcrypt.hash.mockResolvedValue('$2b$12$randomplaceholder');
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(true);
    expect(body.user.email).toBe('brandnew@example.com');
    expect(body.user.password_hash).toBeUndefined();
  });

  // Scenario: an expired/forged/mismatched-audience token.
  test('returns 401 when Google token verification fails with a recognizable reason', async () => {
    verifyGoogleToken.mockRejectedValue(new Error('Token used too late, expired'));

    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  // Scenario: something genuinely unexpected (network failure to Google,
  // a real bug) -- must not become a misleading 401 "bad token" message.
  test('returns 500 for a genuinely unexpected verification failure, not a leaked detail', async () => {
    verifyGoogleToken.mockRejectedValue(new Error('ECONNRESET'));

    const AuthController = require('../../src/controllers/authController');
    await AuthController.googleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toMatch(/ECONNRESET/);
  });
});

// ─── Apple Sign-In (user) ───────────────────────────────────────────────────
//
// Same three account-state scenarios as Google above, mirrored for Apple's
// own real, slightly different shape (identityToken instead of idToken,
// fullName instead of a plain name, User.createWithApple instead of a raw
// INSERT for the new-account path).
describe('AuthController.appleSignInUser', () => {
  let req, res;
  const { verifyAppleToken } = require('../../src/services/appleAuthService');

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { identityToken: 'real-looking-apple-identity-token' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 when no identityToken is sent', async () => {
    req.body.identityToken = undefined;
    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(verifyAppleToken).not.toHaveBeenCalled();
  });

  test('logs in an existing account matched by apple_id, isNewUser:false', async () => {
    verifyAppleToken.mockResolvedValue({ sub: 'apple-sub-1', email: 'existing@example.com', emailVerified: true });
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'existing@example.com', password_hash: 'x', apple_id: 'apple-sub-1' }] }) // byApple
      .mockResolvedValue({ rows: [] });
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(false);
    expect(body.user.password_hash).toBeUndefined();
  });

  test('links Apple to an existing email/password account, isNewUser:false', async () => {
    verifyAppleToken.mockResolvedValue({ sub: 'apple-sub-2', email: 'existing2@example.com', emailVerified: true });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // byApple -> none
      .mockResolvedValueOnce({ rows: [{ id: 'user-2', email: 'existing2@example.com', password_hash: 'x' }] }) // byEmail -> found
      .mockResolvedValue({ rows: [] });
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(false);
    expect(body.user.apple_id).toBe('apple-sub-2');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE users SET apple_id/),
      ['apple-sub-2', 'user-2'],
    );
  });

  // Apple famously only sends the real name on the very first sign-in;
  // this proves the fallback (email local-part) works when it's withheld.
  test('creates a brand-new account when no match exists, falling back to email for the name if none given, isNewUser:true, 201', async () => {
    verifyAppleToken.mockResolvedValue({ sub: 'apple-sub-3', email: 'brandnew@example.com', emailVerified: true });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // byApple -> none
      .mockResolvedValueOnce({ rows: [] }) // byEmail -> none
      .mockResolvedValueOnce({ rows: [{ id: 'user-3', email: 'brandnew@example.com', password_hash: 'x', apple_id: 'apple-sub-3' }] }) // User.createWithApple's INSERT
      .mockResolvedValue({ rows: [] });
    bcrypt.hash.mockResolvedValue('$2b$12$randomplaceholder');
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.isNewUser).toBe(true);
    expect(body.user.password_hash).toBeUndefined();
  });

  test('returns 401 when Apple token verification fails with a recognizable reason', async () => {
    verifyAppleToken.mockRejectedValue(new Error('invalid signature'));

    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 500 for a genuinely unexpected verification failure, not a leaked detail', async () => {
    verifyAppleToken.mockRejectedValue(new Error('ECONNRESET'));

    const AuthController = require('../../src/controllers/authController');
    await AuthController.appleSignInUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toMatch(/ECONNRESET/);
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────

describe('AuthController.loginUser', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { email: 'user@example.com', password: 'password123' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 when email or password missing', async () => {
    req.body.password = '';
    await runValidators(req, LOGIN_VALIDATORS);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.loginUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 401 when user not found', async () => {
    await runValidators(req, LOGIN_VALIDATORS);
    pool.query.mockResolvedValue({ rows: [] });

    const AuthController = require('../../src/controllers/authController');
    await AuthController.loginUser(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 401 when password does not match', async () => {
    await runValidators(req, LOGIN_VALIDATORS);
    pool.query.mockResolvedValue({
      rows: [{ id: 'u1', email: 'user@example.com', password_hash: 'hashed', role: 'user' }],
    });
    bcrypt.compare.mockResolvedValue(false);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.loginUser(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns tokens on successful login', async () => {
    await runValidators(req, LOGIN_VALIDATORS);
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'user@example.com',
          password_hash: '$2b$12$hashedpassword',
          role: 'user',
          email_verified: true,
          name: 'Test',
        }],
      })
      .mockResolvedValue({ rows: [] }); // refresh token insert + any subsequent

    bcrypt.compare.mockResolvedValue(true);
    jwt.sign.mockReturnValue('mock.jwt.token');

    const AuthController = require('../../src/controllers/authController');
    await AuthController.loginUser(req, res);
    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response).toHaveProperty('token');
  });
});

// ─── JWT jti in revocation list ───────────────────────────────────────────────

describe('Token revocation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('logout inserts jti into revoked_tokens', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    // logout() decodes the bearer token itself via jwt.decode() to read its
    // jti - jsonwebtoken is auto-mocked in this file, so without an explicit
    // return value here jwt.decode() resolves to undefined and the insert
    // this test claims to verify never actually happens (the previous
    // version of this test passed regardless, because it never set this up
    // and the assertion was checked inside a `typeof === 'function'` guard
    // that silently no-ops if the shape is ever wrong).
    jwt.decode.mockReturnValue({
      jti: 'some-jti-value',
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const req = {
      userId: 'u1',
      userRole: 'user',
      headers: { authorization: 'Bearer mock.token' },
      body: { refreshToken: 'some-refresh-token' },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const AuthController = require('../../src/controllers/authController');
    await AuthController.logout(req, res);

    const revokeCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].toLowerCase().includes('revoked_tokens'),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall[1]).toEqual(['some-jti-value', expect.any(Date)]);
  });
});

// ─── Refresh token rotation & reuse detection ─────────────────────────────────
//
// AuthController.refreshToken runs inside a client transaction (pool.connect(),
// not pool.query() directly) so these tests drive the same shared mock client
// object the __mocks__/database.js pool.connect() always resolves to.

describe('AuthController.refreshToken', () => {
  let req, res, client;

  beforeEach(async () => {
    jest.clearAllMocks();
    req = { body: { refreshToken: 'a-refresh-token' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    client = await pool.connect();
    jwt.sign.mockReturnValue('new.access.token');
  });

  test('rotates a valid, non-revoked refresh token', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })              // BEGIN
      .mockResolvedValueOnce({                            // SELECT ... FOR UPDATE
        rows: [{
          id: 'rt1', user_id: 'u1', role: 'user',
          token: 'a-refresh-token', revoked_at: null,
          expires_at: new Date(Date.now() + 7 * 86400_000),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })                // UPDATE revoked_at=NOW() WHERE id=$1 (rotate out)
      .mockResolvedValueOnce({ rows: [] })                // INSERT new refresh_tokens row
      .mockResolvedValueOnce({ rows: [] });                // COMMIT

    const AuthController = require('../../src/controllers/authController');
    await AuthController.refreshToken(req, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'new.access.token', refreshToken: expect.any(String) }),
    );
    // The used token was rotated out (marked revoked), not deleted or reused.
    const rotateCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE id/i.test(c[0]),
    );
    expect(rotateCall[1]).toEqual(['rt1']);
  });

  // This is the real security property H-2 flagged as having zero test
  // coverage: replaying a refresh token that was already rotated out (i.e.
  // stolen and used by an attacker after, or racing, the legitimate client)
  // must revoke every other live refresh token for that user - not just
  // reject the one reused token - so a compromised session can't be
  // silently re-extended via a stale copy.
  test('replaying an already-rotated refresh token revokes the whole family', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })                // BEGIN
      .mockResolvedValueOnce({                            // SELECT ... FOR UPDATE - already revoked
        rows: [{
          id: 'rt1', user_id: 'u1', role: 'user',
          token: 'a-refresh-token', revoked_at: new Date(Date.now() - 60_000),
          expires_at: new Date(Date.now() + 7 * 86400_000),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })                // UPDATE revoked_at=NOW() WHERE user_id=$1 (revoke-all)
      .mockResolvedValueOnce({ rows: [] });                // COMMIT

    const AuthController = require('../../src/controllers/authController');
    await AuthController.refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Session compromised. Please log in again.' }),
    );

    const revokeAllCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && /WHERE user_id = \$1 AND revoked_at IS NULL/i.test(c[0]),
    );
    expect(revokeAllCall).toBeDefined();
    expect(revokeAllCall[1]).toEqual(['u1']);

    // No new token pair should be issued for a detected replay.
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ token: expect.anything() }));
  });

  test('returns 401 for an unknown refresh token without touching revocation logic', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT ... FOR UPDATE - no match

    const AuthController = require('../../src/controllers/authController');
    await AuthController.refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid refresh token' }));
  });
});

// ─── Password reset ───────────────────────────────────────────────────────────

describe('Password reset flow', () => {
  beforeEach(() => jest.clearAllMocks());

  test('forgotPassword returns 200 even for unknown email (no user enumeration)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const req = { body: { email: 'nobody@example.com' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const AuthController = require('../../src/controllers/authController');
    await AuthController.forgotPassword(req, res);
    // Should never reveal whether email exists
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  test('resetPassword returns 400 for expired token', async () => {
    // resetPassword's SQL itself filters `AND expires_at > NOW()` - an
    // expired token is one the query simply doesn't return a row for, not
    // one the controller inspects expires_at on in JS. The previous version
    // of this test returned a row with a past expires_at, which the
    // controller has no code path that rejects (it only checks
    // result.rows.length), so it silently went down the success path
    // instead of ever hitting the 400 this test claimed to verify.
    pool.query.mockResolvedValue({ rows: [] });

    const req = { body: { token: 'expired-token', newPassword: 'NewPass123!' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const AuthController = require('../../src/controllers/authController');
    await AuthController.resetPassword(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/invalid or expired/i) }),
    );
  });
});

// ─── Date of birth gate (Apple App Store compliance audit) ────────────────────
//
// Closes the OAuth age-gate bypass: Google/Apple Sign In create a row with
// no date_of_birth, skipping dateOfBirthValidator entirely (it's only wired
// into /user/register and /driver/register). These two new routes reuse
// that exact same validator — mirrored here (it's declared inline in
// authRoutes.js, not exported) the same way REGISTER_VALIDATORS/
// LOGIN_VALIDATORS above already mirror the others for the same reason.

const { body: bodyValidator } = require('express-validator');
const DOB_VALIDATOR = bodyValidator('date_of_birth')
  .isISO8601().withMessage('A valid date of birth is required')
  .bail()
  .custom((value) => {
    const dob = new Date(value);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
    if (age < 18) throw new Error('You must be at least 18 years old to register');
    return true;
  });

describe('AuthController.setDateOfBirthUser', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { userId: 'u1', body: { date_of_birth: '2000-01-01' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 for an invalid date', async () => {
    req.body.date_of_birth = 'not-a-date';
    await DOB_VALIDATOR.run(req);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 400 for a date under 18 years ago', async () => {
    const under18 = new Date();
    under18.setFullYear(under18.getFullYear() - 10);
    req.body.date_of_birth = under18.toISOString().slice(0, 10);
    await DOB_VALIDATOR.run(req);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('sets date of birth once and only once, never overwriting an existing value', async () => {
    await DOB_VALIDATOR.run(req);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', email: 'u@example.com', date_of_birth: '2000-01-01', password_hash: 'x' }],
    });

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthUser(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, user: expect.objectContaining({ date_of_birth: '2000-01-01' }) }),
    );
    // password_hash must never leak into the response.
    const response = res.json.mock.calls[0][0];
    expect(response.user.password_hash).toBeUndefined();

    // The one-time guard: only ever writes a row that currently has no DOB.
    const updateCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE users SET date_of_birth/i.test(c[0]),
    );
    expect(updateCall[0]).toMatch(/WHERE id = \$2 AND date_of_birth IS NULL/i);
    expect(updateCall[1]).toEqual(['2000-01-01', 'u1']);
  });

  test('a double-submit after DOB is already set is idempotent, not an error', async () => {
    await DOB_VALIDATOR.run(req);
    // UPDATE ... WHERE date_of_birth IS NULL matches zero rows (already set).
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1', date_of_birth: '1999-05-05', password_hash: 'x' }] }); // findById fallback

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthUser(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, user: expect.objectContaining({ date_of_birth: '1999-05-05' }) }),
    );
  });
});

describe('AuthController.setDateOfBirthDriver', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { userId: 'd1', body: { date_of_birth: '2000-01-01' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 for a date under 18 years ago', async () => {
    const under18 = new Date();
    under18.setFullYear(under18.getFullYear() - 5);
    req.body.date_of_birth = under18.toISOString().slice(0, 10);
    await DOB_VALIDATOR.run(req);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthDriver(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('sets date of birth with the same one-time guard as the user path', async () => {
    await DOB_VALIDATOR.run(req);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'd1', email: 'd@example.com', date_of_birth: '2000-01-01', password_hash: 'x' }],
    });

    const AuthController = require('../../src/controllers/authController');
    await AuthController.setDateOfBirthDriver(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, driver: expect.objectContaining({ date_of_birth: '2000-01-01' }) }),
    );
    const updateCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE drivers SET date_of_birth/i.test(c[0]),
    );
    expect(updateCall[0]).toMatch(/WHERE id = \$2 AND date_of_birth IS NULL/i);
  });
});

// ─── generateToken ────────────────────────────────────────────────────────────
//
// Runs last, deliberately: jest.resetModules() below invalidates every
// module reference this file captured at the top (pool, bcrypt, jwt), and
// each require('../../src/controllers/authController') call inside the
// other describe blocks above pulls in a fresh module instance that would
// silently stop sharing state with those top-level references if this ran
// first. That's not hypothetical - it was the reason every test after this
// one used to fail once the bcrypt/bcryptjs and method-name issues (H-2)
// were fixed enough for the suite to actually execute past module
// resolution: this test used to run first and poisoned everything after it.

describe('generateToken', () => {
  test('includes jti (JWT ID) in token payload', () => {
    // Import after mocks are set
    jest.resetModules();
    const { generateToken } = require('../../src/utils/helpers');

    // Real jwt.sign for this test only
    jest.unmock('jsonwebtoken');
    const realJwt = jest.requireActual('jsonwebtoken');
    jest.spyOn(realJwt, 'sign');

    process.env.JWT_SECRET = 'test_secret_32_chars_minimum_here';
    const token = generateToken('user-001', 'user');
    const decoded = realJwt.verify(token, process.env.JWT_SECRET);

    expect(decoded.jti).toBeDefined();
    expect(decoded.jti).toHaveLength(36); // UUID v4
    expect(decoded.id).toBe('user-001');
    expect(decoded.role).toBe('user');
  });
});
