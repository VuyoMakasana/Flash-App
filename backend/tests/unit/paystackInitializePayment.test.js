'use strict';
/**
 * tests/unit/paystackInitializePayment.test.js
 *
 * Section 2.8 audit — initializePayment previously did a plain SELECT (no
 * lock) then, only after a slow external Paystack call, an UPDATE. Since
 * the mobile app's own request timeout (20s) is shorter than this
 * service's own outbound Paystack timeout (30s) by design margin, a
 * customer's retry after a timeout could race a still-in-flight first
 * attempt and independently call Paystack a second time -- two real,
 * valid references for one order, with the single paystack_reference
 * column silently overwritten by whichever finished last.
 *
 * Fixed with the same lock-then-commit-before-external-call pattern
 * chargeSavedCard (paymentController.js) already used correctly: these
 * tests assert the *ordering* (the DB commit happens before Paystack is
 * ever called, and a concurrent/repeat call never reaches Paystack once
 * a reference is already committed), not just the final return value.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const paystackService = require('../../src/services/paystackService');

const ORDER_ID = 'order-1';
const USER_ID  = 'user-1';

function makeTxClient(queryImpl) {
  return {
    query: jest.fn().mockImplementation(queryImpl),
    release: jest.fn(),
  };
}

function orderRow(overrides = {}) {
  return {
    id: ORDER_ID, total: '120.00', subtotal: '100.00', user_id: USER_ID,
    payment_status: 'pending', paystack_reference: null, updated_at: new Date(),
    ...overrides,
  };
}

describe('paystackService.initializePayment — ordering and locking', () => {
  let requestSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    requestSpy = jest.spyOn(paystackService, 'request');
  });
  afterEach(() => requestSpy.mockRestore());

  test('locks the order row with SELECT ... FOR UPDATE', async () => {
    const client = makeTxClient((sql) => {
      if (/SELECT .* FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow()] });
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] });
    requestSpy.mockResolvedValueOnce({
      status: true,
      data: { authorization_url: 'https://paystack.com/pay/x', reference: 'flash_order-1_abc' },
    });

    await paystackService.initializePayment(ORDER_ID, USER_ID);

    const lockCall = client.query.mock.calls.find((c) => /FOR UPDATE/.test(c[0]));
    expect(lockCall).toBeDefined();
  });

  test('commits the reference to the DB BEFORE calling Paystack, not after', async () => {
    const callOrder = [];
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow()] });
      if (/UPDATE orders SET paystack_reference/.test(sql)) callOrder.push('db_commit_reference');
      if (/COMMIT/.test(sql)) callOrder.push('db_commit_tx');
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] });
    requestSpy.mockImplementationOnce(async () => {
      callOrder.push('paystack_call');
      return { status: true, data: { authorization_url: 'https://paystack.com/pay/x', reference: 'flash_order-1_abc' } };
    });

    await paystackService.initializePayment(ORDER_ID, USER_ID);

    expect(callOrder).toEqual(['db_commit_reference', 'db_commit_tx', 'paystack_call']);
  });

  test('a second call while the first is already pending never reaches Paystack', async () => {
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) {
        return Promise.resolve({ rows: [orderRow({ payment_status: 'pending', paystack_reference: 'flash_order-1_existing' })] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    const result = await paystackService.initializePayment(ORDER_ID, USER_ID);

    expect(result.awaitingWebhook).toBe(true);
    expect(result.reference).toBe('flash_order-1_existing');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  // A narrower edge case the above lock fix surfaced during live Docker
  // verification: if the *first* caller's own Paystack call later fails
  // and reverts, a second caller who already received that reference via
  // the short-circuit path above would otherwise be left "awaiting
  // confirmation" for a reference no webhook will ever arrive for. A
  // stale-pending reference (older than the 2-minute threshold) is not
  // trusted -- it's safely superseded by a fresh one instead.
  test('supersedes a stale pending reference (older than 2 min) with a fresh one', async () => {
    const staleDate = new Date(Date.now() - 3 * 60 * 1000);
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) {
        return Promise.resolve({ rows: [orderRow({ paystack_reference: 'flash_order-1_stale', updated_at: staleDate })] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] });
    requestSpy.mockResolvedValueOnce({
      status: true,
      data: { authorization_url: 'https://paystack.com/pay/fresh', reference: 'flash_order-1_fresh' },
    });

    const result = await paystackService.initializePayment(ORDER_ID, USER_ID);

    expect(result.awaitingWebhook).toBeUndefined();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const updateCall = client.query.mock.calls.find((c) => /UPDATE orders SET paystack_reference/.test(c[0]));
    expect(updateCall[1][0]).not.toBe('flash_order-1_stale');
  });

  test('still short-circuits a recently-set pending reference (within 2 min)', async () => {
    const freshDate = new Date(Date.now() - 30 * 1000);
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) {
        return Promise.resolve({ rows: [orderRow({ paystack_reference: 'flash_order-1_recent', updated_at: freshDate })] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    const result = await paystackService.initializePayment(ORDER_ID, USER_ID);

    expect(result.awaitingWebhook).toBe(true);
    expect(result.reference).toBe('flash_order-1_recent');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  test('throws Order not found and never calls Paystack', async () => {
    const client = makeTxClient(() => Promise.resolve({ rows: [] }));
    pool.connect.mockResolvedValueOnce(client);

    await expect(paystackService.initializePayment(ORDER_ID, USER_ID)).rejects.toThrow('Order not found');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  test('throws Order already paid and never calls Paystack', async () => {
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow({ payment_status: 'paid' })] });
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    await expect(paystackService.initializePayment(ORDER_ID, USER_ID)).rejects.toThrow('Order already paid');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  test('reverts the committed reference if the Paystack call itself fails', async () => {
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow()] });
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] }); // email lookup
    requestSpy.mockRejectedValueOnce(new Error('Paystack API request timeout'));
    pool.query.mockResolvedValueOnce({ rows: [] }); // the revert UPDATE

    await expect(paystackService.initializePayment(ORDER_ID, USER_ID)).rejects.toThrow('Paystack API request timeout');

    const revertCall = pool.query.mock.calls.find((c) => /paystack_reference=NULL/.test(c[0]));
    expect(revertCall).toBeDefined();
    expect(revertCall[1][0]).toBe(ORDER_ID);
  });

  test('reverts when Paystack responds with status:false', async () => {
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow()] });
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] });
    requestSpy.mockResolvedValueOnce({ status: false, message: 'Invalid email' });
    pool.query.mockResolvedValueOnce({ rows: [] }); // the revert UPDATE

    await expect(paystackService.initializePayment(ORDER_ID, USER_ID)).rejects.toThrow('Invalid email');

    const revertCall = pool.query.mock.calls.find((c) => /paystack_reference=NULL/.test(c[0]));
    expect(revertCall).toBeDefined();
  });

  test('rolls back and throws Not your order for a non-owner caller', async () => {
    const client = makeTxClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [orderRow({ user_id: 'someone-else' })] });
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    await expect(paystackService.initializePayment(ORDER_ID, USER_ID)).rejects.toThrow('Not your order');
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
