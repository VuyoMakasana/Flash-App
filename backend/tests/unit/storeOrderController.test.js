'use strict';
/**
 * tests/unit/storeOrderController.test.js
 *
 * The Store Admin Portal's Orders backend: the list/detail reads a store owner
 * sees, and the three real state-machine actions they can take (accept, reject,
 * mark ready). This is the file Phase 2's payouts will build on, and it carries
 * the per-request tenant-isolation checks for anything keyed by :orderId --
 * requireOwnStore cannot help there, because the id in the URL is an order id,
 * not a store id. So the isolation has to live here, and it has to be tested
 * here.
 *
 * Every assertion is against what the controller actually sends to the database
 * or returns to the client -- not a re-implementation of its logic.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService', () => ({
  acceptOrder: jest.fn(),
  rejectPendingAcceptance: jest.fn(),
  markReadyForPickup: jest.fn(),
}));
jest.mock('../../src/models/StoreAction', () => ({ log: jest.fn() }));

const db = require('../../src/config/database');
const StoreAction = require('../../src/models/StoreAction');
const {
  acceptOrder,
  rejectPendingAcceptance,
  markReadyForPickup,
} = require('../../src/services/orderStateMachineService');
const StoreOrderController = require('../../src/controllers/storeOrderController');

const MY_STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORDER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function mockReq(overrides = {}) {
  return {
    storeId: MY_STORE,
    storeUserId: 'user-1',
    query: {},
    params: {},
    app: { get: jest.fn(() => null) },
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('listOrders', () => {
  test('scopes the query to the token\'s store, never a client-supplied one', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await StoreOrderController.listOrders(mockReq({ query: { storeId: OTHER_STORE } }), mockRes());

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE o\.store_id = \$1/);
    expect(params[0]).toBe(MY_STORE);
    expect(params).not.toContain(OTHER_STORE);
  });

  test('applies a status filter as a bound parameter, not string interpolation', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await StoreOrderController.listOrders(mockReq({ query: { status: 'delivered' } }), mockRes());

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/AND o\.status = \$2/);
    expect(params).toContain('delivered');
  });

  test('clamps pagination rather than trusting the client', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreOrderController.listOrders(mockReq({ query: { page: '-5', limit: '9999' } }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 100 }));
  });

  test('a garbage limit falls back to the default instead of becoming NaN', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreOrderController.listOrders(mockReq({ query: { limit: 'abc' } }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  test('a database failure is a 500, not an unhandled rejection', async () => {
    db.query.mockRejectedValue(new Error('connection lost'));
    const res = mockRes();
    await StoreOrderController.listOrders(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getOrder — tenant isolation', () => {
  test('returns another store\'s order as 404, never its contents', async () => {
    db.query.mockResolvedValue({ rows: [{ id: ORDER_ID, store_id: OTHER_STORE, total: '500.00' }] });
    const res = mockRes();
    await StoreOrderController.getOrder(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    // 404 rather than 403 deliberately: a 403 would confirm the order exists.
    expect(res.json).toHaveBeenCalledWith({ error: 'Order not found' });
    const returned = res.json.mock.calls[0][0];
    expect(returned.order).toBeUndefined();
  });

  test('returns the order when it does belong to this store', async () => {
    const order = { id: ORDER_ID, store_id: MY_STORE, total: '500.00' };
    db.query.mockResolvedValue({ rows: [order] });
    const res = mockRes();
    await StoreOrderController.getOrder(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.json).toHaveBeenCalledWith({ order });
  });

  test('a genuinely missing order is also 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreOrderController.getOrder(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('accept / reject / markReady — ownership is checked before anything runs', () => {
  test.each([
    ['accept', 'accept', acceptOrder],
    ['reject', 'reject', rejectPendingAcceptance],
    ['markReady', 'markReady', markReadyForPickup],
  ])('%s refuses to act on another store\'s order', async (_label, method, stateMachineFn) => {
    db.query.mockResolvedValue({ rows: [{ store_id: OTHER_STORE }] });
    const res = mockRes();

    await StoreOrderController[method](mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    // The critical assertion: the state machine must never be reached at all,
    // so a cross-tenant call cannot mutate another store's order even partially.
    expect(stateMachineFn).not.toHaveBeenCalled();
    expect(StoreAction.log).not.toHaveBeenCalled();
  });

  test('accept runs the state machine and audit-logs when the order is ours', async () => {
    db.query.mockResolvedValue({ rows: [{ store_id: MY_STORE }] });
    acceptOrder.mockResolvedValue({ order: { id: ORDER_ID, status: 'preparing' } });
    const res = mockRes();

    await StoreOrderController.accept(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(acceptOrder).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ actorId: 'user-1', actorRole: 'store' }),
    );
    expect(StoreAction.log).toHaveBeenCalledWith(
      'user-1', MY_STORE, 'order_accept', 'orders', ORDER_ID,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Order accepted — now preparing.' }),
    );
  });

  test('reject passes a reason through to the state machine', async () => {
    db.query.mockResolvedValue({ rows: [{ store_id: MY_STORE }] });
    rejectPendingAcceptance.mockResolvedValue({ id: ORDER_ID, status: 'cancelled' });
    await StoreOrderController.reject(mockReq({ params: { orderId: ORDER_ID } }), mockRes());

    expect(rejectPendingAcceptance).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ reason: expect.stringMatching(/Store Admin Portal/) }),
    );
  });

  test('an order that no longer exists is 404 and never reaches the state machine', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await StoreOrderController.accept(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(acceptOrder).not.toHaveBeenCalled();
  });

  // A state-machine refusal is the store owner's mistake (they clicked Accept
  // on an order that already moved on), not a server fault, and must read as
  // one. These two fragments are the real ones the controller classifies on --
  // asserting against invented wording would pass while proving nothing.
  test.each([
    ['Illegal transition from delivered to preparing'],
    ['Order is not awaiting store acceptance'],
  ])('a state-machine refusal (%s) surfaces as 400, not 500', async (message) => {
    db.query.mockResolvedValue({ rows: [{ store_id: MY_STORE }] });
    acceptOrder.mockRejectedValue(new Error(message));
    const res = mockRes();

    await StoreOrderController.accept(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('an unexpected fault is still a 500', async () => {
    db.query.mockResolvedValue({ rows: [{ store_id: MY_STORE }] });
    acceptOrder.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const res = mockRes();

    await StoreOrderController.accept(mockReq({ params: { orderId: ORDER_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getAnalytics', () => {
  test('every aggregate query is scoped to this store', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await StoreOrderController.getAnalytics(mockReq({ query: {} }), mockRes());

    expect(db.query).toHaveBeenCalled();
    for (const [sql, params] of db.query.mock.calls) {
      expect(sql).toMatch(/store_id = \$1/);
      expect(params[0]).toBe(MY_STORE);
    }
  });

  test('a database failure is a 500', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const res = mockRes();
    await StoreOrderController.getAnalytics(mockReq({ query: {} }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
