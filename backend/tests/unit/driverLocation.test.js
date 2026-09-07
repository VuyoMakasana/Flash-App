'use strict';
/**
 * tests/unit/driverLocation.test.js
 *
 * Covers the production-readiness audit's §2.3 addition: a persistent
 * ETA (distance/estimatedMins) now travels on every `driver_location`
 * socket emit, not just at the four fixed milestone-toast thresholds —
 * and the milestone/cash-reminder logic itself (now refactored to take
 * an already-fetched order row instead of re-querying) still fires the
 * same as before.
 */

jest.mock('../../src/config/database');

const pool = require('../../src/config/database');
const Driver = require('../../src/models/Driver');

function makeIo() {
  return { to: jest.fn().mockReturnThis(), emit: jest.fn() };
}

describe('Driver.updateLocation — persistent ETA on driver_location', () => {
  beforeEach(() => jest.clearAllMocks());

  test('includes a non-null eta when the order is in_transit', async () => {
    const io = makeIo();
    pool.query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })       // ownership check
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE drivers
      .mockResolvedValueOnce({ rows: [{                    // order lookup
        user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6,
        is_cash_delivery: false, status: 'in_transit',
      }] });

    await Driver.updateLocation('driver-eta-1', -33.91, 25.61, 'order-eta-1', io);

    const call = io.emit.mock.calls.find((c) => c[0] === 'driver_location');
    expect(call).toBeDefined();
    expect(call[1].eta).not.toBeNull();
    expect(call[1].eta.estimatedMins).toBeGreaterThanOrEqual(1);
    expect(call[1].eta.distanceKm).toBeGreaterThan(0);
  });

  test('includes a non-null eta when the order is driver_arrived_store', async () => {
    const io = makeIo();
    pool.query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6,
        is_cash_delivery: false, status: 'driver_arrived_store',
      }] });

    await Driver.updateLocation('driver-eta-2', -33.91, 25.61, 'order-eta-2', io);

    const call = io.emit.mock.calls.find((c) => c[0] === 'driver_location');
    expect(call[1].eta).not.toBeNull();
  });

  test('eta is null for a status not eligible for it (e.g. driver_assigned)', async () => {
    const io = makeIo();
    pool.query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6,
        is_cash_delivery: false, status: 'driver_assigned',
      }] });

    await Driver.updateLocation('driver-eta-3', -33.91, 25.61, 'order-eta-3', io);

    const call = io.emit.mock.calls.find((c) => c[0] === 'driver_location');
    expect(call[1].eta).toBeNull();
  });

  test('a driver whose order the ownership check rejects gets no order-room emit', async () => {
    const io = makeIo();
    pool.query
      .mockResolvedValueOnce({ rows: [] })   // ownership check fails
      .mockResolvedValueOnce({ rows: [] });  // UPDATE drivers

    await Driver.updateLocation('driver-eta-4', -33.91, 25.61, 'not-my-order', io);

    expect(io.to).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('Driver.sendArrivalNotifications — milestone banners (regression)', () => {
  test('emits arrival_update when within the "arrived" threshold', async () => {
    const io = makeIo();
    const order = { user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6, is_cash_delivery: false, status: 'in_transit' };

    // Identical coordinates -> distance 0 -> deterministically the
    // "arrived" milestone, regardless of the exact haversine constants.
    await Driver.sendArrivalNotifications(order, 'order-1', -33.9, 25.6, io);

    const call = io.emit.mock.calls.find((c) => c[0] === 'arrival_update');
    expect(call).toBeDefined();
    expect(call[1].milestone).toBe('arrived');
  });

  test('also emits cash_reminder at the 5min milestone for a cash order', async () => {
    const io = makeIo();
    const order = { user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6, is_cash_delivery: true, status: 'in_transit' };

    // ~2.08km at the assumed 25km/h -> estimateMinutes rounds to 5.
    await Driver.sendArrivalNotifications(order, 'order-1', -33.9 + 0.0187, 25.6, io);

    const arrival = io.emit.mock.calls.find((c) => c[0] === 'arrival_update');
    expect(arrival).toBeDefined();
    expect(arrival[1].milestone).toBe('5min');

    const cash = io.emit.mock.calls.find((c) => c[0] === 'cash_reminder');
    expect(cash).toBeDefined();
  });

  test('emits nothing when the order status is not eligible (e.g. picked_up)', async () => {
    const io = makeIo();
    const order = { user_id: 'user-1', dropoff_lat: -33.9, dropoff_lng: 25.6, is_cash_delivery: false, status: 'picked_up' };

    await Driver.sendArrivalNotifications(order, 'order-1', -33.9, 25.6, io);

    expect(io.emit).not.toHaveBeenCalled();
  });
});
