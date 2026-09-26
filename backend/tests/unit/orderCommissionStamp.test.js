'use strict';
/**
 * tests/unit/orderCommissionStamp.test.js
 *
 * Phase 2b — stamping the commission onto the order at completion.
 *
 * The value this writes is what 2c will pay a real merchant against, and it is
 * frozen: a rate change must never retroactively alter what a store earned on
 * an order that already completed. So the properties worth testing are less
 * "does it compute 10%" (commissionService.test.js covers that) and more:
 *
 *   - it happens exactly once, and cannot be made to happen twice
 *   - it reaches the database at all -- the UPDATE uses an explicit column
 *     list, so a new key on the `updates` object is silently dropped unless
 *     the SQL names it
 *   - a failure to stamp never blocks a delivery from completing
 */

jest.mock('../../src/config/database');
jest.mock('../../src/models/DriverWallet', () => ({
  addPending: jest.fn(),
  releasePending: jest.fn(),
  reversePending: jest.fn(),
}));
jest.mock('../../src/models/Order', () => ({ restockItems: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({ notifyUserOrderUpdate: jest.fn() }));
jest.mock('../../src/services/commissionService', () => ({
  computeStoreCommission: jest.fn(),
}));

const pool = require('../../src/config/database');
const { computeStoreCommission } = require('../../src/services/commissionService');
const { updateOrderStatus } = require('../../src/services/orderStateMachineService');

const ORDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RATE_ID = 'cf490038-de34-4d75-85a9-99a8878d0bf0';

function deliveredOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    status: 'delivered',
    store_id: STORE_ID,
    subtotal: '279.00',
    delivery_fee: '90.00',
    driver_payout: '67.50',
    driver_id: null,
    payment_method: 'cash',
    payment_status: 'paid',
    store_commission: null,
    user_id: 'user-1',
    ...overrides,
  };
}

// updateOrderStatus with its own client: BEGIN, SELECT FOR UPDATE, [branch
// work], UPDATE, COMMIT. An externalClient is passed here so the test owns the
// sequence and can inspect every call.
function makeClient(orderRow) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM orders WHERE id/.test(sql)) return { rows: [orderRow] };
    if (/UPDATE orders/.test(sql)) return { rows: [{ ...orderRow, status: 'completed' }] };
    return { rows: [] };
  });
  return { query, calls, release: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  computeStoreCommission.mockResolvedValue({
    amount: 27.9, rate: 0.1, rateId: RATE_ID, scopeType: 'global',
  });
});

describe('commission is stamped when an order completes', () => {
  test('the UPDATE actually names the commission columns', async () => {
    // The regression this guards: the UPDATE is an explicit column list, not a
    // loop over `updates`. Setting updates.store_commission without adding the
    // column to the SQL drops it silently -- no error, no value, and the gap
    // would only surface at settlement time.
    const client = makeClient(deliveredOrder());
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    const update = client.calls.find((c) => /UPDATE orders/.test(c.sql));
    expect(update.sql).toMatch(/store_commission = COALESCE\(store_commission, \$\d\)/);
    expect(update.sql).toMatch(/commission_rate_applied = COALESCE\(commission_rate_applied, \$\d\)/);
    expect(update.sql).toMatch(/commission_rate_id = COALESCE\(commission_rate_id, \$\d\)/);
    expect(update.params).toEqual(expect.arrayContaining([27.9, 0.1, RATE_ID]));
  });

  test('COALESCE keeps the EXISTING value, so a stamp can never be overwritten', async () => {
    // Argument order matters: COALESCE(column, $n) means the stored value
    // wins. Reversed, a later pass would silently restate the commission.
    const client = makeClient(deliveredOrder());
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    const update = client.calls.find((c) => /UPDATE orders/.test(c.sql));
    expect(update.sql).not.toMatch(/COALESCE\(\$\d, store_commission\)/);
  });

  test('the rate is resolved inside the caller\'s transaction, not on the pool', async () => {
    const client = makeClient(deliveredOrder());
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(computeStoreCommission).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ storeId: STORE_ID, subtotal: '279.00' }),
    );
  });

  test('cash orders are stamped too — the arithmetic does not depend on how the customer paid', async () => {
    const client = makeClient(deliveredOrder({ payment_method: 'cash' }));
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(computeStoreCommission).toHaveBeenCalled();
    // Settling it is a different matter entirely -- Flash never receives cash
    // item value, the driver collects it. That is 2c's problem and is tracked
    // as OPEN_FOLLOWUPS #20.
  });
});

describe('it is stamped exactly once', () => {
  test('an already-stamped order is not restamped', async () => {
    const client = makeClient(deliveredOrder({ store_commission: '27.90' }));
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(computeStoreCommission).not.toHaveBeenCalled();
  });

  test('a repeat completed -> completed call returns early and stamps nothing', async () => {
    // The state machine short-circuits when current === target, before the
    // completion branch runs at all.
    const client = makeClient(deliveredOrder({ status: 'completed' }));
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(computeStoreCommission).not.toHaveBeenCalled();
    expect(client.calls.some((c) => /UPDATE orders/.test(c.sql))).toBe(false);
  });

  test('an order with no store is not stamped', async () => {
    // Pre-dates per-order store attribution; there is no store to owe.
    const client = makeClient(deliveredOrder({ store_id: null }));
    await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(computeStoreCommission).not.toHaveBeenCalled();
  });

  test('transitions other than completed never stamp', async () => {
    const client = makeClient(deliveredOrder({ status: 'in_transit' }));
    await updateOrderStatus(ORDER_ID, 'delivered', { externalClient: client });

    expect(computeStoreCommission).not.toHaveBeenCalled();
  });
});

describe('stamping never blocks a completion', () => {
  test('a thrown resolver still completes the order', async () => {
    // The goods are delivered and the order is real. An unstamped commission
    // is recoverable afterwards; a failed completion strands a live delivery.
    computeStoreCommission.mockRejectedValue(new Error('rate table unreachable'));
    const client = makeClient(deliveredOrder());

    const result = await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(result.status).toBe('completed');
    const update = client.calls.find((c) => /UPDATE orders/.test(c.sql));
    expect(update.params).toEqual(expect.arrayContaining([null]));
  });

  test('no configured rate completes the order with NULL commission', async () => {
    computeStoreCommission.mockResolvedValue(null);
    const client = makeClient(deliveredOrder());

    const result = await updateOrderStatus(ORDER_ID, 'completed', { externalClient: client });

    expect(result.status).toBe('completed');
    const update = client.calls.find((c) => /UPDATE orders/.test(c.sql));
    // Explicitly null rather than 0 -- zero would mean "Flash takes nothing"
    // and would settle the full item value to the store.
    expect(update.params).toEqual(expect.arrayContaining([null]));
  });
});
