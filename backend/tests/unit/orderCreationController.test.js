'use strict';
/**
 * tests/unit/orderCreationController.test.js
 *
 * Coverage-remediation Phase 1 — OrderController.createOrder, the HTTP
 * layer in front of Order.create (real end-to-end model coverage, including
 * a real concurrency test, lives in tests/integration/orderCreation.test.js;
 * this file is specifically about the controller's own request-shape
 * validation and its error->status-code mapping, which doesn't need a real
 * database).
 *
 * Real-world scenarios this file protects:
 *   - a client sends a checkout request with no items at all (empty cart,
 *     or a buggy client) -> must be rejected before ever touching the DB
 *   - a client sends a dropoff point outside Nelson Mandela Bay (Flash's
 *     only service area) -> must be rejected before ever touching the DB
 *   - Order.create rejects the order for a real business reason (out of
 *     stock, bad price, bad quantity) -> the customer must see a clean 400
 *     with the real reason, not a generic server error
 *   - Order.create fails for an unexpected reason (DB down, a real bug) ->
 *     the customer must see a generic 500 with NO internal detail leaked,
 *     and the server log gets the real error
 *   - preferred_driver_id (from an admin/backend caller) takes priority
 *     over requested_driver_id (from the user app) when a request somehow
 *     sends both
 */

jest.mock('../../src/models/Order');
jest.mock('../../src/models/Store');

const Order = require('../../src/models/Order');
const Store = require('../../src/models/Store');
const OrderController = require('../../src/controllers/orderController');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

// A dropoff point well inside the real NMB bounding box
// (backend/src/utils/geoBoundary.js) -- Order.create is mocked in this
// file, so what matters is only that this passes the controller's own
// isWithinNelsonMandelaBay gate.
const VALID_DROPOFF = { dropoff_lat: -33.8860, dropoff_lng: 25.5870 };

function validBody(overrides = {}) {
  return {
    items: [{ productId: 'prod-1', size: 'M', quantity: 1, price: 100 }],
    delivery_mode: 'standard',
    subtotal: 100,
    ...VALID_DROPOFF,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Store.getDefaultStoreId.mockResolvedValue('store-1');
});

describe('OrderController.createOrder — request validation (no DB touched)', () => {
  test('rejects a request with no items at all', async () => {
    const req = { body: validBody({ items: [] }), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Order must have items' });
    expect(Order.create).not.toHaveBeenCalled();
  });

  test('rejects a request with items missing entirely from the body', async () => {
    const req = { body: validBody({ items: undefined }), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Order.create).not.toHaveBeenCalled();
  });

  test('rejects a dropoff point outside Nelson Mandela Bay', async () => {
    // Johannesburg -- nowhere near NMB, but still a "plausible" real-world
    // coordinate a buggy client-side GPS/geocoder could actually produce.
    const req = { body: validBody({ dropoff_lat: -26.2041, dropoff_lng: 28.0473 }), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/outside our service area/i);
    expect(Order.create).not.toHaveBeenCalled();
  });

  test('rejects when dropoff coordinates are missing entirely', async () => {
    const req = { body: validBody({ dropoff_lat: undefined, dropoff_lng: undefined }), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Order.create).not.toHaveBeenCalled();
  });
});

describe('OrderController.createOrder — success path', () => {
  test('creates the order with a real, server-resolved store_id and returns 201', async () => {
    const fakeOrder = { id: 'order-1', order_number: 'FLASH-ABC123', store_id: 'store-1' };
    Order.create.mockResolvedValue(fakeOrder);

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(Store.getDefaultStoreId).toHaveBeenCalled();
    expect(Order.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', store_id: 'store-1' }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ order: fakeOrder, orderNumber: 'FLASH-ABC123' });
  });

  test('preferred_driver_id wins over requested_driver_id when a request somehow sends both', async () => {
    Order.create.mockResolvedValue({ id: 'order-1', order_number: 'FLASH-X' });

    const req = {
      body: validBody({ preferred_driver_id: 'driver-admin', requested_driver_id: 'driver-user' }),
      userId: 'user-1',
    };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(Order.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_driver_id: 'driver-admin' }),
    );
  });

  test('falls back to requested_driver_id when no preferred_driver_id is given', async () => {
    Order.create.mockResolvedValue({ id: 'order-1', order_number: 'FLASH-X' });

    const req = { body: validBody({ requested_driver_id: 'driver-user' }), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(Order.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_driver_id: 'driver-user' }),
    );
  });
});

describe('OrderController.createOrder — Order.create failure -> status mapping', () => {
  test('a known business-rule rejection (out of stock) becomes a clean 400 with the real reason', async () => {
    Order.create.mockRejectedValue(new Error('Product X size M is out of stock'));

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Product X size M is out of stock' });
  });

  test('a known business-rule rejection (invalid price) becomes a clean 400', async () => {
    Order.create.mockRejectedValue(new Error('Invalid price for "External Item": price must be greater than zero (received 0)'));

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('a known business-rule rejection (invalid quantity) becomes a clean 400', async () => {
    Order.create.mockRejectedValue(new Error('Invalid quantity for "Item": must be a positive integer'));

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  // Was a bug (Phase 1, found and fixed 2026-09-21 -- see the BUG FIX
  // comment on Order.js's EXTERNAL STORE PATH branch and the matching
  // live-DB test in tests/integration/orderCreation.test.js): an item with
  // no productId at all used to reach an unhandled Postgres NOT NULL
  // constraint error, which fell through CLIENT_ERROR_FRAGMENTS and
  // surfaced as a generic 500. Order.create now rejects this itself with a
  // clean validation message before it ever reaches the database, and
  // 'a productId is required' is in CLIENT_ERROR_FRAGMENTS -- this is now
  // exactly the same 400-mapping path as every other business-rule
  // rejection below, not a special case.
  test('a productId-less item rejection becomes a clean 400, same as any other validation failure', async () => {
    Order.create.mockRejectedValue(
      new Error('Invalid item for "External Item": a productId is required (no external/partner item catalogue exists)'),
    );

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/a productId is required/);
  });

  test('a genuinely unexpected error (e.g. DB connection lost) becomes a generic 500 with no internal detail leaked', async () => {
    Order.create.mockRejectedValue(new Error('Connection terminated unexpectedly'));

    const req = { body: validBody(), userId: 'user-1' };
    const res = mockRes();

    await OrderController.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.error).toBe('Failed to create order');
    expect(responseBody.error).not.toMatch(/Connection terminated/);
  });
});
