'use strict';
/**
 * tests/unit/adminFeatureSwitches.test.js
 *
 * L0.5b (#98): the admin panel only FLIPS switches: list, show, "Switch off"
 * and "Switch on", each with a required typed reason. No edit, new or delete
 * (messages are fixed in code). The action goes through
 * featureSwitches.setSwitch, which writes the admin_actions audit row.
 */
jest.mock('../../src/config/database');

const { buildResources } = require('../../src/adminPanel');
const { featureSwitches, MESSAGES } = require('../../src/services/featureSwitches');
const { attachSwitchDetails } = require('../../src/adminFeatureSwitches');

const fakeDb = { table: (tableName) => ({ tableName, properties: [] }) };
const entry = buildResources(fakeDb).find((r) => r.resource.tableName === 'feature_switches');
const ADMIN = { id: '55555555-5555-4555-8555-555555555555', email: 'founder@example.test', role: 'admin' };

function record(params) {
  const p = { ...params };
  return {
    param: (k) => p[k],
    set: jest.fn((k, v) => { p[k] = v; }),
    toJSON: () => ({ params: { ...p } }),
  };
}
const context = (rec) => ({ record: rec, currentAdmin: ADMIN, h: { resourceUrl: () => '/admin-panel/resources/feature_switches' } });

afterEach(() => { jest.restoreAllMocks(); delete process.env.FEATURE_CARD_PAYMENTS; });

describe('the feature_switches resource', () => {
  test('is registered, sorted by updated_at, with no generic new, edit or delete', () => {
    expect(entry).toBeDefined();
    expect(entry.options.sort).toEqual({ sortBy: 'updated_at', direction: 'desc' });
    for (const a of ['new', 'edit', 'delete', 'bulkDelete']) {
      expect(entry.options.actions[a]).toEqual({ isAccessible: false });
    }
  });

  test('"Switch off" is offered only for a switch that is on, and "Switch on" only for one that is off', () => {
    const { switchOff, switchOn } = entry.options.actions;
    expect(switchOff.isAccessible({ record: record({ enabled: true }) })).toBe(true);
    expect(switchOff.isAccessible({ record: record({ enabled: false }) })).toBe(false);
    expect(switchOn.isAccessible({ record: record({ enabled: false }) })).toBe(true);
    expect(switchOn.isAccessible({ record: record({ enabled: 'true' }) })).toBe(false);
  });

  test('opening the action (GET) changes nothing', async () => {
    const spy = jest.spyOn(featureSwitches, 'setSwitch');
    const out = await entry.options.actions.switchOff.handler({ method: 'get' }, {}, context(record({ key: 'card_payments', enabled: true })));
    expect(out.record.params.key).toBe('card_payments');
    expect(spy).not.toHaveBeenCalled();
  });

  test('a missing reason is refused and changes nothing', async () => {
    const spy = jest.spyOn(featureSwitches, 'setSwitch');
    const out = await entry.options.actions.switchOff.handler({ method: 'post', payload: { reason: '   ' } }, {}, context(record({ key: 'card_payments', enabled: true })));
    expect(out.notice).toEqual({ message: 'Type a reason before switching card_payments off.', type: 'error' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('with a reason, "Switch off" calls setSwitch(key, false, admin, reason) and confirms', async () => {
    const spy = jest.spyOn(featureSwitches, 'setSwitch').mockResolvedValue({ changed: true, key: 'cash_orders', previous: true, enabled: false });
    const rec = record({ key: 'cash_orders', enabled: true });
    const out = await entry.options.actions.switchOff.handler({ method: 'post', payload: { reason: 'Sunday test: card only' } }, {}, context(rec));
    expect(spy).toHaveBeenCalledWith('cash_orders', false, ADMIN.id, 'Sunday test: card only');
    expect(rec.set).toHaveBeenCalledWith('enabled', false);
    expect(out.notice).toEqual({ message: 'cash_orders switched off. It applies everywhere within 15 seconds.', type: 'success' });
    expect(out.redirectUrl).toBe('/admin-panel/resources/feature_switches');
  });

  test('"Switch on" warns when an env override still forces it off', async () => {
    process.env.FEATURE_CARD_PAYMENTS = 'off';
    jest.spyOn(featureSwitches, 'setSwitch').mockResolvedValue({ changed: true, key: 'card_payments', previous: false, enabled: true });
    const out = await entry.options.actions.switchOn.handler({ method: 'post', payload: { reason: 'incident over' } }, {}, context(record({ key: 'card_payments', enabled: false })));
    expect(out.notice.message).toMatch(/FEATURE_CARD_PAYMENTS=off is set in Render, so it stays off/);
  });

  test('a failure is shown as an error, not swallowed', async () => {
    jest.spyOn(featureSwitches, 'setSwitch').mockRejectedValue(new Error('database down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await entry.options.actions.switchOn.handler({ method: 'post', payload: { reason: 'x' } }, {}, context(record({ key: 'signups', enabled: false })));
    expect(out.notice).toEqual({ message: 'Could not switch signups on: database down', type: 'error' });
  });

  test('list and show add what customers see and whether it is really on (env override)', () => {
    process.env.FEATURE_CARD_PAYMENTS = 'off';
    const res = attachSwitchDetails({ records: [
      { params: { key: 'card_payments', enabled: true } },
      { params: { key: 'new_orders', enabled: false } },
    ] });
    expect(res.records[0].params).toMatchObject({ effective_now: 'off (forced by FEATURE_CARD_PAYMENTS=off in Render)', message_when_off: MESSAGES.card_payments });
    expect(res.records[1].params).toMatchObject({ effective_now: 'off', message_when_off: MESSAGES.new_orders });
  });
});
