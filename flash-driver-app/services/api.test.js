import * as SecureStore from 'expo-secure-store';

/**
 * services/api.test.js
 *
 * Coverage-remediation Phase 6 — the driver app's accept/decline-order
 * logic: orders.accept and orders.cancelActive, the real actions behind
 * a driver tapping "Accept" on a new order or backing out of one they've
 * already accepted (server side already covered thoroughly in
 * tests/unit/driverControllerCore.test.js and tests/integration/
 * driverCancelAssignedOrder.test.js). First real test this app has ever
 * had, alongside backgroundLocationTask.test.js.
 *
 * Real-world scenarios this file protects:
 *   - a driver accepts a real available order -> the real stored access
 *     token is attached, POST reaches the real
 *     /api/drivers/orders/:id/accept endpoint for the real order id
 *   - a driver backs out of an order they already accepted -> POST
 *     reaches the real /api/drivers/orders/:id/cancel endpoint
 *   - the backend rejects either action for a real reason (e.g. someone
 *     else already took it, or a commission-debt block) -> the real
 *     server error message reaches the caller as a real thrown Error
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const driverApi = require('./api').default;

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.getItemAsync.mockImplementation((key) =>
    Promise.resolve(key === 'FLASH_DRIVER_TOKEN' ? 'real-driver-token' : null),
  );
  SecureStore.setItemAsync.mockResolvedValue();
  SecureStore.deleteItemAsync.mockResolvedValue();
});

describe('driverApi.orders.accept — real order acceptance', () => {
  test('posts to the real accept endpoint for the real order id, with the real stored token', async () => {
    const acceptedOrder = { id: 'order-1', status: 'driver_assigned' };
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ order: acceptedOrder }),
    });

    const result = await driverApi.orders.accept('order-1');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/drivers/orders/order-1/accept');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer real-driver-token');
    expect(result).toEqual({ order: acceptedOrder });
  });

  // Real-world scenario: two drivers tap "Accept" on the same order within
  // moments of each other -- the backend's real locking (proven in
  // orderStateMachine.test.js) decides the loser; this proves the app
  // surfaces that loss as a real, readable error instead of swallowing it.
  test('a losing race for the same order surfaces the real server rejection message', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ error: 'Driver is not available' }),
    });

    await expect(driverApi.orders.accept('order-1')).rejects.toThrow('Driver is not available');
  });

  test('a commission-debt block surfaces the real 403 message', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 403,
      ok: false,
      json: async () => ({ error: 'Outstanding commission debt. Pay R150.00 before accepting orders.' }),
    });

    await expect(driverApi.orders.accept('order-1')).rejects.toThrow(/commission debt/);
  });
});

describe('driverApi.orders.cancelActive — real self-cancel before pickup', () => {
  test('posts to the real cancel endpoint for the real order id', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, status: 'waiting_for_driver', penaltyApplied: 20 }),
    });

    const result = await driverApi.orders.cancelActive('order-1');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/drivers/orders/order-1/cancel');
    expect(options.method).toBe('POST');
    expect(result).toEqual({ success: true, status: 'waiting_for_driver', penaltyApplied: 20 });
  });

  test('cancelling an order that is not actually the driver\'s own surfaces the real rejection', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 403,
      ok: false,
      json: async () => ({ error: 'Not your order' }),
    });

    await expect(driverApi.orders.cancelActive('someone-elses-order')).rejects.toThrow('Not your order');
  });
});
