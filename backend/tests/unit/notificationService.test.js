'use strict';
/**
 * tests/unit/notificationService.test.js
 *
 * Covers the production-readiness audit's §2.6 fix: a failed push
 * notification (transport-level, or one of Expo's own per-ticket errors
 * like an expired/uninstalled-app token) previously vanished silently --
 * now reported to Sentry with real context (order/recipient id,
 * notification type) via reportPushFailure. Deliberately not a retry
 * queue or dead-letter table -- see OPEN_FOLLOWUPS.md.
 */

jest.mock('../../src/config/database');
jest.mock('https');

const https = require('https');
const Sentry = require('@sentry/node');
const pool = require('../../src/config/database');
const {
  sendPushNotification,
  reportPushFailure,
  notifyUserOrderUpdate,
} = require('../../src/services/notificationService');

function mockHttpsResponse(statusPayload) {
  https.request.mockImplementation((options, callback) => {
    const res = {
      on: jest.fn((event, handler) => {
        if (event === 'data') handler(JSON.stringify(statusPayload));
        if (event === 'end') handler();
      }),
    };
    callback(res);
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  });
}

function mockHttpsTransportError(message) {
  https.request.mockImplementation(() => {
    const req = {
      on: jest.fn((event, handler) => {
        if (event === 'error') handler(new Error(message));
      }),
      write: jest.fn(),
      end: jest.fn(),
    };
    return req;
  });
}

describe('reportPushFailure', () => {
  let captureSpy;
  beforeEach(() => {
    captureSpy = jest.spyOn(Sentry, 'captureException').mockImplementation(() => {});
  });
  afterEach(() => captureSpy.mockRestore());

  test('reports a transport-level failure with the given context', () => {
    reportPushFailure(
      { sent: false, reason: 'transport_error', error: 'socket hang up' },
      { orderId: 'order-1', userId: 'user-1', notificationType: 'order_update' },
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [err, opts] = captureSpy.mock.calls[0];
    expect(err.message).toMatch(/transport failure/i);
    expect(opts.extra).toMatchObject({ orderId: 'order-1', userId: 'user-1', notificationType: 'order_update', error: 'socket hang up' });
  });

  test('does not report when there were simply no valid tokens', () => {
    reportPushFailure({ sent: false, reason: 'no_valid_tokens' }, { orderId: 'order-1' });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test('reports Expo per-ticket errors (e.g. expired token) even though the HTTP call itself succeeded', () => {
    reportPushFailure(
      { sent: true, response: { data: [{ status: 'error', message: '"ExponentPushToken[xxx]" is not a registered push notification recipient', details: { error: 'DeviceNotRegistered' } }] } },
      { orderId: 'order-2', notificationType: 'new_message' },
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [err, opts] = captureSpy.mock.calls[0];
    expect(err.message).toMatch(/ticket error/i);
    expect(opts.extra.errors).toHaveLength(1);
    expect(opts.extra.errors[0].details.error).toBe('DeviceNotRegistered');
  });

  test('does not report when the ticket succeeded', () => {
    reportPushFailure(
      { sent: true, response: { data: [{ status: 'ok', id: 'ticket-1' }] } },
      { orderId: 'order-3' },
    );
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test('does nothing when result is undefined (e.g. no_valid_tokens path never called sendPushNotification)', () => {
    reportPushFailure(undefined, { orderId: 'order-4' });
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe('sendPushNotification', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns sent:false, no_valid_tokens when there are no valid tokens', async () => {
    const result = await sendPushNotification({ tokens: ['garbage-token'], title: 't', body: 'b' });
    expect(result).toEqual({ sent: false, reason: 'no_valid_tokens' });
  });

  test('returns sent:false, transport_error on a network failure', async () => {
    mockHttpsTransportError('socket hang up');
    const result = await sendPushNotification({ tokens: 'ExponentPushToken[abc]', title: 't', body: 'b' });
    expect(result).toEqual({ sent: false, reason: 'transport_error', error: 'socket hang up' });
  });

  test('returns sent:true with the parsed response on success', async () => {
    mockHttpsResponse({ data: [{ status: 'ok', id: 'ticket-1' }] });
    const result = await sendPushNotification({ tokens: 'ExponentPushToken[abc]', title: 't', body: 'b' });
    expect(result.sent).toBe(true);
    expect(result.response.data[0].status).toBe('ok');
  });
});

describe('notifyUserOrderUpdate — wired to reportPushFailure', () => {
  let captureSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    captureSpy = jest.spyOn(Sentry, 'captureException').mockImplementation(() => {});
  });
  afterEach(() => captureSpy.mockRestore());

  test('reports to Sentry with orderId/userId/status when the push transport fails', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ push_token: 'ExponentPushToken[abc]' }] });
    mockHttpsTransportError('ECONNRESET');

    await notifyUserOrderUpdate('user-1', 'order-1', 'delivered');

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [, opts] = captureSpy.mock.calls[0];
    expect(opts.extra).toMatchObject({
      orderId: 'order-1', userId: 'user-1', status: 'delivered', notificationType: 'order_update',
    });
  });

  test('does not report to Sentry when the push succeeds cleanly', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ push_token: 'ExponentPushToken[abc]' }] });
    mockHttpsResponse({ data: [{ status: 'ok', id: 'ticket-1' }] });

    await notifyUserOrderUpdate('user-1', 'order-1', 'delivered');

    expect(captureSpy).not.toHaveBeenCalled();
  });
});
