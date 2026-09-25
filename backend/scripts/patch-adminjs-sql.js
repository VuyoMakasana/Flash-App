'use strict';

// Runs on every `npm install` (wired via package.json's `postinstall`) —
// node_modules changes don't survive being hand-edited, so this has to be
// re-applied automatically on every install (local dev, CI, and Render's
// own build step, which runs plain `npm install`), not fixed once by hand.
//
// Real bug in @adminjs/sql@2.2.6 (npm's own latest — confirmed no newer
// version exists to upgrade to instead), found live: AdminJS's admin panel
// failed to mount in production with "more than one row returned by a
// subquery used as an expression" the moment `messages` was promoted to a
// browsable resource (6189e90), because Supabase's own `realtime` schema
// ships its own `realtime.messages` table alongside our `public.messages`.
//
// The library DOES accept a `schema` connection option (checked its source
// directly, adminPanel.js now passes `schema: 'public'`) — but that option
// only scopes the `information_schema.tables`/`.columns` queries in
// getSchema()/getTables(). getProperties()'s own raw foreign-key-discovery
// query (postgres.parser.js) looks up the table by bare `relname` against
// `pg_class` — a system catalog with one row PER SCHEMA for any name that
// exists in more than one, with `schemaName` passed into the function but
// never actually used in that specific subquery. `pg_class.relname` alone
// is genuinely ambiguous across schemas; only `oid` (already how the other
// two lookups in the same query work) or an explicit `pg_namespace` join
// disambiguates it. This is a real, general gap for anyone running this
// library against Supabase (or any multi-schema Postgres) — not specific
// to `messages`, and not something a config option can route around.
//
// Idempotent (safe to run on an already-patched install) and tolerant: if
// the exact known-buggy source text isn't found — e.g. a future
// @adminjs/sql version changed or already fixed this — it logs and exits
// cleanly rather than breaking the install/build, since the whole point is
// this must never be the thing that takes a deploy down.

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname, '..', 'node_modules', '@adminjs', 'sql', 'lib', 'dialects', 'postgres.parser.js',
);

const BUGGY = "where c.conrelid = (select oid from pg_class where relname = '${table}')";
const FIXED = "where c.conrelid = (select pc.oid from pg_class pc join pg_namespace pn on pn.oid = pc.relnamespace where pc.relname = '${table}' and pn.nspname = '${schemaName}')";

function main() {
  if (!fs.existsSync(TARGET)) {
    console.warn('[patch-adminjs-sql] target file not found (package not installed?) — skipping:', TARGET);
    return;
  }

  const source = fs.readFileSync(TARGET, 'utf8');

  if (source.includes(FIXED)) {
    console.log('[patch-adminjs-sql] already patched — nothing to do.');
    return;
  }

  if (!source.includes(BUGGY)) {
    console.warn(
      '[patch-adminjs-sql] known-buggy source text not found — @adminjs/sql may have '
      + 'changed or already fixed this upstream. Skipping (not failing the build), but '
      + 'worth re-checking whether the cross-schema table-name collision is still an '
      + 'issue with whatever version just installed.',
    );
    return;
  }

  fs.writeFileSync(TARGET, source.replace(BUGGY, FIXED), 'utf8');
  console.log('[patch-adminjs-sql] patched: relQuery\'s table lookup is now schema-qualified.');
}

main();
