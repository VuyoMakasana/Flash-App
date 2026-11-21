-- flash-migration: v44
-- name: feature_switches
-- issue: #84
-- before-schema-sha256: 689f03b475668d489e614e8f1ae4538045a7c1734b0b9f2507519b79ea5cf113
-- after-schema-sha256: 83a42d48864dbd9e6eeee0a8ed0b1d0aa5e1a59ed5967778e5fc7560f9ceb001
--
-- What (L0.5a, founder-approved plan 2026-11-21, docs/PROD_MIGRATIONS.md):
--   public.feature_switches: one row per kill switch the founder can flip
--   from the admin panel without a redeploy (the code that reads and guards
--   them is L0.5b, a later PR).
--     key         text PRIMARY KEY, limited by CHECK to the known keys
--     enabled     boolean NOT NULL
--     updated_at  timestamptz NOT NULL DEFAULT now()
--     updated_by  uuid NULL: the admin who last changed it (NULL for the
--                 seed). No foreign key on purpose: v44 then locks no
--                 existing table; the audit trail with the admin's FK lives
--                 in admin_actions (written by L0.5b on every change).
--   No message column: the messages customers, drivers and stores see live
--   in code.
--   Rule 9: RLS on, no policies, nothing granted to anon/authenticated.
--
-- Seed (founder decision): ON  card_payments, new_orders, cash_orders,
--                               store_portal_writes, signups
--                          OFF driver_payouts (the 19:15 nightly transfer,
--                               until L3 is built and tested), premium, boosts
-- The seed is INSERT ... ON CONFLICT DO NOTHING: a re-run NEVER resets a
-- switch the founder has changed since.
--
-- Fingerprints: sha256 of normalize_schema.py --baseline output for a
-- prod_dump_schema.sh dump of public (docs/PROD_MIGRATIONS.md s3). Seed rows
-- are data, not schema; they are checked inside this transaction instead.
--
-- Runners (both wrap this whole file in ONE transaction; it has no BEGIN/COMMIT):
--   production: scripts/prod-migrations/D-Apply.ps1, i.e. psql -X
--               -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha256> -f
--   fresh / CI: migrateV44 in backend/src/db/migrate.js (applyMigrationFile),
--               which computes the same sha256 over the same bytes.
-- The psql variable is used exactly once, on the SET LOCAL line below.
--
-- Locks: creates a new table only; no existing table is read or locked
-- (except the ledger row write). Idempotent. A run with a different file
-- hash for v44 fails.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL flash.file_sha = :'file_sha';

-- 1. Guards and the table.
DO $$
DECLARE
  n_cols  integer;
  ok_cols integer;
  pk_cols text;
  chk     text;
BEGIN
  IF current_setting('flash.file_sha') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'v44: file_sha is not a lowercase sha256 hex digest';
  END IF;
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v44: v42 (public.schema_migrations_ledger) must be applied first; refusing';
  END IF;
  -- v43 must be in place. Checked on the SCHEMA (RLS on the ledger table),
  -- not on ledger rows: step D's rehearsal restores a schema-only dump, in
  -- which the ledger is empty.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.schema_migrations_ledger'::regclass) THEN
    RAISE EXCEPTION 'v44: v43 (RLS lockdown) must be applied first; refusing';
  END IF;

  IF to_regclass('public.feature_switches') IS NULL THEN
    CREATE TABLE public.feature_switches (
      key        text        PRIMARY KEY
                             CONSTRAINT feature_switches_key_check CHECK (key IN (
                               'card_payments', 'new_orders', 'cash_orders', 'driver_payouts',
                               'store_portal_writes', 'signups', 'premium', 'boosts')),
      enabled    boolean     NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid
    );
  END IF;

  -- Exact shape (pg_attribute / pg_constraint; the table is new, so reading
  -- its constraint definition locks nothing anyone else uses).
  SELECT count(*),
         count(*) FILTER (WHERE (a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef) IN (
           ('key', 'text', true, false),
           ('enabled', 'boolean', true, false),
           ('updated_at', 'timestamp with time zone', true, true),
           ('updated_by', 'uuid', false, false)))
    INTO n_cols, ok_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.feature_switches'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT string_agg(a.attname, ',') INTO pk_cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.feature_switches'::regclass AND c.contype = 'p';

  SELECT pg_get_constraintdef(c.oid) INTO chk
    FROM pg_constraint c
   WHERE c.conrelid = 'public.feature_switches'::regclass AND c.contype = 'c'
     AND c.conname = 'feature_switches_key_check';

  IF n_cols <> 4 OR ok_cols <> 4 OR pk_cols IS DISTINCT FROM 'key'
     OR chk IS NULL
     OR (SELECT count(*) FROM unnest(ARRAY['card_payments', 'new_orders', 'cash_orders', 'driver_payouts',
                                           'store_portal_writes', 'signups', 'premium', 'boosts']) k
          WHERE position('''' || k || '''' IN chk) > 0) <> 8
     OR (SELECT count(*) FROM pg_constraint c
          WHERE c.conrelid = 'public.feature_switches'::regclass AND c.contype = 'c') <> 1 THEN
    RAISE EXCEPTION 'v44: public.feature_switches exists with an unexpected shape; refusing';
  END IF;
END $$;

-- 2. Rule 9: RLS on (no FORCE, no policies). Nothing is granted to anyone here.
--    Only when it is off, so a re-run takes no lock on the table.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.feature_switches'::regclass) THEN
    ALTER TABLE public.feature_switches ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- 3. Seed, never overwriting a value the founder has changed.
INSERT INTO public.feature_switches (key, enabled) VALUES
  ('card_payments',       true),
  ('new_orders',          true),
  ('cash_orders',         true),
  ('store_portal_writes', true),
  ('signups',             true),
  ('driver_payouts',      false),
  ('premium',             false),
  ('boosts',              false)
ON CONFLICT (key) DO NOTHING;

-- 4. Prove it inside the transaction; any failure rolls everything back.
DO $$
DECLARE
  bad text;
BEGIN
  IF (SELECT count(*) FROM public.feature_switches) <> 8 THEN
    RAISE EXCEPTION 'v44: feature_switches must hold exactly the 8 known keys; refusing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.feature_switches'::regclass) THEN
    RAISE EXCEPTION 'v44: RLS is not enabled on feature_switches; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.feature_switches'::regclass) THEN
    RAISE EXCEPTION 'v44: feature_switches must have no policies; refusing';
  END IF;
  SELECT string_agg(DISTINCT g.rolname, ', ') INTO bad
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
   WHERE c.oid = 'public.feature_switches'::regclass AND g.rolname IN ('anon', 'authenticated');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v44: % hold privileges on feature_switches (rule 9); refusing', bad;
  END IF;
END $$;

-- 5. Ledger row, with the changed-file refusal (as v42/v43).
DO $$
DECLARE
  got text;
BEGIN
  INSERT INTO public.schema_migrations_ledger (version, sha256)
  VALUES ('v44', current_setting('flash.file_sha'))
  ON CONFLICT (version) DO NOTHING;

  SELECT sha256 INTO got FROM public.schema_migrations_ledger WHERE version = 'v44';
  IF got IS DISTINCT FROM current_setting('flash.file_sha') THEN
    RAISE EXCEPTION 'v44: the ledger already records a different sha256 for v44 (this file changed after it was applied); refusing';
  END IF;
END $$;
