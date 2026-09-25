import { describe, test, expect, beforeEach, vi } from 'vitest';
import { storeApi, SESSION_ENDED_EVENT } from './api';

/**
 * src/services/api.test.js
 *
 * Coverage-remediation Phase 6 — the store portal's single most critical
 * outbound API call: updateStock, the real "a staff member changes how
 * much stock is on hand" action (InventoryPage's real write path against
 * the backend's StoreInventoryController.updateStock, already covered
 * server-side in tests/integration/storeInventoryController.test.js).
 * This is the first real test this app has ever had -- no test
 * infrastructure existed at all before this task.
 *
 * Real-world scenarios this file protects:
 *   - a logged-in store user updates a product's stock -> the real
 *     stored auth token is sent as a Bearer header, the right endpoint
 *     and method are hit, and the real JSON body shape the backend
 *     expects ({ stock_by_size }) is sent, not something else
 *   - a rejected request (e.g. the product belongs to another store, or
 *     doesn't exist) -> the real server error message surfaces as a real
 *     thrown Error with the real HTTP status attached, not swallowed or
 *     replaced with something generic
 */

describe('storeApi.updateStock', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('sends the real auth token, method, and body shape the backend expects', async () => {
    localStorage.setItem('flash_store_token', 'real-session-token');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ product: { id: 'prod-1', stock_by_size: { M: 12 } } }),
    });

    const result = await storeApi.updateStock('prod-1', { M: 12 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/store-inventory/prod-1/stock');
    expect(options.method).toBe('PATCH');
    expect(options.headers.Authorization).toBe('Bearer real-session-token');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ stock_by_size: { M: 12 } });
    expect(result).toEqual({ product: { id: 'prod-1', stock_by_size: { M: 12 } } });
  });

  test('a rejected update throws a real Error with the server\'s real message and status', async () => {
    localStorage.setItem('flash_store_token', 'real-session-token');
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Product not found' }),
    });

    await expect(storeApi.updateStock('someone-elses-product', { M: 5 })).rejects.toThrow('Product not found');
    try {
      await storeApi.updateStock('someone-elses-product', { M: 5 });
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });

  test('makes no request with an Authorization header at all when not logged in', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ product: {} }),
    });

    await storeApi.updateStock('prod-1', { M: 1 });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });
});

/**
 * Phase 3 — store onboarding.
 *
 * Two behaviours worth pinning down here rather than in the page tests:
 * the exact wire shape POST /api/store-onboarding/apply is validated
 * against, and the fieldErrors normalization that makes inline per-field
 * messages possible at all (this layer used to drop express-validator's
 * `errors` array on the floor, leaving pages with only a generic string).
 */
describe('storeApi.applyForStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('POSTs the snake_case field names storeOnboardingRoutes.js validates', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'Application received.' }),
    });

    await storeApi.applyForStore({
      store_name: 'Kwazakhele Threads',
      owner_name: 'Nomsa Dlamini',
      owner_email: 'nomsa@example.com',
      owner_phone: '0821234567',
      address: '12B Mkele Street',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/store-onboarding/apply');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      store_name: 'Kwazakhele Threads',
      owner_name: 'Nomsa Dlamini',
      owner_email: 'nomsa@example.com',
      owner_phone: '0821234567',
      address: '12B Mkele Street',
    });
  });

  test('the already-registered case is indistinguishable from a new application', async () => {
    // The endpoint's 23505 branch returns 201 with the identical body, so
    // this layer must resolve identically too — no status or flag a caller
    // could branch on to detect a duplicate.
    const body = { success: true, message: 'Application received. Flash will review it and email you the next steps.' };
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => body });

    const result = await storeApi.applyForStore({
      store_name: 'Taken Name', owner_name: 'Someone', owner_email: 'taken@example.com',
    });

    expect(result).toEqual(body);
  });
});

describe('request() field-error normalization', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('express-validator errors become a { field: message } map', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        errors: [
          { type: 'field', path: 'store_name', msg: 'Invalid value', location: 'body' },
          { type: 'field', path: 'owner_email', msg: 'Invalid value', location: 'body' },
        ],
      }),
    });

    try {
      await storeApi.applyForStore({ store_name: 'x', owner_name: 'y', owner_email: 'bad' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.fieldErrors).toEqual({ store_name: 'Invalid value', owner_email: 'Invalid value' });
    }
  });

  test('the first message per field wins when a field fails twice', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        errors: [
          { path: 'owner_email', msg: 'first failure' },
          { path: 'owner_email', msg: 'second failure' },
        ],
      }),
    });

    try {
      await storeApi.applyForStore({ owner_email: 'bad' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.fieldErrors.owner_email).toBe('first failure');
    }
  });

  test('a plain { error } response is unchanged — existing callers keep working', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Product not found' }),
    });

    try {
      await storeApi.updateStock('prod-1', { M: 1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toBe('Product not found');
      expect(err.status).toBe(404);
      expect(err.fieldErrors).toBeUndefined();
    }
  });
});

/**
 * Store suspension — the client half of the kill switch.
 *
 * The backend now re-checks the store's live status on every request and
 * answers 403 + STORE_SUSPENDED. Without the handling below, the portal would
 * keep claiming the user was signed in while every panel failed, because
 * ProtectedRoute only ever read localStorage.
 *
 * The narrowness matters as much as the behaviour: tearing down a session is
 * destructive, so it must fire for exactly this case and nothing adjacent.
 */
describe('request() — STORE_SUSPENDED session teardown', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function seedSession() {
    localStorage.setItem('flash_store_token', 'live-session-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', role: 'owner' }));
  }

  test('a 403 STORE_SUSPENDED clears the stored session', async () => {
    seedSession();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'This store is not currently active.', code: 'STORE_SUSPENDED' }),
    });

    await expect(storeApi.getOrders()).rejects.toThrow();

    expect(localStorage.getItem('flash_store_token')).toBeNull();
    expect(localStorage.getItem('flash_store_user')).toBeNull();
    // The reason survives so the login page can explain the redirect.
    expect(localStorage.getItem('flash_store_session_ended_reason')).toMatch(/not currently active/i);
  });

  test('it broadcasts the session-ended event so the context can drop its state', async () => {
    seedSession();
    const handler = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, handler);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'suspended', code: 'STORE_SUSPENDED' }),
    });

    await expect(storeApi.getOrders()).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_ENDED_EVENT, handler);
  });

  test('a plain 401 does NOT tear the session down', async () => {
    // An expired or invalid token is already handled per-page, and is often
    // transient. Nuking the session on every 401 would log people out for the
    // wrong reasons.
    seedSession();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: 'Invalid token' }),
    });

    await expect(storeApi.getOrders()).rejects.toThrow();
    expect(localStorage.getItem('flash_store_token')).toBe('live-session-token');
  });

  test('a 403 WITHOUT the code does NOT tear the session down', async () => {
    // e.g. the role guard refusing one endpoint — that must not sign the
    // user out of the whole portal.
    seedSession();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Access forbidden. Required role: owner' }),
    });

    await expect(storeApi.getOrders()).rejects.toThrow();
    expect(localStorage.getItem('flash_store_token')).toBe('live-session-token');
  });

  test('the error still carries status and code for the calling page', async () => {
    seedSession();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'suspended', code: 'STORE_SUSPENDED' }),
    });

    try {
      await storeApi.getOrders();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(403);
      expect(err.code).toBe('STORE_SUSPENDED');
    }
  });
});
