'use strict';
/**
 * tests/unit/phoneRedaction.test.js
 *
 * Section 2.7 audit follow-up — a block cuts off calling on an active
 * order immediately too, not just chat. There's no masked-calling layer
 * yet (deferred to the pre-launch checklist, §2.2), so this can't erase a
 * number the other party may have already noted down before blocking --
 * but the backend stops displaying/re-serving it once a block exists.
 * Covers Order.getByIdWithDetails, Order.getUserOrders (batched, not
 * per-row), and Driver.getActiveOrder.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/models/UserBlock');

const pool = require('../../src/config/database');
const UserBlock = require('../../src/models/UserBlock');
const Order = require('../../src/models/Order');
const Driver = require('../../src/models/Driver');

const USER_ID   = 'user-1';
const DRIVER_ID = 'driver-1';

describe('Order.getByIdWithDetails — phone redaction on block', () => {
  beforeEach(() => jest.clearAllMocks());

  test('nulls driver_phone when a block exists between the two parties', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', user_id: USER_ID, driver_id: DRIVER_ID, driver_phone: '0821234567' }],
    });
    UserBlock.isBlockedPair.mockResolvedValueOnce(true);

    const order = await Order.getByIdWithDetails('order-1');

    expect(order.driver_phone).toBeNull();
    expect(UserBlock.isBlockedPair).toHaveBeenCalledWith(USER_ID, DRIVER_ID);
  });

  test('leaves driver_phone intact when there is no block', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', user_id: USER_ID, driver_id: DRIVER_ID, driver_phone: '0821234567' }],
    });
    UserBlock.isBlockedPair.mockResolvedValueOnce(false);

    const order = await Order.getByIdWithDetails('order-1');

    expect(order.driver_phone).toBe('0821234567');
  });

  test('does not check for a block when no driver is assigned yet', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', user_id: USER_ID, driver_id: null, driver_phone: null }],
    });

    const order = await Order.getByIdWithDetails('order-1');

    expect(order.driver_phone).toBeNull();
    expect(UserBlock.isBlockedPair).not.toHaveBeenCalled();
  });
});

describe('Order.getUserOrders — batched phone redaction (no N+1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('redacts only the blocked driver across a page of orders, in one extra query', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'order-1', driver_id: 'driver-blocked', driver_phone: '0821111111' },
        { id: 'order-2', driver_id: 'driver-ok', driver_phone: '0822222222' },
        { id: 'order-3', driver_id: 'driver-blocked', driver_phone: '0821111111' },
      ],
    });
    UserBlock.getBlockedDriverIdsForUser.mockResolvedValueOnce(['driver-blocked']);

    const orders = await Order.getUserOrders(USER_ID);

    expect(orders[0].driver_phone).toBeNull();
    expect(orders[1].driver_phone).toBe('0822222222');
    expect(orders[2].driver_phone).toBeNull();
    // One query for the page, one for the blocked-id set -- never per row.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(UserBlock.getBlockedDriverIdsForUser).toHaveBeenCalledTimes(1);
  });

  test('skips the redaction pass entirely when there are no blocks', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', driver_id: 'driver-ok', driver_phone: '0822222222' }],
    });
    UserBlock.getBlockedDriverIdsForUser.mockResolvedValueOnce([]);

    const orders = await Order.getUserOrders(USER_ID);

    expect(orders[0].driver_phone).toBe('0822222222');
  });
});

describe('Driver.getActiveOrder — phone redaction on block', () => {
  beforeEach(() => jest.clearAllMocks());

  test('nulls customer_phone when a block exists', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', user_id: USER_ID, customer_phone: '0831234567' }],
    });
    UserBlock.isBlockedPair.mockResolvedValueOnce(true);

    const order = await Driver.getActiveOrder(DRIVER_ID);

    expect(order.customer_phone).toBeNull();
    expect(UserBlock.isBlockedPair).toHaveBeenCalledWith(DRIVER_ID, USER_ID);
  });

  test('leaves customer_phone intact when there is no block', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'order-1', user_id: USER_ID, customer_phone: '0831234567' }],
    });
    UserBlock.isBlockedPair.mockResolvedValueOnce(false);

    const order = await Driver.getActiveOrder(DRIVER_ID);

    expect(order.customer_phone).toBe('0831234567');
  });

  test('returns null cleanly when there is no active order at all', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const order = await Driver.getActiveOrder(DRIVER_ID);

    expect(order).toBeNull();
    expect(UserBlock.isBlockedPair).not.toHaveBeenCalled();
  });
});
