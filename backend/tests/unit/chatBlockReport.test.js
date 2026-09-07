'use strict';
/**
 * tests/unit/chatBlockReport.test.js
 *
 * Section 2.7 audit — chat block/report, the design deferred from §2.2.
 * Covers UserBlock/ChatReport models (both derive the "other party" from
 * the order server-side, never client-supplied — same IDOR-safe pattern
 * as Message.js) and MessageController.reportUser/blockUser.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const UserBlock = require('../../src/models/UserBlock');
const ChatReport = require('../../src/models/ChatReport');
const MessageController = require('../../src/controllers/messageController');

const ORDER_ID  = 'order-1';
const USER_ID   = 'user-1';
const DRIVER_ID = 'driver-1';

function orderRow(overrides = {}) {
  return { user_id: USER_ID, driver_id: DRIVER_ID, ...overrides };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('UserBlock.blockOtherPartyInOrder', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a customer blocking derives the driver as the blocked party', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await UserBlock.blockOtherPartyInOrder(ORDER_ID, USER_ID, 'user');

    expect(result).toEqual({ blockedId: DRIVER_ID, blockedRole: 'driver' });
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO user_blocks/);
    expect(insertCall[1]).toEqual([USER_ID, 'user', DRIVER_ID, 'driver']);
  });

  test('a driver blocking derives the customer as the blocked party', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await UserBlock.blockOtherPartyInOrder(ORDER_ID, DRIVER_ID, 'driver');

    expect(result).toEqual({ blockedId: USER_ID, blockedRole: 'user' });
  });

  test('throws Order not found when the order does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(UserBlock.blockOtherPartyInOrder(ORDER_ID, USER_ID, 'user')).rejects.toThrow('Order not found');
  });

  test('throws Access denied for a non-party caller', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ user_id: 'someone-else' })] });
    await expect(UserBlock.blockOtherPartyInOrder(ORDER_ID, USER_ID, 'user')).rejects.toThrow('Access denied');
  });

  test('throws when there is no other party yet (no driver assigned)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ driver_id: null })] });
    await expect(UserBlock.blockOtherPartyInOrder(ORDER_ID, USER_ID, 'user')).rejects.toThrow('No other party');
  });
});

describe('UserBlock.getBlockedDriverIdsForUser', () => {
  test('returns ids from both directions (user blocked driver, or driver blocked user)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'driver-a' }, { id: 'driver-b' }] });
    const ids = await UserBlock.getBlockedDriverIdsForUser(USER_ID);
    expect(ids).toEqual(['driver-a', 'driver-b']);
  });
});

describe('ChatReport.create', () => {
  beforeEach(() => jest.clearAllMocks());

  test('derives the reported party from the order, not the client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'report-1', created_at: new Date() }] });

    const report = await ChatReport.create(ORDER_ID, USER_ID, 'user', 'Threatening behavior');

    expect(report.id).toBe('report-1');
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1]).toEqual([ORDER_ID, USER_ID, 'user', DRIVER_ID, 'driver', null, 'Threatening behavior']);
  });

  test('validates a supplied messageId belongs to the order before attaching it', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] }) // message ownership check passes
      .mockResolvedValueOnce({ rows: [{ id: 'report-2', created_at: new Date() }] });

    await ChatReport.create(ORDER_ID, USER_ID, 'user', 'Spam', 'msg-1');

    const insertCall = pool.query.mock.calls[2];
    expect(insertCall[1][5]).toBe('msg-1');
  });

  test('silently drops a messageId that does not belong to the order', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [] }) // message ownership check fails
      .mockResolvedValueOnce({ rows: [{ id: 'report-3', created_at: new Date() }] });

    await ChatReport.create(ORDER_ID, USER_ID, 'user', 'Spam', 'msg-from-another-order');

    const insertCall = pool.query.mock.calls[2];
    expect(insertCall[1][5]).toBeNull();
  });

  test('throws Access denied for a non-party caller', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ driver_id: 'someone-else' })] });
    await expect(ChatReport.create(ORDER_ID, DRIVER_ID, 'driver', 'x')).rejects.toThrow('Access denied');
  });
});

describe('MessageController.reportUser / blockUser', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reportUser rejects an empty reason with 400', async () => {
    const req = { params: { orderId: ORDER_ID }, body: { reason: '  ' }, userId: USER_ID, userRole: 'user' };
    const res = mockRes();
    await MessageController.reportUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('reportUser succeeds and returns 201', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'report-1', created_at: new Date() }] });

    const req = { params: { orderId: ORDER_ID }, body: { reason: 'Spam' }, userId: USER_ID, userRole: 'user' };
    const res = mockRes();
    await MessageController.reportUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('blockUser succeeds and returns 201', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const req = { params: { orderId: ORDER_ID }, userId: USER_ID, userRole: 'user' };
    const res = mockRes();
    await MessageController.blockUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ blocked: true, blockedId: DRIVER_ID, blockedRole: 'driver' });
  });

  test('blockUser returns 403 for a non-party caller', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ user_id: 'someone-else' })] });
    const req = { params: { orderId: ORDER_ID }, userId: USER_ID, userRole: 'user' };
    const res = mockRes();
    await MessageController.blockUser(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
