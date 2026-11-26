'use strict';

// L0.5b (#98): the admin panel's kill-switch screen.
//
// One row per switch (public.feature_switches). Admins can only LIST, SHOW,
// "Switch off" and "Switch on". There's no generic edit, new or delete: a
// generic form would allow changes with no reason and no audit row, and the
// customer messages are fixed in code (founder decision). Each switch action
// needs a typed reason (FeatureSwitchToggle.jsx) and goes through
// featureSwitches.setSwitch(), which updates the row and writes the
// admin_actions audit row (feature_switch_changed: key, old value, new value,
// reason, admin) in one transaction, plus a log line.

const { featureSwitches, MESSAGES, envVarName } = require('./services/featureSwitches');
const { withChronologicalDefaults, RESOURCE_TIMESTAMP_COLUMNS } = require('./config/adminResourceDefaults');

const isOn = (value) => value === true || value === 'true';

// The two virtual columns: what customers see, and whether the switch is
// actually on right now (an env "off" in Render overrides the panel).
function describe(params) {
  const key = params.key;
  const forced = featureSwitches.envOverrideOff(key);
  const effective = forced
    ? `off (forced by ${envVarName(key)}=off in Render)`
    : (isOn(params.enabled) ? 'on' : 'off');
  return { ...params, message_when_off: MESSAGES[key] || '', effective_now: effective };
}

function attachSwitchDetails(response) {
  if (response?.record?.params) response.record.params = describe(response.record.params);
  if (Array.isArray(response?.records)) {
    response.records.forEach((r) => { if (r.params) r.params = describe(r.params); });
  }
  return response;
}

function switchAction(enabled, component) {
  const verb = enabled ? 'on' : 'off';
  return {
    actionType: 'record',
    icon: enabled ? 'Play' : 'Pause',
    label: enabled ? 'Switch on' : 'Switch off',
    // A custom page with a required reason and its own confirm button. If the
    // component isn't registered (unit tests), AdminJS falls back to a plain
    // confirm, and the handler still refuses a missing reason.
    component: component || false,
    guard: component ? undefined : `Switch this ${verb}? You'll need to give a reason.`,
    isAccessible: ({ record }) => Boolean(record) && isOn(record.param('enabled')) !== enabled,
    handler: async (request, _response, context) => {
      const { record, currentAdmin } = context;
      if (request.method !== 'post') {
        return { record: record.toJSON(currentAdmin) };
      }
      const key = record.param('key');
      const reason = String(request.payload?.reason ?? '').trim();
      if (!reason) {
        return {
          record: record.toJSON(currentAdmin),
          notice: { message: `Type a reason before switching ${key} ${verb}.`, type: 'error' },
        };
      }
      try {
        const result = await featureSwitches.setSwitch(key, enabled, currentAdmin.id, reason);
        record.set('enabled', enabled);
        const forced = !enabled ? '' : (featureSwitches.envOverrideOff(key)
          ? ` Note: ${envVarName(key)}=off is set in Render, so it stays off until that's removed.`
          : '');
        return {
          record: record.toJSON(currentAdmin),
          redirectUrl: context.h.resourceUrl({ resourceId: 'feature_switches' }),
          notice: {
            message: result.changed
              ? `${key} switched ${verb}. It applies everywhere within 15 seconds.${forced}`
              : `${key} was already ${verb}; nothing changed.`,
            type: 'success',
          },
        };
      } catch (err) {
        console.error(`[FeatureSwitch] admin switch ${verb} for ${key} failed:`, err.message);
        return {
          record: record.toJSON(currentAdmin),
          notice: { message: `Could not switch ${key} ${verb}: ${err.message}`, type: 'error' },
        };
      }
    },
  };
}

function buildFeatureSwitchResource(db, components = {}) {
  return {
    resource: db.table('feature_switches'),
    options: withChronologicalDefaults({
      navigation: { name: 'Operations', icon: 'Settings' },
      listProperties: ['key', 'effective_now', 'updated_at', 'updated_by'],
      showProperties: ['key', 'effective_now', 'enabled', 'message_when_off', 'updated_at', 'updated_by'],
      properties: {
        key: { isTitle: true },
        effective_now: { type: 'string', isVisible: { list: true, show: true, edit: false, filter: false } },
        message_when_off: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
      },
      actions: {
        list: { after: [attachSwitchDetails] },
        show: { after: [attachSwitchDetails] },
        new: { isAccessible: false },
        edit: { isAccessible: false },
        delete: { isAccessible: false },
        bulkDelete: { isAccessible: false },
        switchOff: switchAction(false, components.FeatureSwitchToggle),
        switchOn: switchAction(true, components.FeatureSwitchToggle),
      },
    }, RESOURCE_TIMESTAMP_COLUMNS.feature_switches),
  };
}

module.exports = { buildFeatureSwitchResource, attachSwitchDetails };
