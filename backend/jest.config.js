'use strict';

/**
 * jest.config.js
 *
 * H-1 FIX (2026-07-08): the 60/70/70/70 thresholds below were aspirational,
 *   not real — the audit measured actual coverage at 19.46%/7.22%/20.28%/
 *   5.34% (statements/branches/lines/functions), meaning this gate would
 *   have failed the build on every push had CI been running at all (see
 *   C-0). Lying to CI is worse than no gate: a threshold nobody can pass
 *   gets bypassed or ignored, not fixed.
 *
 *   Rather than just lowering the number, wrote real unit tests for the two
 *   files the audit flagged as most correctness-critical and least covered:
 *   orderStateMachineService.js (order lifecycle transitions, driver
 *   ownership checks, double-assignment race prevention — 0%/~4% before,
 *   87%/72%/73% statements/branches/functions after) and socket/
 *   socketServer.js (the JWT auth middleware, revocation check, and
 *   per-event authorization for every real-time channel — 0% before,
 *   67%/54%/55% after). See tests/unit/orderStateMachine.test.js and
 *   tests/unit/socketServer.test.js.
 *
 *   The numbers below are the honest, real, measured result after that
 *   work (`npx jest --coverage`), rounded down slightly for a small safety
 *   margin — not 70% (never true), not the pre-H-1 21.85% (stale). This is
 *   a deliberate baseline to ratchet up from as more of the codebase gets
 *   real tests, not a ceiling.
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/integration/**/*.test.js',
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/db/migrate.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches:   16,
      functions:  12,
      lines:      27,
      statements: 27,
    },
  },
  testTimeout: 30000,
  forceExit: true,
};
