'use strict';
// tests/__mocks__/database.js
// Shared mock for the pg Pool used in all unit tests.

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
