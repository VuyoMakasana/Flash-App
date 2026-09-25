'use strict';
/**
 * tests/unit/storeBankingController.test.js
 *
 * Phase 2a — where a store's settlement money goes.
 *
 * No money moves yet (2c does that), but this is the record 2c will pay
 * against. Paying the wrong account is the most damaging thing this system
 * could do to a real merchant, so these tests are almost entirely adversarial:
 * each one tries to get a payout destination changed, or read back something it
 * should not, by a route that should be closed.
 *
 * The four controls under test:
 *   1. password re-authentication — a hijacked session is not enough
 *   2. bank name verification — a mistyped digit cannot silently redirect money
 *   3. the account number is never stored and never returned
 *   4. the bank-held name is never echoed back (no lookup oracle)
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/paystackService', () => ({
  verifyBankAccount: jest.fn(),
  createTransferRecipient: jest.fn(),
  getBankList: jest.fn(),
}));
jest.mock('../../src/models/StoreAction', () => ({ log: jest.fn() }));
jest.mock('../../src/services/emailService', () => ({
  sendStorePayoutDestinationChangedEmail: jest.fn(() => Promise.resolve()),
  EMAIL_SUBJECTS: {},
  TRACKED_EMAIL_KINDS: {},
}));
jest.mock('express-validator', () => ({
  body: jest.fn(() => ({ isString: jest.fn(), trim: jest.fn() })),
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
}));
jest.mock('../../src/models/StoreTransferRecipient', () => ({
  getActiveForStore: jest.fn(),
  replaceForStore: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const pool = require('../../src/config/database');
const paystackService = require('../../src/services/paystackService');
const StoreAction = require('../../src/models/StoreAction');
const StoreTransferRecipient = require('../../src/models/StoreTransferRecipient');
const emailService = require('../../src/services/emailService');
const StoreBankingController = require('../../src/controllers/storeBankingController');

const MY_STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CORRECT_PASSWORD = 'correct-horse-battery';

let PASSWORD_HASH;

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function mockReq(body = {}) {
  return { storeId: MY_STORE, storeUserId: OWNER_ID, body };
}

function validBody(overrides = {}) {
  return {
    account_number: '1234567890',
    bank_code: '632005',
    account_name: 'Nomsa Dlamini',
    password: CORRECT_PASSWORD,
    ...overrides,
  };
}

// The actor read: password hash + email + store name in one query.
function mockActorRow() {
  pool.query.mockResolvedValueOnce({
    rows: [{
      password_hash: PASSWORD_HASH,
      email: 'owner@example.com',
      owner_name: 'Nomsa Dlamini',
      store_name: 'Kwazakhele Threads',
    }],
  });
}

function mockBankResolves(accountName = 'NOMSA DLAMINI') {
  paystackService.verifyBankAccount.mockResolvedValue({
    status: true,
    data: { account_name: accountName, bank_name: 'Absa Bank' },
  });
}

function mockRecipientCreated(code = 'RCP_test123') {
  paystackService.createTransferRecipient.mockResolvedValue({
    status: true,
    data: { recipient_code: code },
  });
  StoreTransferRecipient.replaceForStore.mockResolvedValue({
    id: 'dest-1', bank_name: 'Absa Bank', bank_code: '632005',
    account_last4: '7890', account_name: accountName(code),
  });
}
function accountName() { return 'NOMSA DLAMINI'; }

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(CORRECT_PASSWORD, 4); // low cost: test speed
});

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Re-authentication
// ─────────────────────────────────────────────────────────────────────────────

describe('setDestination — a valid session alone is not enough', () => {
  test('a wrong password is refused and nothing is registered or written', async () => {
    mockActorRow();
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody({ password: 'wrong' })), res);

    expect(res.status).toHaveBeenCalledWith(401);
    // The critical assertions: the external registration and the write must
    // never be reached, so a hijacked session cannot redirect money.
    expect(paystackService.verifyBankAccount).not.toHaveBeenCalled();
    expect(paystackService.createTransferRecipient).not.toHaveBeenCalled();
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });

  test('a deactivated account cannot change payout details', async () => {
    // The actor query filters on is_active, so a deactivated user returns no row.
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });

  test('the actor lookup is scoped by store as well as user id', async () => {
    mockActorRow();
    await StoreBankingController.setDestination(mockReq(validBody({ password: 'wrong' })), mockRes());

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/su\.id = \$1/);
    expect(sql).toMatch(/su\.store_id = \$2/);
    expect(params).toEqual([OWNER_ID, MY_STORE]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bank verification — the mistyped-digit case
// ─────────────────────────────────────────────────────────────────────────────

describe('setDestination — the account must verifiably belong to this name', () => {
  test('an unresolvable account number is refused', async () => {
    mockActorRow();
    paystackService.verifyBankAccount.mockResolvedValue({ status: false, data: null });
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(paystackService.createTransferRecipient).not.toHaveBeenCalled();
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });

  test('a name mismatch is refused — this is the mistyped-digit guard', async () => {
    mockActorRow();
    mockBankResolves('PETER SMITH'); // a real account, but somebody else's
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });

  test('the bank-held name is NEVER echoed back on mismatch (no lookup oracle)', async () => {
    // Returning it would let anyone submit an arbitrary account number with a
    // deliberately wrong name and read the real holder's name out of the error.
    mockActorRow();
    mockBankResolves('PETER SMITH');
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toMatch(/PETER/i);
    expect(body).not.toMatch(/SMITH/i);
  });

  test('a bank formatting difference still succeeds', async () => {
    // "MR N DLAMINI" is the same person as "Nomsa Dlamini". Rejecting this
    // would lock legitimate owners out of their own accounts.
    mockActorRow();
    mockBankResolves('MR N DLAMINI');
    mockRecipientCreated();
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(StoreTransferRecipient.replaceForStore).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  test('a provider outage is a 502, never a silent success', async () => {
    mockActorRow();
    paystackService.verifyBankAccount.mockRejectedValue(new Error('network down'));
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });

  test('a failed recipient registration does not write a destination', async () => {
    // Persisting without a recipient_code would leave a destination that looks
    // set but cannot be paid.
    mockActorRow();
    mockBankResolves();
    paystackService.createTransferRecipient.mockResolvedValue({ status: true, data: {} });
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(StoreTransferRecipient.replaceForStore).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What gets stored, and what comes back
// ─────────────────────────────────────────────────────────────────────────────

describe('setDestination — the account number is never persisted', () => {
  test('only the last four digits are stored, and the BANK\'s spelling of the name', async () => {
    mockActorRow();
    mockBankResolves('NOMSA DLAMINI');
    mockRecipientCreated('RCP_abc');
    await StoreBankingController.setDestination(mockReq(validBody()), mockRes());

    const [, payload] = StoreTransferRecipient.replaceForStore.mock.calls[0];
    expect(payload.accountLast4).toBe('7890');
    // The full number must appear nowhere in what is persisted.
    expect(JSON.stringify(payload)).not.toContain('1234567890');
    // The bank's own spelling is stored, not the submitted one — the bank is
    // the authority on whose account it is.
    expect(payload.accountName).toBe('NOMSA DLAMINI');
    expect(payload.recipientCode).toBe('RCP_abc');
  });

  test('the response never contains the account number or the recipient code', async () => {
    mockActorRow();
    mockBankResolves();
    mockRecipientCreated('RCP_secret');
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toContain('1234567890');
    expect(body).not.toContain('RCP_secret');
  });

  test('the change is audit-logged and the owner notified', async () => {
    mockActorRow();
    mockBankResolves();
    mockRecipientCreated();
    await StoreBankingController.setDestination(mockReq(validBody()), mockRes());

    expect(StoreAction.log).toHaveBeenCalledWith(
      OWNER_ID, MY_STORE, 'payout_destination_changed', 'store_transfer_recipients', 'dest-1',
    );
    expect(emailService.sendStorePayoutDestinationChangedEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ accountLast4: '7890' }),
    );
  });

  test('a notification failure does not fail the change', async () => {
    // The write is already committed; an email cannot be rolled back, and the
    // owner successfully made a change they are entitled to make.
    mockActorRow();
    mockBankResolves();
    mockRecipientCreated();
    emailService.sendStorePayoutDestinationChangedEmail.mockRejectedValue(new Error('mail down'));
    const res = mockRes();

    await StoreBankingController.setDestination(mockReq(validBody()), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ destination: expect.any(Object) }));
  });
});

describe('getDestination', () => {
  test('is scoped to the token\'s store', async () => {
    StoreTransferRecipient.getActiveForStore.mockResolvedValue(null);
    await StoreBankingController.getDestination(mockReq(), mockRes());
    expect(StoreTransferRecipient.getActiveForStore).toHaveBeenCalledWith(MY_STORE);
  });

  test('no destination on file is null, not a 404', async () => {
    // A store that has not set one yet is a normal state the portal renders,
    // not an error condition.
    StoreTransferRecipient.getActiveForStore.mockResolvedValue(null);
    const res = mockRes();
    await StoreBankingController.getDestination(mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ destination: null });
  });
});
