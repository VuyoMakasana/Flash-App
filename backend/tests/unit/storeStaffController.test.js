'use strict';
/**
 * tests/unit/storeStaffController.test.js
 *
 * Owner-only staff management. The route layer enforces that only an owner
 * reaches these handlers; what this file pins is what the handlers themselves
 * guarantee once reached:
 *
 *   - new staff are always created inside the caller's own store, whatever the
 *     request body claims
 *   - passwords are hashed, never stored or echoed back
 *   - the duplicate-email case (a real UNIQUE constraint) reads as a client
 *     error, not a server fault
 *   - an owner cannot deactivate themselves, which would lock the whole store
 *     out with no self-service way back in
 */

jest.mock('../../src/config/database');
jest.mock('../../src/models/StoreUser', () => ({
  listByStore: jest.fn(),
  create: jest.fn(),
  deactivate: jest.fn(),
}));
jest.mock('../../src/models/StoreAction', () => ({ log: jest.fn() }));

const StoreUser = require('../../src/models/StoreUser');
const StoreAction = require('../../src/models/StoreAction');
const StoreStaffController = require('../../src/controllers/storeStaffController');

const MY_STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const mockReq = (o = {}) => ({ storeId: MY_STORE, storeUserId: OWNER_ID, params: {}, body: {}, ...o });

const validBody = {
  name: 'Sam', email: 'sam@example.com', password: 'a-long-enough-password', role: 'store_manager',
};

beforeEach(() => jest.clearAllMocks());

describe('listStaff', () => {
  test('lists only this store\'s staff', async () => {
    StoreUser.listByStore.mockResolvedValue([{ id: STAFF_ID }]);
    const res = mockRes();

    await StoreStaffController.listStaff(mockReq(), res);

    expect(StoreUser.listByStore).toHaveBeenCalledWith(MY_STORE);
    expect(res.json).toHaveBeenCalledWith({ staff: [{ id: STAFF_ID }] });
  });

  test('a failure is a 500', async () => {
    StoreUser.listByStore.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();
    await StoreStaffController.listStaff(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('createStaff', () => {
  test.each([
    ['name', { ...validBody, name: undefined }],
    ['email', { ...validBody, email: undefined }],
    ['password', { ...validBody, password: undefined }],
    ['role', { ...validBody, role: undefined }],
  ])('rejects a request missing %s', async (_field, body) => {
    const res = mockRes();
    await StoreStaffController.createStaff(mockReq({ body }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StoreUser.create).not.toHaveBeenCalled();
  });

  test('rejects a role outside the allowed set', async () => {
    const res = mockRes();
    await StoreStaffController.createStaff(mockReq({ body: { ...validBody, role: 'superuser' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StoreUser.create).not.toHaveBeenCalled();
  });

  test('rejects a password shorter than the minimum', async () => {
    const res = mockRes();
    await StoreStaffController.createStaff(mockReq({ body: { ...validBody, password: 'short' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StoreUser.create).not.toHaveBeenCalled();
  });

  // The isolation guarantee: a body claiming another store must not be honoured.
  test('always creates the account in the caller\'s own store', async () => {
    StoreUser.create.mockResolvedValue({ id: STAFF_ID });
    await StoreStaffController.createStaff(
      mockReq({ body: { ...validBody, storeId: OTHER_STORE } }), mockRes(),
    );

    expect(StoreUser.create).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: MY_STORE }),
    );
    expect(StoreUser.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ storeId: OTHER_STORE }),
    );
  });

  test('hashes the password and never passes the plaintext through', async () => {
    StoreUser.create.mockResolvedValue({ id: STAFF_ID });
    await StoreStaffController.createStaff(mockReq({ body: validBody }), mockRes());

    const { passwordHash, password } = StoreUser.create.mock.calls[0][0];
    expect(passwordHash).toMatch(/^\$2[aby]\$/);
    expect(passwordHash).not.toBe(validBody.password);
    expect(password).toBeUndefined();
  });

  test('audit-logs the creation with the granted role', async () => {
    StoreUser.create.mockResolvedValue({ id: STAFF_ID });
    const res = mockRes();

    await StoreStaffController.createStaff(mockReq({ body: validBody }), res);

    expect(StoreAction.log).toHaveBeenCalledWith(
      OWNER_ID, MY_STORE, 'store_staff_create', 'store_users', STAFF_ID, { role: 'store_manager' },
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a duplicate email is a 409, not a 500', async () => {
    const dup = new Error('duplicate key value violates unique constraint');
    dup.code = '23505';
    StoreUser.create.mockRejectedValue(dup);
    const res = mockRes();

    await StoreStaffController.createStaff(mockReq({ body: validBody }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('any other failure is a 500', async () => {
    StoreUser.create.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();
    await StoreStaffController.createStaff(mockReq({ body: validBody }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deactivateStaff', () => {
  // There is no reactivate counterpart and only an owner can call this, so
  // self-deactivation would lock the entire store out irrecoverably.
  test('an owner cannot deactivate their own account', async () => {
    const res = mockRes();
    await StoreStaffController.deactivateStaff(
      mockReq({ params: { staffId: OWNER_ID } }), res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StoreUser.deactivate).not.toHaveBeenCalled();
  });

  test('deactivates a staff member within this store', async () => {
    StoreUser.deactivate.mockResolvedValue({ id: STAFF_ID, is_active: false });
    const res = mockRes();

    await StoreStaffController.deactivateStaff(mockReq({ params: { staffId: STAFF_ID } }), res);

    expect(StoreUser.deactivate).toHaveBeenCalledWith(STAFF_ID, MY_STORE);
    expect(StoreAction.log).toHaveBeenCalledWith(
      OWNER_ID, MY_STORE, 'store_staff_deactivate', 'store_users', STAFF_ID,
    );
  });

  // The scoped UPDATE matching nothing is how a cross-store attempt surfaces.
  test('another store\'s staff member is 404 and is not audit-logged', async () => {
    StoreUser.deactivate.mockResolvedValue(null);
    const res = mockRes();

    await StoreStaffController.deactivateStaff(mockReq({ params: { staffId: STAFF_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(StoreAction.log).not.toHaveBeenCalled();
  });

  test('a failure is a 500', async () => {
    StoreUser.deactivate.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();
    await StoreStaffController.deactivateStaff(mockReq({ params: { staffId: STAFF_ID } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
