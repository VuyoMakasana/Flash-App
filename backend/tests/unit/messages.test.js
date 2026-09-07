'use strict';
/**
 * tests/unit/messages.test.js
 *
 * Covers the order-chat model: ownership authorization (pre-existing) and
 * the conversation-lifecycle cutoff added by the production-readiness
 * audit, §2.2 — sending is blocked once an order has been in a terminal
 * state (delivered/completed/cancelled) for longer than the grace window,
 * while reading history and the ownership/ordering checks are untouched.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/notificationService');

const pool = require('../../src/config/database');
const Message = require('../../src/models/Message');

const ORDER_ID  = 'order-1';
const USER_ID   = 'user-1';
const DRIVER_ID = 'driver-1';

const HOUR = 60 * 60 * 1000;

function orderRow(overrides = {}) {
  return {
    user_id:      USER_ID,
    driver_id:    DRIVER_ID,
    status:       'in_transit',
    delivered_at: null,
    updated_at:   new Date(),
    ...overrides,
  };
}

describe('Message.sendMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws Order not found when the order does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      Message.sendMessage(ORDER_ID, USER_ID, 'user', 'hi', null),
    ).rejects.toThrow('Order not found');
  });

  test('throws Access denied when the caller is not party to the order', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ user_id: 'someone-else' })] });

    await expect(
      Message.sendMessage(ORDER_ID, USER_ID, 'user', 'hi', null),
    ).rejects.toThrow('Access denied');
  });

  test('allows sending on an active (non-terminal) order regardless of age', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * HOUR);
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow({ status: 'in_transit', updated_at: thirtyDaysAgo })] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', order_id: ORDER_ID, sender_id: USER_ID, sender_role: 'user', content: 'hi' }] });

    const msg = await Message.sendMessage(ORDER_ID, USER_ID, 'user', 'hi', null);
    expect(msg.id).toBe('msg-1');
  });

  test('allows sending shortly after delivery, inside the grace window', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow({ status: 'delivered', delivered_at: twoHoursAgo })] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-2', order_id: ORDER_ID, sender_id: USER_ID, sender_role: 'user', content: 'thanks' }] });

    const msg = await Message.sendMessage(ORDER_ID, USER_ID, 'user', 'thanks', null);
    expect(msg.id).toBe('msg-2');
  });

  test('blocks sending once the grace window has passed since delivery', async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * HOUR);
    pool.query.mockResolvedValueOnce({
      rows: [orderRow({ status: 'delivered', delivered_at: twentyFiveHoursAgo })],
    });

    await expect(
      Message.sendMessage(ORDER_ID, USER_ID, 'user', 'hello?', null),
    ).rejects.toThrow('CONVERSATION_CLOSED');
  });

  test('blocks sending on a long-cancelled order (falls back to updated_at)', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * HOUR);
    pool.query.mockResolvedValueOnce({
      rows: [orderRow({ status: 'cancelled', delivered_at: null, updated_at: twoDaysAgo })],
    });

    await expect(
      Message.sendMessage(ORDER_ID, USER_ID, 'user', 'hello?', null),
    ).rejects.toThrow('CONVERSATION_CLOSED');
  });

  test('driver can still send on their own active order', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-3', order_id: ORDER_ID, sender_id: DRIVER_ID, sender_role: 'driver', content: 'on my way' }] });

    const msg = await Message.sendMessage(ORDER_ID, DRIVER_ID, 'driver', 'on my way', null);
    expect(msg.id).toBe('msg-3');
  });
});

describe('Message.getMessages', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns closed:false for an active order', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow({ status: 'in_transit' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await Message.getMessages(ORDER_ID, USER_ID, 'user');
    expect(result.closed).toBe(false);
    expect(result.messages).toEqual([]);
  });

  test('returns closed:true once the grace window has passed since delivery', async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * HOUR);
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow({ status: 'delivered', delivered_at: twentyFiveHoursAgo })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await Message.getMessages(ORDER_ID, USER_ID, 'user');
    expect(result.closed).toBe(true);
  });

  test('history stays readable even after closure (read is not gated)', async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * HOUR);
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow({ status: 'delivered', delivered_at: twentyFiveHoursAgo })] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-old', content: 'hi' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await Message.getMessages(ORDER_ID, USER_ID, 'user');
    expect(result.closed).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  test('still throws Access denied for a non-party caller (regression)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [orderRow({ user_id: 'someone-else' })] });

    await expect(
      Message.getMessages(ORDER_ID, USER_ID, 'user'),
    ).rejects.toThrow('Access denied');
  });
});
