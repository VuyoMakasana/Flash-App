'use strict';

/**
 * jest.config.js
 *
 * MEDIUM-10 FIX: Coverage thresholds raised to meaningful minimums.
 *   The previous config accepted 0% coverage — CI would pass even with zero
 *   tests. These thresholds match the audit recommendation (60% branches,
 *   70% lines) and reflect the current codebase's realistic starting point.
 *
 *   Note: setupFilesAfterFramework was a typo; corrected to setupFilesAfterFramework
 *   (which doesn't exist in Jest) — use globalSetup or setupFilesAfterFramework
 *   if needed. Removed the invalid key to prevent Jest warnings.
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
      branches:   60,
      functions:  70,
      lines:      70,
      statements: 70,
    },
  },
  testTimeout: 30000,
  forceExit: true,
};
