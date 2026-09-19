'use strict';
/**
 * tests/unit/trustedDriverCommissionBlock.test.js
 *
 * Section 2.8 audit follow-up (driver cash-commission-debt mechanism) --
 * a commission-debt-blocked driver was already correctly unable to
 * accept new *orders* (driverController.acceptOrder's own
 * checkCommissionBlock gate), but nothing stopped them accepting a new
 * *trust* relationship while blocked. This isn't a security/financial
 * bypass on its own (order acceptance stays independently gated
 * regardless of trust status), but it left a customer under the
 * impression they have a "trusted" driver who currently can't fulfill
 * anything for them. Declining stays allowed regardless of debt.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/driverCommissionService');

const pool = require('../../src/config/database');
const { checkCommissionBlock } = require('../../src/services/driverCommissionService');
const TrustedDriver = require('../../src/models/TrustedDriver');

const REQUEST_ID = 'request-1';
const DRIVER_ID  = 'driver-1';

describe('TrustedDriver.respondToRequest — commission-debt gate on accept', () => {
  // resetAllMocks (not clearAllMocks) -- clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce implementations, which
  // would otherwise leak into a later test if a prior test's queued value
  // was never consumed (e.g. the 'decline' test below never calls
  // checkCommissionBlock at all).
  beforeEach(() => jest.resetAllMocks());

  test('rejects accepting a new trust request while commission-blocked', async () => {
    checkCommissionBlock.mockResolvedValueOnce({ blocked: true, debtAmount: 220, unpaidDeliveries: 11 });

    await expect(
      TrustedDriver.respondToRequest(REQUEST_ID, DRIVER_ID, 'accept', null),
    ).rejects.toThrow(/Outstanding commission debt/);

    // Never even attempts the status UPDATE once blocked.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('still allows declining a request while commission-blocked', async () => {
    // checkCommissionBlock is deliberately left unmocked here -- it must
    // never be consulted for 'decline' at all (asserted below); if that
    // ever regressed, the unmocked call would throw when reading
    // .blocked off its default undefined return, failing this test loudly.
    pool.query.mockResolvedValueOnce({
      rows: [{ id: REQUEST_ID, driver_id: DRIVER_ID, user_id: 'user-1', status: 'declined' }],
    });

    const result = await TrustedDriver.respondToRequest(REQUEST_ID, DRIVER_ID, 'decline', null);

    expect(result.status).toBe('declined');
    // checkCommissionBlock is only ever consulted for 'accept', not 'decline'.
    expect(checkCommissionBlock).not.toHaveBeenCalled();
  });

  test('accepts normally when the driver is not commission-blocked', async () => {
    checkCommissionBlock.mockResolvedValueOnce({ blocked: false, debtAmount: 0, unpaidDeliveries: 0 });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: REQUEST_ID, driver_id: DRIVER_ID, user_id: 'user-1', status: 'accepted' }],
    });

    const result = await TrustedDriver.respondToRequest(REQUEST_ID, DRIVER_ID, 'accept', null);

    expect(result.status).toBe('accepted');
  });

  test('still throws Request not found when the row does not exist (regression)', async () => {
    checkCommissionBlock.mockResolvedValueOnce({ blocked: false, debtAmount: 0, unpaidDeliveries: 0 });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      TrustedDriver.respondToRequest(REQUEST_ID, DRIVER_ID, 'accept', null),
    ).rejects.toThrow('Request not found');
  });
});
