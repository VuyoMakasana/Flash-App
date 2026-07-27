// Admin panel chronological-sort enforcement
// (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md — "chronological ordering and
// scalable date/time search, everywhere, permanently").
//
// A real unit test, not an integration test: whether a resource's OPTIONS
// object carries a real, correct default sort is pure configuration-
// construction logic — it doesn't depend on live data or a live schema, so
// it doesn't need one. buildResources(db) is called with a fake `db` stub
// (`.table(name)` returning a plain object), not a real @adminjs/sql
// Adapter — first tried with a real Adapter + a live DB, and hit a real
// environment limitation instead: Jest's default config can't run a
// dynamic import() for an ESM-only package without --experimental-vm-modules,
// which isn't worth adding globally just for this. The fake stub is safe
// because buildResources()'s only two uses of the raw `db.table(...)` result
// beyond passing it straight into `resource:` are inside suppressReference()
// (orders/return_requests), which only calls
// `resourceMetadata.properties.find(...)` — finds nothing against an empty
// array, changes nothing, doesn't throw.
//
// The point, matching adminCoverage.test.js's own enforcement mechanism
// exactly: fail the build the moment a resource is registered in
// buildResources() without going through withChronologicalDefaults. A
// resource added directly as `{ resource: db.table('foo'), options: {
// ...no sort key... } }` has no options.sort, so the first assertion below
// fails immediately — not a convention someone has to remember.
'use strict';

const { buildResources } = require('../../src/adminPanel');
const { RESOURCE_TIMESTAMP_COLUMNS } = require('../../src/config/adminResourceDefaults');

function fakeDb() {
  return {
    table: (tableName) => ({ tableName, properties: [] }),
  };
}

describe('admin panel chronological sort defaults', () => {
  test('every registered resource has a real, correct default sort', () => {
    const resources = buildResources(fakeDb());
    const expectedTables = Object.keys(RESOURCE_TIMESTAMP_COLUMNS).sort();
    const actualTables = resources.map((entry) => entry.resource.tableName).sort();

    // Catches both directions of drift: a resource registered here with no
    // matching RESOURCE_TIMESTAMP_COLUMNS entry, or a documented column with
    // no resource actually registered for it.
    expect(actualTables).toEqual(expectedTables);

    resources.forEach((entry) => {
      const table = entry.resource.tableName;
      const expectedColumn = RESOURCE_TIMESTAMP_COLUMNS[table];
      if (!entry.options.sort) {
        throw new Error(
          `Resource "${table}" has no options.sort -- it was registered without calling `
          + `withChronologicalDefaults(). Every resource in buildResources() (backend/src/adminPanel.js) `
          + `must wrap its options in withChronologicalDefaults(options, RESOURCE_TIMESTAMP_COLUMNS.${table}) `
          + `(backend/src/config/adminResourceDefaults.js) before this can pass.`,
        );
      }
      expect(entry.options.sort.sortBy).toBe(expectedColumn);
      expect(entry.options.sort.direction).toBe('desc');
    });
  });

  test('RESOURCE_TIMESTAMP_COLUMNS has no stale entries (every key is a real registered resource)', () => {
    const resources = buildResources(fakeDb());
    const actualTables = new Set(resources.map((entry) => entry.resource.tableName));
    const stale = Object.keys(RESOURCE_TIMESTAMP_COLUMNS).filter((t) => !actualTables.has(t));

    if (stale.length) {
      throw new Error(
        `RESOURCE_TIMESTAMP_COLUMNS has entries for tables no longer registered as admin `
        + `resources: ${stale.join(', ')}. Remove them (or fix a typo) so the config stays accurate.`,
      );
    }
  });
});
