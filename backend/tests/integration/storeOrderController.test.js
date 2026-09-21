'use strict';
/**
 * tests/integration/storeOrderController.test.js
 *
 * Coverage-remediation Phase 4 — StoreOrderController, the entire Store
 * Admin Portal orders backend (list, detail, accept/reject/mark-ready,
 * analytics). Zero test coverage existed before this file. Real,
 * unmocked integration suite against the isolated test DB: every handler
 * here derives store scope from req.storeId and reuses the real,
 * already-well-tested order-state-machine functions
 * (acceptOrder/rejectPendingAcceptance/markReadyForPickup), so what's
 * actually unproven -- and what a mocked pool can't prove -- is whether
 * the store-scoping itself genuinely isolates one store's data from
 * another's. That's the single most security-relevant property of this
 * whole subsystem, per the file's own header comment
 * ("a compromised Store A account should not even learn that a given
 * order id belongs to a real (just not their) store").
 *
 * Real-world scenarios this file protects:
 *   - a store's staff open their Orders screen and see exactly their
 *     store's orders, with real customer/driver names joined in -- never
 *     another store's
 *   - a store's staff accept/reject a real order awaiting their decision,
 *     and mark a real order ready for pickup once it's packed
 *   - a compromised or careless Store B account tries to view, accept,
 *     reject, or mark-ready an order that belongs to Store A -- every one
 *     of those must fail as a clean 404 (not 403 -- so Store B never even
 *     learns the order id was real), and must leave Store A's order
 *     completely untouched
 *   - a store's real analytics (order count, revenue, daily trend,
 *     popular items) are computed only from that store's own paid orders
 */

const db = require('../../src/config/database');
const StoreOrderController = require('../../src/controllers/storeOrderController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function mockReq({ storeId, storeUserId, params = {}, query = {} }) {
  return { storeId, storeUserId, params, query, app: { get: () => null } };
}

async function makeTestStore(tag) {
  const result = await db.query(
    `INSERT INTO stores (name) VALUES ($1) RETURNING id`,
    [`Store Order Test Store (${tag}) ${Date.now()}`],
  );
  return result.rows[0].id;
}

async function makeTestStoreUser(tag, storeId, role = 'owner') {
  const email = `store-order-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO store_users (store_id, name, email, password_hash, role) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
    [storeId, `Store Order Test User (${tag})`, email, role],
  );
  return result.rows[0].id;
}

async function makeTestUser(tag) {
  const email = `store-order-test-customer-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Store Order Test Customer (${tag})`, email],
  );
  return result.rows[0].id;
}

async function makeTestOrder({ storeId, userId, status = 'pending_store_acceptance', paymentMethod = 'cash', paymentStatus = 'paid', total = 190 }) {
  const orderNumber = `STOREORDER-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await db.query(
    `INSERT INTO orders (order_number, user_id, store_id, status, payment_method, payment_status, subtotal, delivery_fee, total)
     VALUES ($1, $2, $3, $4, $5, $6, 100, 90, $7) RETURNING id`,
    [orderNumber, userId, storeId, status, paymentMethod, paymentStatus, total],
  );
  return result.rows[0].id;
}

async function cleanup({ orderIds = [], userIds = [], storeUserIds = [], storeIds = [] }) {
  for (const orderId of orderIds) {
    if (orderId) {
      await db.query('DELETE FROM order_cancellations WHERE order_id = $1', [orderId]);
      await db.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
    }
  }
  await db.query('DELETE FROM store_actions WHERE store_user_id = ANY($1::uuid[])', [storeUserIds.filter(Boolean)]);
  for (const orderId of orderIds) {
    if (orderId) await db.query('DELETE FROM orders WHERE id = $1', [orderId]);
  }
  for (const userId of userIds) {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  for (const storeUserId of storeUserIds) {
    if (storeUserId) await db.query('DELETE FROM store_users WHERE id = $1', [storeUserId]);
  }
  for (const storeId of storeIds) {
    if (storeId) await db.query('DELETE FROM stores WHERE id = $1', [storeId]);
  }
}

describe('StoreOrderController (integration, real DB)', () => {
  let storeA, storeB, storeUserA, storeUserB;

  beforeAll(async () => {
    storeA = await makeTestStore('A');
    storeB = await makeTestStore('B');
    storeUserA = await makeTestStoreUser('A', storeA);
    storeUserB = await makeTestStoreUser('B', storeB);
  });

  afterAll(async () => {
    await cleanup({ storeUserIds: [storeUserA, storeUserB], storeIds: [storeA, storeB] });
    await db.end();
  });

  describe('listOrders — store-scoped listing', () => {
    test('a store only ever sees its own orders, never another store\'s', async () => {
      const customerA = await makeTestUser('list-a');
      const customerB = await makeTestUser('list-b');
      const orderA = await makeTestOrder({ storeId: storeA, userId: customerA });
      const orderB = await makeTestOrder({ storeId: storeB, userId: customerB });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, query: {} });
        const res = mockRes();
        await StoreOrderController.listOrders(req, res);

        const body = res.json.mock.calls[0][0];
        const ids = body.orders.map((o) => o.id);
        expect(ids).toContain(orderA);
        expect(ids).not.toContain(orderB);
      } finally {
        await cleanup({ orderIds: [orderA, orderB], userIds: [customerA, customerB] });
      }
    });

    test('filters by status when given', async () => {
      const customer = await makeTestUser('list-status');
      const pendingOrder = await makeTestOrder({ storeId: storeA, userId: customer, status: 'pending_store_acceptance' });
      const preparingOrder = await makeTestOrder({ storeId: storeA, userId: customer, status: 'preparing' });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, query: { status: 'preparing' } });
        const res = mockRes();
        await StoreOrderController.listOrders(req, res);

        const ids = res.json.mock.calls[0][0].orders.map((o) => o.id);
        expect(ids).toContain(preparingOrder);
        expect(ids).not.toContain(pendingOrder);
      } finally {
        await cleanup({ orderIds: [pendingOrder, preparingOrder], userIds: [customer] });
      }
    });
  });

  describe('getOrder — store-scoped detail, with real joined items', () => {
    test('returns a real order\'s detail, including its real items, for the owning store', async () => {
      const customer = await makeTestUser('detail');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer });
      await db.query(
        `INSERT INTO order_items (order_id, product_id, product_name, size, quantity, unit_price, total_price)
         VALUES ($1, 'prod-1', 'Test Product', 'M', 2, 50, 100)`,
        [orderId],
      );

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.getOrder(req, res);

        const body = res.json.mock.calls[0][0];
        expect(body.order.id).toBe(orderId);
        expect(body.order.customer_name).toBeTruthy();
        expect(body.order.items).toHaveLength(1);
        expect(body.order.items[0].product_name).toBe('Test Product');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    // The key isolation test: Store B's own staff account, looking at a
    // real order id that belongs to Store A.
    test('a cross-store detail request returns 404, not the other store\'s real data', async () => {
      const customer = await makeTestUser('detail-cross');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer });

      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.getOrder(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Order not found' });
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    test('returns 404 for an order id that does not exist at all', async () => {
      const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId: '00000000-0000-0000-0000-000000000000' } });
      const res = mockRes();
      await StoreOrderController.getOrder(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('accept — real state-machine action + audit log', () => {
    test('a real order awaiting acceptance is accepted and moves to preparing', async () => {
      const customer = await makeTestUser('accept');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'pending_store_acceptance' });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.accept(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Order accepted — now preparing.' }));

        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('preparing');

        const action = await db.query(
          `SELECT action_type FROM store_actions WHERE store_user_id = $1 AND target_id = $2`,
          [storeUserA, orderId],
        );
        expect(action.rows).toHaveLength(1);
        expect(action.rows[0].action_type).toBe('order_accept');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    // Isolation, on the write side this time: Store B tries to accept an
    // order that is really Store A's.
    test('a cross-store accept attempt is rejected and the real order is left untouched', async () => {
      const customer = await makeTestUser('accept-cross');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'pending_store_acceptance' });

      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.accept(req, res);

        expect(res.status).toHaveBeenCalledWith(404);

        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('pending_store_acceptance'); // untouched
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    // Deliberately a terminal 'cancelled' order, not 'preparing': accept()
    // targets 'preparing' internally, and updateOrderStatus treats a
    // same-state request as an idempotent no-op success (already tested,
    // already correct, in orderStateMachine.test.js) rather than an
    // illegal transition -- an order already at 'preparing' would not
    // actually exercise this rejection path. 'cancelled' has no allowed
    // transitions out of it at all (ALLOWED_TRANSITIONS.cancelled = []),
    // so this is a genuinely illegal transition.
    test('accepting an already-cancelled order is a clean 400, not a silent no-op success', async () => {
      const customer = await makeTestUser('accept-illegal');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'cancelled' });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.accept(req, res);

        expect(res.status).toHaveBeenCalledWith(400);

        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('cancelled'); // untouched
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });
  });

  describe('reject — real cancellation, cash order (no external refund call)', () => {
    test('a real order awaiting acceptance is rejected and cancelled', async () => {
      const customer = await makeTestUser('reject');
      // Cash, not card+paid, so rejectPendingAcceptance's real refund
      // branch is never reached -- no real external Paystack call from
      // this test, matching order.payment_method === 'card' &&
      // payment_status === 'paid' being the only gate that triggers it.
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'pending_store_acceptance', paymentMethod: 'cash' });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.reject(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Order rejected — customer refunded in full.' }));

        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('cancelled');

        const cancellation = await db.query('SELECT cancelled_by_role, reason FROM order_cancellations WHERE order_id = $1', [orderId]);
        expect(cancellation.rows).toHaveLength(1);
        expect(cancellation.rows[0].cancelled_by_role).toBe('store');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    test('a cross-store reject attempt is rejected and the real order is left untouched', async () => {
      const customer = await makeTestUser('reject-cross');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'pending_store_acceptance', paymentMethod: 'cash' });

      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.reject(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('pending_store_acceptance');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });
  });

  describe('markReady — real handoff to driver matching', () => {
    test('a real order being prepared is marked ready and moves to waiting_for_driver', async () => {
      const customer = await makeTestUser('markready');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'preparing' });

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.markReady(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Order marked ready — driver matching started.' }));
        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('waiting_for_driver');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });

    test('a cross-store mark-ready attempt is rejected and the real order is left untouched', async () => {
      const customer = await makeTestUser('markready-cross');
      const orderId = await makeTestOrder({ storeId: storeA, userId: customer, status: 'preparing' });

      try {
        const req = mockReq({ storeId: storeB, storeUserId: storeUserB, params: { orderId } });
        const res = mockRes();
        await StoreOrderController.markReady(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        expect(order.rows[0].status).toBe('preparing');
      } finally {
        await cleanup({ orderIds: [orderId], userIds: [customer] });
      }
    });
  });

  describe('getAnalytics — real, store-scoped aggregates', () => {
    test('summary/daily/popular items are computed only from this store\'s own paid orders', async () => {
      const customerA = await makeTestUser('analytics-a');
      const customerB = await makeTestUser('analytics-b');
      const orderA = await makeTestOrder({ storeId: storeA, userId: customerA, status: 'completed', paymentStatus: 'paid', total: 200 });
      const orderB = await makeTestOrder({ storeId: storeB, userId: customerB, status: 'completed', paymentStatus: 'paid', total: 9999 });
      await db.query(
        `INSERT INTO order_items (order_id, product_id, product_name, size, quantity, unit_price, total_price)
         VALUES ($1, 'prod-1', 'Analytics Test Product', 'M', 3, 50, 150)`,
        [orderA],
      );

      try {
        const req = mockReq({ storeId: storeA, storeUserId: storeUserA, query: { days: '30' } });
        const res = mockRes();
        await StoreOrderController.getAnalytics(req, res);

        const body = res.json.mock.calls[0][0];
        expect(body.summary.orderCount).toBeGreaterThanOrEqual(1);
        expect(body.summary.revenue).toBeGreaterThanOrEqual(200);
        // Store B's much larger order must never leak into Store A's revenue.
        expect(body.summary.revenue).toBeLessThan(9999);
        expect(body.popularItems.some((p) => p.productName === 'Analytics Test Product')).toBe(true);
      } finally {
        await cleanup({ orderIds: [orderA, orderB], userIds: [customerA, customerB] });
      }
    });
  });
});
