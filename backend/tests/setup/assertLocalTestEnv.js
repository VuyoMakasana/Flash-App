'use strict';

// L0.1 (#69): the one rule every test run must pass before anything else
// happens: tests only ever talk to a LOCAL database and only ever hold
// Paystack TEST keys. Pure function over an env object, so it is unit-tested
// directly (tests/unit/testEnvGuard.test.js) and enforced for every run by
// tests/setup/testEnv.js (jest `setupFiles`).
//
// Error messages name the offending HOST only, never the full URL, password
// or key (WORKFLOW.md §1: never print secrets).

const { isKnownProductionDatabaseUrl } = require('../../src/config/env');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLocalTestEnv(env) {
  const url = env.DATABASE_URL;
  if (url) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch (_) {
      throw new Error('[test-env] REFUSING TO RUN: DATABASE_URL could not be parsed, so it cannot be proven local.');
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `[test-env] REFUSING TO RUN: DATABASE_URL host "${host}" is not a local database. ` +
        'Tests may only use localhost / 127.0.0.1 / ::1 (see docs/TESTING.md).',
      );
    }
    if (isKnownProductionDatabaseUrl(url)) {
      throw new Error('[test-env] REFUSING TO RUN: DATABASE_URL matches a known production database marker.');
    }
  }

  for (const key of ['PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY']) {
    const value = env[key];
    if (value && /^(sk|pk)_live_/.test(value)) {
      throw new Error(`[test-env] REFUSING TO RUN: ${key} is a live Paystack key. Tests use Paystack TEST keys only.`);
    }
  }
}

module.exports = { assertLocalTestEnv, LOCAL_HOSTS };
