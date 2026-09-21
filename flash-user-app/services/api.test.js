import * as SecureStore from 'expo-secure-store';

/**
 * services/api.test.js
 *
 * Coverage-remediation Phase 6 — the user app's single most critical
 * outbound API call: orders.create, "place an order" (server side already
 * covered thoroughly in tests/integration/orderCreation.test.js, including
 * the real concurrency test a mocked pool can't give you). This is the
 * first real test this app has ever had -- no test infrastructure existed
 * at all before this task.
 *
 * Exercises the shared request() wrapper through orders.create
 * specifically, since that's this app's single highest-stakes call: real
 * money, a real stock decrement, and the one action every other screen in
 * the checkout flow exists to lead up to. request() is not separately
 * exported, so this is deliberately tested through the real public call a
 * screen would actually make, not a reimplementation of its internals.
 *
 * Real-world scenarios this file protects:
 *   - a logged-in customer places a real order -> the real stored access
 *     token is attached as a Bearer header, POST reaches the real
 *     /api/orders endpoint with the real JSON body
 *   - the access token has expired (a real 401) -> the app transparently
 *     refreshes it using the real stored refresh token and retries the
 *     SAME request once with the new token, rather than surfacing a
 *     confusing failure to a customer who is mid-checkout
 *   - the refresh token itself is also invalid/expired -> the session is
 *     cleared and the registered session-expired handler fires, rather
 *     than silently retrying forever or leaving a half-broken session
 *   - the backend rejects the order for a real reason (e.g. out of stock)
 *     -> the real server error message reaches the caller as a real
 *     thrown Error, not swallowed or replaced with something generic
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const api = require('./api').default;
const { setSessionExpiredHandler } = require('./api');

const SAMPLE_ORDER_DATA = {
  items: [{ productId: 'prod-1', name: 'Test Shirt', size: 'M', quantity: 1, price: 199.99 }],
  delivery_mode: 'standard',
  time_slot: 'ASAP',
  subtotal: 199.99,
  delivery_fee: 90,
  total: 289.99,
  pickup_address: 'Store Address',
  dropoff_address: '123 Test Street',
  preferred_driver_id: null,
  store_id: 'store-1',
  pickup_lat: -33.884,
  pickup_lng: 25.585,
  dropoff_lat: -33.886,
  dropoff_lng: 25.587,
};

function mockFetchOnce(response) {
  global.fetch = jest.fn().mockResolvedValueOnce(response);
}

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.getItemAsync.mockResolvedValue(null);
  SecureStore.setItemAsync.mockResolvedValue();
  SecureStore.deleteItemAsync.mockResolvedValue();
});

describe('api.orders.create — real order placement', () => {
  test('attaches the real stored access token and posts the real order shape to /api/orders', async () => {
    SecureStore.getItemAsync.mockImplementation((key) =>
      Promise.resolve(key === 'FLASH_TOKEN' ? 'real-access-token' : null),
    );
    const fakeOrder = { id: 'order-1', order_number: 'FLASH-ABC123' };
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ order: fakeOrder, orderNumber: 'FLASH-ABC123' }),
    });

    const result = await api.orders.create(SAMPLE_ORDER_DATA);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/orders');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer real-access-token');
    expect(JSON.parse(options.body)).toEqual(SAMPLE_ORDER_DATA);
    expect(result).toEqual({ order: fakeOrder, orderNumber: 'FLASH-ABC123' });
  });

  test('a real business-rule rejection (e.g. out of stock) throws a real Error with the server\'s real message', async () => {
    mockFetchOnce({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ error: 'Test Shirt size M is out of stock' }),
      json: async () => ({ error: 'Test Shirt size M is out of stock' }),
    });

    await expect(api.orders.create(SAMPLE_ORDER_DATA)).rejects.toThrow('Test Shirt size M is out of stock');
  });

  test('a 401 with a valid refresh token transparently refreshes and retries the same order once', async () => {
    SecureStore.getItemAsync.mockImplementation((key) => {
      if (key === 'FLASH_TOKEN') return Promise.resolve('expired-access-token');
      if (key === 'FLASH_REFRESH_TOKEN') return Promise.resolve('real-refresh-token');
      return Promise.resolve(null);
    });

    const fakeOrder = { id: 'order-1', order_number: 'FLASH-RETRY' };
    global.fetch = jest
      .fn()
      // 1. Original request -> 401 (expired token)
      .mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({ error: 'Token expired' }) })
      // 2. Refresh call -> succeeds with a new token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-access-token', refreshToken: 'new-refresh-token' }) })
      // 3. Retried original request, now with the new token -> succeeds
      .mockResolvedValueOnce({ ok: true, json: async () => ({ order: fakeOrder }) });

    const result = await api.orders.create(SAMPLE_ORDER_DATA);

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const retryCall = global.fetch.mock.calls[2];
    expect(retryCall[0]).toBe('http://localhost:3000/api/orders');
    expect(retryCall[1].headers.Authorization).toBe('Bearer new-access-token');
    expect(JSON.parse(retryCall[1].body)).toEqual(SAMPLE_ORDER_DATA); // same real order data, not lost on retry
    expect(result).toEqual({ order: fakeOrder });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('FLASH_TOKEN', 'new-access-token');
  });

  test('a 401 with no working refresh token clears the session and notifies the app to log out', async () => {
    SecureStore.getItemAsync.mockImplementation((key) => {
      if (key === 'FLASH_TOKEN') return Promise.resolve('expired-access-token');
      if (key === 'FLASH_REFRESH_TOKEN') return Promise.resolve('stale-refresh-token');
      return Promise.resolve(null);
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({ error: 'Token expired' }) })
      .mockResolvedValueOnce({ ok: false, status: 401 }); // refresh itself also rejected

    const sessionExpiredHandler = jest.fn();
    setSessionExpiredHandler(sessionExpiredHandler);

    await expect(api.orders.create(SAMPLE_ORDER_DATA)).rejects.toThrow('SESSION_EXPIRED');

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('FLASH_TOKEN');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('FLASH_REFRESH_TOKEN');
    expect(sessionExpiredHandler).toHaveBeenCalled();
  });
});
