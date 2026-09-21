'use strict';
/**
 * tests/unit/orderHistoryController.test.js
 *
 * Coverage-remediation Phase 2 — OrderController.getUserOrders (GET
 * /api/orders/my-orders), the "view order history" screen's real backend.
 * Before this file, the only thing touching this code path was
 * tests/unit/phoneRedaction.test.js's "Order.getUserOrders — batched phone
 * redaction" tests -- real, but incidental: they exist to prove phone
 * redaction, not to prove this controller's own request handling
 * (pagination parsing/clamping, hasMore computation, error mapping). This
 * file is specifically that missing controller-level coverage.
 *
 * Real-world scenarios this file protects:
 *   - a customer opens their order history with no query params -> a
 *     sensible default page/limit is used
 *   - a customer scrolls further (page=N) or the app requests a smaller/
 *     larger page -> the real params reach Order.getUserOrders, clamped to
 *     a sane range so a buggy or malicious client can't ask for an
 *     unbounded page
 *   - the app needs to know whether to show a "load more" affordance ->
 *     hasMore is computed correctly from whether a full page came back
 *   - the database fails -> a clean 500, not a crash
 */

jest.mock('../../src/models/Order');

const Order = require('../../src/models/Order');
const OrderController = require('../../src/controllers/orderController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('OrderController.getUserOrders', () => {
  test('defaults to page 1, limit 20 when no query params are given', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: {} };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('user-1', 1, 20);
  });

  test('passes through a real page and limit from the query string', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: { page: '3', limit: '10' } };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('user-1', 3, 10);
  });

  test('clamps limit to a maximum of 50 even if a client asks for more', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: { limit: '500' } };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('user-1', 1, 50);
  });

  test('clamps a zero or negative page/limit up to 1', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: { page: '-5', limit: '0' } };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('user-1', 1, 1);
  });

  // Caught a real bug writing this test (fixed the same day, see the BUG
  // FIX comment on OrderController.getUserOrders): parseInt('abc') is NaN,
  // and Math.max/Math.min involving NaN always return NaN too -- there was
  // no actual fallback despite the `|| '1'`/`|| '20'` reading like there
  // was, and the resulting NaN crashed Order.getUserOrders's real SQL
  // LIMIT/OFFSET with a raw Postgres error (confirmed live before the
  // fix). The controller now explicitly falls back to the real defaults.
  test('a garbage (non-numeric) page/limit falls back to the real defaults (1, 20), not NaN', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: { page: 'abc', limit: 'xyz' } };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('user-1', 1, 20);
  });

  test('hasMore is true when a full page of results comes back', async () => {
    const fullPage = Array.from({ length: 20 }, (_, i) => ({ id: `order-${i}` }));
    Order.getUserOrders.mockResolvedValue(fullPage);
    const req = { userId: 'user-1', query: {} };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(res.json).toHaveBeenCalledWith({ orders: fullPage, page: 1, limit: 20, hasMore: true });
  });

  test('hasMore is false when fewer than a full page comes back (the last page)', async () => {
    const partialPage = [{ id: 'order-1' }, { id: 'order-2' }];
    Order.getUserOrders.mockResolvedValue(partialPage);
    const req = { userId: 'user-1', query: {} };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(res.json).toHaveBeenCalledWith({ orders: partialPage, page: 1, limit: 20, hasMore: false });
  });

  test('hasMore is false, not a crash, when the customer has no orders at all', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    const req = { userId: 'user-1', query: {} };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(res.json).toHaveBeenCalledWith({ orders: [], page: 1, limit: 20, hasMore: false });
  });

  test('only ever fetches the calling user\'s own orders (req.userId, never client input)', async () => {
    Order.getUserOrders.mockResolvedValue([]);
    // A malicious/buggy client trying to ask for someone else's orders via
    // the query string has no field that could do that -- req.userId comes
    // from the authenticated token (middleware/auth.js), not req.query.
    const req = { userId: 'real-authenticated-user', query: { userId: 'someone-elses-id' } };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(Order.getUserOrders).toHaveBeenCalledWith('real-authenticated-user', 1, 20);
  });

  test('returns 500 without leaking internal detail when the model throws', async () => {
    Order.getUserOrders.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const req = { userId: 'user-1', query: {} };
    const res = mockRes();

    await OrderController.getUserOrders(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('Failed to fetch orders');
    expect(body.error).not.toMatch(/connection terminated/);
  });
});
