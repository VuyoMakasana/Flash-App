// Admin panel table-coverage check — Phase 0
// (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md, Addendum 1 §4.2, Addendum 3 §5).
//
// A real integration test, not a unit test: it needs the actual live schema
// (information_schema.tables), not the mocked pg Pool unit tests use. CI runs
// migrations before this test (.github/workflows/ci.yml), so every real
// table already exists by the time this runs.
//
// The point: fail the build the moment a new migration adds a table nobody
// has made a real admin-visibility decision about yet — not "add a UI for
// it," just "covered (even if only scheduled in a phase) or intentionally
// excluded, with a real reason." See adminCoverage.js's own header for why
// this is stricter than "has a finished screen today."
'use strict';

const { Pool } = require('pg');
const coverage = require('../../src/config/adminCoverage');

describe('admin panel table coverage', () => {
  let pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  test('every real table has a recorded admin-visibility decision', async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const realTables = result.rows.map((r) => r.table_name).sort();

    const coveredKeys = Object.keys(coverage.covered);
    const excludedKeys = Object.keys(coverage.intentionallyExcluded);
    const decidedKeys = new Set([...coveredKeys, ...excludedKeys]);

    const undecided = realTables.filter((t) => !decidedKeys.has(t));

    if (undecided.length) {
      throw new Error(
        `${undecided.length} table(s) exist with no admin-coverage decision recorded: ` +
        `${undecided.join(', ')}. Add each to either "covered" (with which phase/endpoint) ` +
        `or "intentionallyExcluded" (with a real one-line reason) in ` +
        `backend/src/config/adminCoverage.js before this can pass.`,
      );
    }
  });

  test('every registry entry still refers to a real table (no stale entries)', async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const realTables = new Set(result.rows.map((r) => r.table_name));

    const allKeys = [...Object.keys(coverage.covered), ...Object.keys(coverage.intentionallyExcluded)];
    const stale = allKeys.filter((k) => !realTables.has(k));

    if (stale.length) {
      throw new Error(
        `${stale.length} adminCoverage.js entry/entries reference tables that no longer exist: ` +
        `${stale.join(', ')}. Remove them (or fix a typo) so the registry stays accurate.`,
      );
    }
  });

  test('no table is listed in both buckets', () => {
    const coveredKeys = Object.keys(coverage.covered);
    const excludedKeys = Object.keys(coverage.intentionallyExcluded);
    const inBoth = coveredKeys.filter((k) => excludedKeys.includes(k));
    expect(inBoth).toEqual([]);
  });
});
