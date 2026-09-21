'use strict';
/**
 * tests/unit/requireApprovedDriverGate.test.js
 *
 * Coverage-remediation Phase 3 — requireApprovedDriver
 * (src/middleware/auth.js), the single gate standing between an
 * unverified driver applicant and every real driver-only action (going
 * online, accepting orders, delivering, getting paid). Before this file,
 * the only integration test that exercises driver-gated routes
 * (productionStateMachine.test.js) explicitly stubs this middleware away
 * as an unconditional pass-through -- correct for that test's own purpose
 * (it's testing order-state-machine wiring, not this gate), but it meant
 * the gate itself had never actually been proven to block anyone. This
 * file is dedicated, real coverage of the gate in isolation, not a
 * modification of that other test's stub.
 *
 * Real-world scenarios this file protects:
 *   - a driver whose access token already says "approved" (set at login,
 *     from Driver.verifyPassword's real status check) sails through with
 *     no extra DB round-trip on every single driver-app request
 *   - a driver who signed up but never got a fast-path "approved" token
 *     (a stale/pre-approval token, or one issued before requireApprovedDriver
 *     existed) still gets checked fresh against the real, current DB status
 *     -- so an approval that happened after their token was issued is
 *     recognized, and so is a suspension
 *   - a driver at every real non-approved status (pending_documents,
 *     documents_submitted, under_review, rejected, suspended) is actually
 *     blocked, with the specific real message that status gets -- not a
 *     generic "forbidden"
 *   - a driver id that doesn't correspond to a real row at all (deleted
 *     account, corrupted token) gets a clean 404, not a crash
 *   - a database failure during the fresh check is passed to Express's
 *     error handler (next(err)), not silently swallowed or misreported
 *     as a 403
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const { requireApprovedDriver } = require('../../src/middleware/auth');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('requireApprovedDriver — the fast path (already-approved token)', () => {
  test('allows through immediately when the token itself says approved, with no DB query at all', async () => {
    const req = { driverStatus: 'approved', userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('requireApprovedDriver — the real, fresh DB check', () => {
  test('allows through a driver whose current DB status is approved', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'approved' }] });
    const req = { driverStatus: undefined, userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('blocks a driver stuck at pending_documents, with the real, specific message', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'pending_documents' }] });
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Please upload your required documents.', status: 'pending_documents' });
  });

  test('blocks a driver whose documents are submitted but not yet reviewed', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'documents_submitted' }] });
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Documents under review. You will be notified once approved.', status: 'documents_submitted' });
  });

  test('blocks a driver whose application is under review', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'under_review' }] });
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Application being reviewed by our team.', status: 'under_review' });
  });

  test('blocks a rejected driver', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'rejected' }] });
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Application not approved. Contact support.', status: 'rejected' });
  });

  // Suspended is handled by its own early branch (distinct message, not
  // the msgs lookup table) -- real-world scenario: a driver auto-suspended
  // by reassignStuckDriverOrders (driverAutoSuspensionService.js) tries to
  // use the app again before their still-valid access token expires. The
  // fast path above can never let this through: the JWT's status claim is
  // set once at login and never says "approved" for an already-suspended
  // driver, and even if it somehow did, this gate's whole point is to
  // re-check the real, current DB status.
  test('blocks a suspended driver with its own distinct message', async () => {
    pool.query.mockResolvedValue({ rows: [{ status: 'suspended' }] });
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account suspended. Contact support.', status: 'suspended' });
  });

  test('returns 404 when the driver id in the token no longer corresponds to a real row', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const req = { userId: 'deleted-driver-id' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Driver not found' });
  });

  test('passes a real database failure to next(err), not a silent 403', async () => {
    const dbError = new Error('connection terminated unexpectedly');
    pool.query.mockRejectedValue(dbError);
    const req = { userId: 'driver-1' };
    const res = mockRes();
    const next = jest.fn();

    await requireApprovedDriver(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
  });
});
