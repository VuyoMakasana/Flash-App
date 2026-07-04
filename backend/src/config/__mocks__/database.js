'use strict';
// src/config/__mocks__/database.js
//
// Jest manual mock for the pg Pool. Jest's manual-mock convention requires
// this file to live in a __mocks__ directory ADJACENT to the real module
// (src/config/database.js) for jest.mock('.../config/database') to pick it
// up automatically with no factory argument. The mock previously lived at
// tests/__mocks__/database.js, which Jest does not treat as adjacent to the
// real module — so jest.mock() fell back to auto-mocking the real module,
// which requires it first (running its module-level `pool.query("SELECT 1")`
// startup check) and then failed to stub the live pg Pool instance's methods,
// so every unit test touching a model still hit a real, absent Postgres and
// failed with ECONNREFUSED.

const mockPool = {
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn().mockResolvedValue({
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }),
  on:      jest.fn(),
  end:     jest.fn().mockResolvedValue(),
};

module.exports = mockPool;
