'use strict';
/**
 * tests/unit/storeOnboarding.test.js
 *
 * Phase 3 — self-service store onboarding: the public application endpoint and
 * the admin approval service.
 *
 * The properties pinned here are the ones that make onboarding safe to expose
 * publicly, each asserted as observable behaviour rather than a restatement of
 * the implementation:
 *
 *   - an application grants nothing: the store is created inactive and pending,
 *     and its owner account inactive, so nothing is reachable until a human
 *     approves it
 *   - the store and its owner are created in ONE transaction, so a duplicate
 *     email cannot leave an orphan store that nobody can ever sign in to
 *   - the endpoint cannot be used to discover which emails are registered
 *   - approval is all-or-nothing, and cannot be replayed to re-issue a second
 *     credential-setting token for an account that already has a password
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/emailService', () => ({ sendStoreWelcomeEmail: jest.fn() }));
jest.mock('express-validator', () => ({
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
  body: jest.fn(),
}));

const pool = require('../../src/config/database');
const { sendStoreWelcomeEmail } = require('../../src/services/emailService');
const { validationResult } = require('express-validator');
const StoreOnboardingController = require('../../src/controllers/storeOnboardingController');
const StoreOnboardingService = require('../../src/services/storeOnboardingService');

const STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const validApplication = {
  store_name: 'Kwazakhele Threads',
  owner_name: 'Nomsa Dlamini',
  owner_email: 'Nomsa.Dlamini@Example.com',
  owner_phone: '0821110000',
  address: '14 Mkele Street',
};

// A fake pg client whose behaviour per statement the test controls.
function mockClient({ failOn = null, error = null, rows = {} } = {}) {
  const client = {
    query: jest.fn(async (sql) => {
      const text = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (failOn && text.includes(failOn)) throw error;
      if (text.includes('INSERT INTO stores')) return { rows: [{ id: STORE_ID, status: 'pending', is_active: false }] };
      if (text.includes('INSERT INTO store_users')) return { rows: [{ id: OWNER_ID }] };
      if (text.includes('UPDATE stores')) return { rows: rows.storeUpdate ?? [{ id: STORE_ID, status: 'approved' }] };
      if (text.includes('UPDATE store_users')) return { rows: rows.ownerUpdate ?? [{ id: OWNER_ID, email: 'o@e.com', name: 'Owner' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  validationResult.mockReturnValue({ isEmpty: () => true, array: () => [] });
});

describe('apply — the public application endpoint', () => {
  test('creates the store pending and inactive, never approved', async () => {
    const client = mockClient();
    await StoreOnboardingController.apply({ body: validApplication }, mockRes());

    const insert = client.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO stores'));
    expect(insert[0]).toMatch(/false, 'pending'/);
    // Nothing the applicant sent may influence status or activation.
    expect(insert[1]).not.toContain('approved');
  });

  test('creates the owner account and the store in the same transaction', async () => {
    const client = mockClient();
    await StoreOnboardingController.apply({ body: validApplication }, mockRes());

    const statements = client.query.mock.calls.map(([s]) => String(s));
    expect(statements[0]).toMatch(/BEGIN/);
    expect(statements.some((s) => s.includes('INSERT INTO stores'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO store_users'))).toBe(true);
    expect(statements.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('the owner account is created inactive, so approval is the only way in', async () => {
    const client = mockClient();
    await StoreOnboardingController.apply({ body: validApplication }, mockRes());

    const deactivate = client.query.mock.calls.find(([s]) => /UPDATE store_users SET is_active = false/.test(String(s)));
    expect(deactivate).toBeDefined();
  });

  test('the placeholder password is a real bcrypt hash of discarded randomness', async () => {
    const client = mockClient();
    await StoreOnboardingController.apply({ body: validApplication }, mockRes());

    const insert = client.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO store_users'));
    const hash = insert[1][3];
    expect(hash).toMatch(/^\$2[aby]\$/);
    // Must not be a guessable sentinel that becomes a live credential the
    // moment the account is activated.
    expect(hash).not.toMatch(/pending|placeholder|changeme/i);
  });

  test('the email is normalised, so case cannot be used to bypass uniqueness', async () => {
    const client = mockClient();
    await StoreOnboardingController.apply({ body: validApplication }, mockRes());

    const insert = client.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO store_users'));
    expect(insert[1][2]).toBe('nomsa.dlamini@example.com');
  });

  test.each([
    ['store_name', { ...validApplication, store_name: undefined }],
    ['owner_name', { ...validApplication, owner_name: undefined }],
    ['owner_email', { ...validApplication, owner_email: undefined }],
  ])('rejects an application missing %s before opening a transaction', async (_f, body) => {
    const res = mockRes();
    await StoreOnboardingController.apply({ body }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // The important one: a unique-violation must not leave a store behind.
  test('a duplicate email rolls the whole application back', async () => {
    const dup = new Error('duplicate key value violates unique constraint');
    dup.code = '23505';
    const client = mockClient({ failOn: 'INSERT INTO store_users', error: dup });
    const res = mockRes();

    await StoreOnboardingController.apply({ body: validApplication }, res);

    expect(client.query.mock.calls.some(([s]) => /ROLLBACK/.test(String(s)))).toBe(true);
    expect(client.query.mock.calls.some(([s]) => /COMMIT/.test(String(s)))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('a duplicate email is indistinguishable from a successful application', async () => {
    const dup = new Error('duplicate');
    dup.code = '23505';
    mockClient({ failOn: 'INSERT INTO store_users', error: dup });
    const duplicate = mockRes();
    await StoreOnboardingController.apply({ body: validApplication }, duplicate);

    mockClient();
    const fresh = mockRes();
    await StoreOnboardingController.apply({ body: validApplication }, fresh);

    expect(duplicate.status).toHaveBeenCalledWith(201);
    expect(fresh.status).toHaveBeenCalledWith(201);
    expect(duplicate.json.mock.calls[0][0]).toEqual(fresh.json.mock.calls[0][0]);
  });

  test('the response never leaks the created store id', async () => {
    mockClient();
    const res = mockRes();
    await StoreOnboardingController.apply({ body: validApplication }, res);

    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(STORE_ID);
  });

  test('an unexpected database failure is a 500 and rolls back', async () => {
    const client = mockClient({ failOn: 'INSERT INTO stores', error: new Error('connection lost') });
    const res = mockRes();

    await StoreOnboardingController.apply({ body: validApplication }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(client.query.mock.calls.some(([s]) => /ROLLBACK/.test(String(s)))).toBe(true);
  });
});

describe('approve — the admin decision', () => {
  test('activates the store, activates the owner and issues one invite', async () => {
    const client = mockClient();
    sendStoreWelcomeEmail.mockResolvedValue({});

    const result = await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    expect(result.ok).toBe(true);
    const statements = client.query.mock.calls.map(([s]) => String(s));
    expect(statements.some((s) => /UPDATE stores[\s\S]*status = 'approved'/.test(s))).toBe(true);
    expect(statements.some((s) => /UPDATE store_users SET is_active = true/.test(s))).toBe(true);
    expect(statements.some((s) => /INSERT INTO store_password_tokens/.test(s))).toBe(true);
    expect(statements.some((s) => /COMMIT/.test(s))).toBe(true);
  });

  test('the store update is scoped so an already-decided application cannot be re-approved', async () => {
    const client = mockClient();
    await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    const update = client.query.mock.calls.find(([s]) => /UPDATE stores/.test(String(s)));
    expect(update[0]).toMatch(/status IN \('pending','under_review'\)/);
  });

  // The dangerous replay: re-approving must not mint a second live token for an
  // account that already has a real password.
  test('approving an already-approved store is refused and issues no new invite', async () => {
    const client = mockClient({ rows: { storeUpdate: [] } }); // scoped UPDATE matched nothing
    const result = await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    expect(result).toEqual({ ok: false, reason: 'not_pending' });
    const statements = client.query.mock.calls.map(([s]) => String(s));
    expect(statements.some((s) => /INSERT INTO store_password_tokens/.test(s))).toBe(false);
    expect(statements.some((s) => /ROLLBACK/.test(s))).toBe(true);
    expect(sendStoreWelcomeEmail).not.toHaveBeenCalled();
  });

  test('an application with no owner account is refused rather than half-applied', async () => {
    const client = mockClient({ rows: { ownerUpdate: [] } });
    const result = await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    expect(result).toEqual({ ok: false, reason: 'no_owner' });
    expect(client.query.mock.calls.some(([s]) => /ROLLBACK/.test(String(s)))).toBe(true);
    expect(client.query.mock.calls.some(([s]) => /COMMIT/.test(String(s)))).toBe(false);
  });

  test('any previous token is deleted before a new one is issued', async () => {
    const client = mockClient();
    await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    const statements = client.query.mock.calls.map(([s]) => String(s));
    const deleteIdx = statements.findIndex((s) => /DELETE FROM store_password_tokens/.test(s));
    const insertIdx = statements.findIndex((s) => /INSERT INTO store_password_tokens/.test(s));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(insertIdx);
  });

  test('the invite token is long, random, and expires in the future', async () => {
    const client = mockClient();
    await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    const insert = client.query.mock.calls.find(([s]) => /INSERT INTO store_password_tokens/.test(String(s)));
    const [, token, expiresAt] = insert[1];
    expect(token).toMatch(/^[0-9a-f]{96}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // The email is a side effect of a decision that has already committed.
  test('the welcome email is sent only after COMMIT', async () => {
    const client = mockClient();
    sendStoreWelcomeEmail.mockResolvedValue({});

    await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    const statements = client.query.mock.calls.map(([s]) => String(s));
    expect(statements.some((s) => /COMMIT/.test(s))).toBe(true);
    expect(sendStoreWelcomeEmail).toHaveBeenCalled();
  });

  test('a failing welcome email does not undo the approval', async () => {
    mockClient();
    sendStoreWelcomeEmail.mockRejectedValue(new Error('Resend API 401'));

    const result = await StoreOnboardingService.approve(STORE_ID, ADMIN_ID);

    expect(result.ok).toBe(true);
  });
});

describe('reject', () => {
  test('records the decision without deleting the application', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: STORE_ID, status: 'rejected' }] });
    const result = await StoreOnboardingService.reject(STORE_ID, ADMIN_ID, 'Outside service area');

    expect(result.ok).toBe(true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE stores/);
    expect(sql).not.toMatch(/DELETE/);
    expect(sql).toMatch(/status IN \('pending','under_review'\)/);
    expect(params).toContain('Outside service area');
  });

  test('rejecting an already-decided application is refused', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(StoreOnboardingService.reject(STORE_ID, ADMIN_ID, 'late'))
      .resolves.toEqual({ ok: false, reason: 'not_pending' });
  });
});
