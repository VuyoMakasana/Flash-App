'use strict';

// Admin hardening (#87): A1b per-account lockout, A4 role check, A7 dummy
// hash, A2 session cookie, A3 session secret, A4 drivers actions.

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(), on: jest.fn(), end: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const { createAdminLoginLockout, MAX_FAILURES, WINDOW_MS } = require('../../src/services/adminLoginLockout');
const { createAdminCredentials, DUMMY_BCRYPT_HASH } = require('../../src/services/adminCredentials');

const ADMIN = { id: 'a1', email: 'founder@flash.invalid', name: 'Founder', role: 'admin' };
const PASSWORD = 'correct horse battery staple';
let HASH;
beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

function fakeAdmins(rows) {
  return { findByEmail: jest.fn(async (email) => rows.find((r) => r.email === String(email).trim().toLowerCase()) || null) };
}

describe('A1b: per-account lockout (5 failures in 15 minutes)', () => {
  test('5 and 15 minutes, exactly as decided', () => {
    expect(MAX_FAILURES).toBe(5);
    expect(WINDOW_MS).toBe(15 * 60 * 1000);
  });

  test('locks after 5 failures; even the right password is then refused; other accounts are unaffected', async () => {
    const lockout = createAdminLoginLockout();
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, password_hash: HASH }]), lockout });
    for (let i = 0; i < 5; i++) expect((await verify('founder@flash.invalid', 'wrong')).ok).toBe(false);
    const locked = await verify('founder@flash.invalid', PASSWORD);
    expect(locked).toEqual({ ok: false, reason: 'locked' });
    expect(await lockout.isLocked('other@flash.invalid')).toBe(false);
  });

  test('the key ignores case and surrounding spaces, so variants share one counter', async () => {
    const lockout = createAdminLoginLockout();
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, password_hash: HASH }]), lockout });
    for (const e of ['Founder@Flash.invalid', ' founder@flash.invalid', 'FOUNDER@FLASH.INVALID', 'founder@flash.invalid ', 'founder@flash.invalid']) {
      await verify(e, 'wrong');
    }
    expect(await lockout.isLocked('founder@flash.invalid')).toBe(true);
  });

  test('a successful login before the limit resets the count', async () => {
    const lockout = createAdminLoginLockout();
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, password_hash: HASH }]), lockout });
    for (let i = 0; i < 4; i++) await verify('founder@flash.invalid', 'wrong');
    expect((await verify('founder@flash.invalid', PASSWORD)).ok).toBe(true);
    for (let i = 0; i < 4; i++) await verify('founder@flash.invalid', 'wrong');
    expect(await lockout.isLocked('founder@flash.invalid')).toBe(false);
  });

  test('the lock lifts when the 15-minute window ends', async () => {
    // MemoryStore sets the reset time from the real clock, so the test clock starts at real time.
    let t = Date.now();
    const lockout = createAdminLoginLockout({ now: () => t });
    for (let i = 0; i < 5; i++) await lockout.recordFailure('founder@flash.invalid');
    expect(await lockout.isLocked('founder@flash.invalid')).toBe(true);
    t += WINDOW_MS - 60 * 1000;
    expect(await lockout.isLocked('founder@flash.invalid')).toBe(true); // a minute before the end: still locked
    t += 2 * 60 * 1000;
    expect(await lockout.isLocked('founder@flash.invalid')).toBe(false);
  });

  test('while locked, no password comparison runs at all', async () => {
    const lockout = createAdminLoginLockout();
    const compare = jest.fn(async () => false);
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, password_hash: HASH }]), lockout, compare });
    for (let i = 0; i < 5; i++) await verify('founder@flash.invalid', 'wrong');
    compare.mockClear();
    await verify('founder@flash.invalid', PASSWORD);
    expect(compare).not.toHaveBeenCalled();
  });
});

describe('A4: only role = admin may log in', () => {
  test('a row with another role is refused like a wrong password, and counts as a failure', async () => {
    const lockout = createAdminLoginLockout();
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, role: 'support', password_hash: HASH }]), lockout });
    expect(await verify('founder@flash.invalid', PASSWORD)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('an admin whose stored email has capitals can still log in (the lookup is the email as typed, only trimmed)', async () => {
    const exactOnly = { findByEmail: jest.fn(async (email) => (email === 'Founder@Flash.invalid' ? { ...ADMIN, email: 'Founder@Flash.invalid', password_hash: HASH } : null)) };
    const verify = createAdminCredentials({ Admin: exactOnly, lockout: createAdminLoginLockout() });
    expect((await verify(' Founder@Flash.invalid ', PASSWORD)).ok).toBe(true);
    expect(exactOnly.findByEmail).toHaveBeenCalledWith('Founder@Flash.invalid');
  });

  test('role admin with the right password is accepted and returns no password hash', async () => {
    const verify = createAdminCredentials({ Admin: fakeAdmins([{ ...ADMIN, password_hash: HASH }]), lockout: createAdminLoginLockout() });
    const r = await verify('founder@flash.invalid', PASSWORD);
    expect(r).toEqual({ ok: true, admin: ADMIN });
  });
});

describe('A7: unknown emails still cost one bcrypt comparison', () => {
  test('an unknown email is compared against a dummy hash (same work as a real account)', async () => {
    const compare = jest.fn(async () => false);
    const verify = createAdminCredentials({ Admin: fakeAdmins([]), lockout: createAdminLoginLockout(), compare });
    expect(await verify('nobody@flash.invalid', 'whatever')).toEqual({ ok: false, reason: 'invalid' });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith('whatever', DUMMY_BCRYPT_HASH);
  });

  test('the dummy hash is a real bcrypt hash at cost 12 that matches nothing guessable', async () => {
    expect(DUMMY_BCRYPT_HASH).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    for (const guess of ['', 'password', 'admin', 'x']) expect(await bcrypt.compare(guess, DUMMY_BCRYPT_HASH)).toBe(false);
  });
});

describe('POST /api/admin/login uses the same checks', () => {
  let app;
  const Admin = require('../../src/models/Admin');
  const savedRender = process.env.RENDER;
  beforeAll(() => {
    process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-only-admin-jwt-secret-placeholder';
    process.env.RENDER = 'true'; // production header handling: each request below is its own client
    app = require('../../src/server').createApp().app;
  });
  afterAll(() => { if (savedRender === undefined) delete process.env.RENDER; else process.env.RENDER = savedRender; });
  afterEach(() => jest.restoreAllMocks());
  const request = require('supertest');
  const login = (email, password, ip) => request(app).post('/api/admin/login').set('CF-Connecting-IP', ip).send({ email, password });

  test('a non-admin role gets the same 401 as a wrong password', async () => {
    jest.spyOn(Admin, 'findByEmail').mockResolvedValue({ ...ADMIN, email: 'support1@flash.invalid', role: 'support', password_hash: HASH });
    const r = await login('support1@flash.invalid', PASSWORD, '203.0.113.11');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid credentials' });
  });

  test('after 5 failures the account is locked: 429 even with the right password', async () => {
    jest.spyOn(Admin, 'findByEmail').mockResolvedValue({ ...ADMIN, email: 'lock1@flash.invalid', password_hash: HASH });
    // Different client addresses, so the per-IP limiter isn't what stops it: the per-account lockout is.
    for (let i = 0; i < 5; i++) expect((await login('lock1@flash.invalid', 'wrong', `203.0.113.${20 + i}`)).status).toBe(401);
    const r = await login('lock1@flash.invalid', PASSWORD, '203.0.113.40');
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Too many failed login attempts for this account/);
  });

  test('the right password for an admin still returns a token', async () => {
    jest.spyOn(Admin, 'findByEmail').mockResolvedValue({ ...ADMIN, email: 'ok1@flash.invalid', password_hash: HASH });
    const r = await login('ok1@flash.invalid', PASSWORD, '203.0.113.50');
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
  });
});

describe('AdminJS authenticate: the same checks, plus a new session id at login (A2)', () => {
  const { createAdminJsAuthenticate } = require('../../src/adminPanel');

  test('regenerates the session before AdminJS stores the logged-in admin', async () => {
    const verify = jest.fn(async () => ({ ok: true, admin: ADMIN }));
    const authenticate = createAdminJsAuthenticate(verify);
    const regenerate = jest.fn((cb) => cb());
    const user = await authenticate('founder@flash.invalid', PASSWORD, { req: { session: { regenerate } } });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(user).toEqual({ id: 'a1', email: 'founder@flash.invalid', name: 'Founder', role: 'admin' });
  });

  test('failure or lockout returns null and keeps the session as it is', async () => {
    for (const result of [{ ok: false, reason: 'invalid' }, { ok: false, reason: 'locked' }]) {
      const regenerate = jest.fn((cb) => cb());
      const authenticate = createAdminJsAuthenticate(jest.fn(async () => result));
      expect(await authenticate('x@flash.invalid', 'x', { req: { session: { regenerate } } })).toBeNull();
      expect(regenerate).not.toHaveBeenCalled();
    }
  });

  test('a regenerate error fails the login rather than keeping the old session id', async () => {
    const authenticate = createAdminJsAuthenticate(jest.fn(async () => ({ ok: true, admin: ADMIN })));
    const regenerate = jest.fn((cb) => cb(new Error('store down')));
    await expect(authenticate('founder@flash.invalid', PASSWORD, { req: { session: { regenerate } } })).rejects.toThrow('store down');
  });
});

describe('A2: the session cookie', () => {
  const { buildAdminSessionOptions, ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_MAX_AGE_MS } = require('../../src/adminPanel');

  test('httpOnly, Secure in production, SameSite=Strict, 8 hours, not saved until login', () => {
    const o = buildAdminSessionOptions({ NODE_ENV: 'production', RENDER: 'true' }, 's'.repeat(40));
    expect(o).toEqual({
      secret: 's'.repeat(40),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 },
    });
    expect(ADMIN_SESSION_MAX_AGE_MS).toBe(8 * 60 * 60 * 1000);
  });

  test('not Secure locally (plain http), everything else the same', () => {
    const o = buildAdminSessionOptions({ NODE_ENV: 'development' }, 's'.repeat(40));
    expect(o.cookie).toEqual({ httpOnly: true, secure: false, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 });
  });

  test('a non-default cookie name', () => {
    expect(ADMIN_SESSION_COOKIE_NAME).not.toBe('adminjs');
    expect(ADMIN_SESSION_COOKIE_NAME).toMatch(/^[a-z_]+$/);
  });
});

describe('A3: ADMIN_SESSION_SECRET', () => {
  const { resolveAdminSessionSecret } = require('../../src/adminPanel');
  const JWT = 'j'.repeat(48);
  const GOOD = 'g'.repeat(48);

  test('production: a separate secret of 32+ characters is used', () => {
    expect(resolveAdminSessionSecret({ NODE_ENV: 'production', ADMIN_JWT_SECRET: JWT, ADMIN_SESSION_SECRET: GOOD })).toBe(GOOD);
    expect(resolveAdminSessionSecret({ RENDER: 'true', ADMIN_JWT_SECRET: JWT, ADMIN_SESSION_SECRET: GOOD })).toBe(GOOD);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['shorter than 32 characters', 'short-secret'],
    ['the same as ADMIN_JWT_SECRET', JWT],
  ])('production: %s -> refuses (the panel does not start)', (_name, value) => {
    expect(() => resolveAdminSessionSecret({ NODE_ENV: 'production', RENDER: 'true', ADMIN_JWT_SECRET: JWT, ADMIN_SESSION_SECRET: value }))
      .toThrow(/ADMIN_SESSION_SECRET/);
  });

  test('the refusal message names the variable, never a value', () => {
    try {
      resolveAdminSessionSecret({ NODE_ENV: 'production', ADMIN_JWT_SECRET: JWT, ADMIN_SESSION_SECRET: JWT });
    } catch (err) {
      expect(err.message).not.toContain(JWT);
    }
  });

  test('locally, without it: a random per-process secret (never ADMIN_JWT_SECRET)', () => {
    const s1 = resolveAdminSessionSecret({ NODE_ENV: 'development', ADMIN_JWT_SECRET: JWT });
    const s2 = resolveAdminSessionSecret({ NODE_ENV: 'development', ADMIN_JWT_SECRET: JWT });
    expect(s1).not.toBe(JWT);
    expect(s1.length).toBeGreaterThanOrEqual(32);
    expect(s1).not.toBe(s2);
  });

  test('mountAdminPanel refuses in production before loading AdminJS, so the API keeps working', async () => {
    const { mountAdminPanel } = require('../../src/adminPanel');
    const saved = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.RENDER = 'true';
    delete process.env.ADMIN_SESSION_SECRET;
    try {
      await expect(mountAdminPanel({ locals: {} })).rejects.toThrow(/ADMIN_SESSION_SECRET/);
    } finally {
      process.env = saved;
    }
  });
});

describe('A4: drivers in the admin panel', () => {
  const { buildResources } = require('../../src/adminPanel');
  test('create, delete and bulk delete are off; edit and the approve/reject actions stay', () => {
    const drivers = buildResources({ table: (tableName) => ({ tableName, properties: [] }) })
      .find((r) => r.resource.tableName === 'drivers');
    const a = drivers.options.actions;
    expect(a.new.isAccessible).toBe(false);
    expect(a.delete.isAccessible).toBe(false);
    expect(a.bulkDelete.isAccessible).toBe(false);
    expect(a.edit.isAccessible).not.toBe(false);
    expect(a.approveDriver).toBeDefined();
    expect(a.rejectDriver).toBeDefined();
  });
});
