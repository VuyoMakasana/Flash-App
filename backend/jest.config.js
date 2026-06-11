'use strict';

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
      branches:   50,
      functions:  60,
      lines:      60,
      statements: 60,
    },
  },
  setupFilesAfterFramework: [],
  testTimeout: 30000,
  forceExit: true,
  // Mock the database module in all unit tests by default
  moduleNameMapper: {
    '^../../src/config/database$': '<rootDir>/tests/__mocks__/database.js',
  },
};
