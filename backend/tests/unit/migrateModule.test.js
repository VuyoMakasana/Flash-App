'use strict';
/**
 * tests/unit/migrateModule.test.js
 *
 * OPEN_FOLLOWUPS #22 — `src/db/migrate.js` used to call `migrate()` at module
 * scope with no `require.main === module` guard, so simply requiring it ran
 * **every migration** against whatever `DATABASE_URL` was set. Against a
 * developer's shell that could have been production.
 *
 * **This file could not have existed before the guard.** Importing the module
 * was the bug, so no test could touch it — which is why migration v40's
 * coverage in `PRODUCT_PRICE_INTEGRITY_RECORD.md` §7 had to be five
 * *source-text* assertions rather than behavioural ones.
 *
 * The first test below is the guard's real proof: it is behavioural, not a
 * grep for the `if` statement. If the guard were removed, requiring this
 * module would call `pool.connect()` and the assertion would fail.
 *
 * The rest demonstrate the payoff — v40 asserted by what it actually *does*,
 * against a recording client, instead of by how its source reads.
 *
 * Still not a substitute for executing v40 against a real Postgres. CI does
 * that on every run (`node src/db/migrate.js` against `postgres:15`), and it
 * is applied and verified in production. A mock client proves the statement
 * sequence and the rollback path; it cannot prove Postgres accepts the SQL.
 */

// `pg` is mocked, NOT `src/config/database`.
//
// This matters, and the first version of this file got it wrong: migrate.js
// builds its own pool directly (`const { Pool } = require('pg')` then
// `new Pool(...)` at line 17) and never imports src/config/database. Mocking
// that module made the assertion below **vacuously true** — `connect` could
// never be called, so the test passed identically with the guard removed.
// Caught by mutation testing: deleting the guard failed nothing.
const mockConnect = jest.fn(async () => ({
  query: jest.fn(async () => ({ rows: [] })),
  release: jest.fn(),
}));
const mockEnd = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ connect: mockConnect, end: mockEnd, query: jest.fn() })),
}));

// Required AFTER the mock is registered, which is the whole point: if the
// guard is absent, this line runs the entire migration chain.
const migrate = require('../../src/db/migrate');

describe('#22 — requiring migrate.js must not run migrations', () => {
  // The guard's real proof. `migrate()` opens with
  // `const client = await pool.connect()`, so without the guard this call is
  // made synchronously at require time and this assertion fails.
  test('importing the module never connects to the database', () => {
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('the module is importable and exposes its migrations', () => {
    expect(typeof migrate.migrateV40).toBe('function');
    expect(typeof migrate.migrateV39).toBe('function');
    expect(typeof migrate.migrateV7).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v40, asserted behaviourally — newly possible, see the header.
// ─────────────────────────────────────────────────────────────────────────────

function recordingClient({ failOn = null } = {}) {
  const sent = [];
  const client = {
    query: jest.fn(async (sql) => {
      const text = String(sql);
      sent.push(text);
      if (failOn && text.includes(failOn)) throw new Error('simulated failure');
      return { rows: [] };
    }),
    sent,
  };
  return client;
}

describe('migrateV40 — behaviour', () => {
  test('wraps its work in a transaction and commits', async () => {
    const client = recordingClient();
    await migrate.migrateV40(client);

    const trimmed = client.sent.map((s) => s.trim());
    expect(trimmed[0]).toBe('BEGIN');
    expect(trimmed[trimmed.length - 1]).toBe('COMMIT');
    expect(trimmed).not.toContain('ROLLBACK');
  });

  test('adds both constraints with the agreed definitions', async () => {
    const client = recordingClient();
    await migrate.migrateV40(client);
    const all = client.sent.join('\n');

    expect(all).toMatch(
      /ADD CONSTRAINT flash_inventory_price_positive CHECK \(price > 0\)/,
    );
    expect(all).toMatch(
      /ADD CONSTRAINT flash_inventory_cost_price_non_negative\s+CHECK \(cost_price IS NULL OR cost_price >= 0\)/,
    );
  });

  // Founder-confirmed: the 100_000 ceiling is application policy, not a schema
  // invariant, so it must never reach the migration.
  test('does not put the price ceiling in the schema', async () => {
    const client = recordingClient();
    await migrate.migrateV40(client);
    expect(client.sent.join('\n')).not.toMatch(/100000|100_000/);
  });

  // ADD CONSTRAINT has no IF NOT EXISTS, and `npm run migrate` must stay safe
  // to re-run -- without the guard a second run fails with 42710.
  //
  // Each guard must name ITS OWN constraint, which is stricter than counting
  // two guards and is the point: an earlier version of this test only counted
  // them, and mutation testing showed that pointing the cost_price guard at
  // `flash_inventory_price_positive` survived it. That mutation is a real bug,
  // not a cosmetic one -- the price constraint is added first in the same
  // transaction, so by the time the second block runs its guard would already
  // be satisfied and **the cost_price constraint would silently never be
  // added**, on a first run as well as a repeat.
  test('each constraint is guarded by its own name, so none is silently skipped', async () => {
    const client = recordingClient();
    await migrate.migrateV40(client);

    const addStatements = client.sent.filter((s) => s.includes('ADD CONSTRAINT'));
    expect(addStatements).toHaveLength(2);

    for (const stmt of addStatements) {
      const added = stmt.match(/ADD CONSTRAINT\s+(\w+)/)[1];
      const guarded = stmt.match(/conname = '(\w+)'/)[1];
      expect(guarded).toBe(added);
    }

    expect(addStatements.map((s) => s.match(/ADD CONSTRAINT\s+(\w+)/)[1]).sort()).toEqual([
      'flash_inventory_cost_price_non_negative',
      'flash_inventory_price_positive',
    ]);
  });

  test('rolls back and rethrows if a constraint cannot be added', async () => {
    const client = recordingClient({ failOn: 'flash_inventory_price_positive' });

    await expect(migrate.migrateV40(client)).rejects.toThrow('simulated failure');

    expect(client.sent.map((s) => s.trim())).toContain('ROLLBACK');
    expect(client.sent.map((s) => s.trim())).not.toContain('COMMIT');
  });

  // A violating row makes ADD CONSTRAINT fail outright; nothing is coerced or
  // deleted. This pins that the handler does not swallow that failure -- a
  // silently-skipped constraint would be worse than a failed migration.
  test('a failure is never swallowed', async () => {
    const client = recordingClient({ failOn: 'cost_price_non_negative' });
    await expect(migrate.migrateV40(client)).rejects.toThrow();
  });
});
