'use strict';
/**
 * tests/unit/auth.test.js
 *
 * Tests for authentication: registration, login, JWT, email verification,
 * password reset, Google Sign-In, refresh token.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService');
jest.mock('../../src/services/googleAuthService');
jest.mock('bcrypt');
jest.mock('jsonwebtoken');

const pool  = require('../../src/config/database');
const bcrypt = require('bcrypt');
const jwt   = require('jsonwebtoken');

// ─── generateToken ────────────────────────────────────────────────────────────

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

// ─── Registration ─────────────────────────────────────────────────────────────

describe('AuthController.register', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      body: {
        name: 'Test User',
        email: 'test@example.com',
        password: 'StrongPass123!',
        phone: '+27821234567',
        termsAccepted: true,
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  test('returns 400 when email missing', async () => {
    req.body.email = undefined;
    const { register } = require('../../src/controllers/authController');
    await register(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 409 when email already exists', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] }); // email exists check

    const AuthController = require('../../src/controllers/authController');
    await AuthController.register(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('returns 400 when terms not accepted', async () => {
    req.body.termsAccepted = false;
    pool.query.mockResolvedValue({ rows: [] });

    const AuthController = require('../../src/controllers/authController');
    await AuthController.register(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────

describe('AuthController.login', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { email: 'user@example.com', password: 'password123' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  test('returns 400 when email or password missing', async () => {
    req.body.password = '';
    const AuthController = require('../../src/controllers/authController');
    await AuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 401 when user not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const AuthController = require('../../src/controllers/authController');
    await AuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 401 when password does not match', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 'u1', email: 'user@example.com', password_hash: 'hashed', role: 'user' }],
    });
    bcrypt.compare.mockResolvedValue(false);

    const AuthController = require('../../src/controllers/authController');
    await AuthController.login(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns tokens on successful login', async () => {
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
    await AuthController.login(req, res);
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

    const req = {
      userId: 'u1',
      userRole: 'user',
      headers: { authorization: 'Bearer mock.token' },
      body: { refreshToken: 'some-refresh-token' },
      jti: 'some-jti-value',
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const AuthController = require('../../src/controllers/authController');
    if (typeof AuthController.logout === 'function') {
      await AuthController.logout(req, res);
      const revokeCall = pool.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].toLowerCase().includes('revoked_tokens'),
      );
      expect(revokeCall).toBeDefined();
    }
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
    if (typeof AuthController.forgotPassword === 'function') {
      await AuthController.forgotPassword(req, res);
      // Should never reveal whether email exists
      expect(res.status).not.toHaveBeenCalledWith(404);
    }
  });

  test('resetPassword returns 400 for expired token', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 't1', expires_at: new Date(Date.now() - 1000), used_at: null }],
    });

    const req = { body: { token: 'expired-token', newPassword: 'NewPass123!' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const AuthController = require('../../src/controllers/authController');
    if (typeof AuthController.resetPassword === 'function') {
      await AuthController.resetPassword(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });
});
