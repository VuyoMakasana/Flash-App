-- flash-migration: v42
-- name: schema_migrations_ledger
-- issue: #71
-- before-schema-sha256: 697134afc4a774331a0c34cf2e11fb37d140ddd5d65a95f4795e664280a6962d
-- after-schema-sha256: 4355621aeb6a76825ffa1d41c9f674fc4dfa0c7ae2ba2f70731afbf25e951cd3
--
-- What: creates public.schema_migrations_ledger (version, sha256, applied_at),
-- the record of which standalone migration files have been applied to this
-- database and the exact bytes applied, then records this file in it.
-- Approved by the founder 2026-11-20 (docs/PROD_MIGRATIONS.md).
--
-- Fingerprints: sha256 of normalize_schema.py --baseline output for a
-- prod_dump_schema.sh dump of the public schema (docs/PROD_MIGRATIONS.md s3).
--
-- Runners (both wrap this whole file in ONE transaction; it has no BEGIN/COMMIT):
--   production: scripts/prod-migrations/D-Apply.ps1, i.e. psql -X
--               -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha256> -f
--   fresh / CI: migrateV42 in backend/src/db/migrate.js (applyMigrationFile),
--               which computes the same sha256 over the same bytes.
-- The psql variable is used exactly once, on the SET LOCAL line below; every
-- later statement reads it back with current_setting('flash.file_sha').
--
-- Locks: creates a new table only. No application table is read or locked.
-- Idempotent: a second run changes nothing. A run with a different file hash
-- for v42 fails, because a migration file must never change once applied.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL flash.file_sha = :'file_sha';

DO $$
DECLARE
  n_cols  integer;
  ok_cols integer;
  pk_cols text;
BEGIN
  IF current_setting('flash.file_sha') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'v42: file_sha is not a lowercase sha256 hex digest';
  END IF;

  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    CREATE TABLE public.schema_migrations_ledger (
      version    text        PRIMARY KEY,
      sha256     text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  -- Exact shape check (pg_attribute / pg_constraint only, never pg_get_expr).
  SELECT count(*),
         count(*) FILTER (WHERE (a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef) IN (
           ('version', 'text', true, false),
           ('sha256', 'text', true, false),
           ('applied_at', 'timestamp with time zone', true, true)))
    INTO n_cols, ok_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.schema_migrations_ledger'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT string_agg(a.attname, ',') INTO pk_cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.schema_migrations_ledger'::regclass AND c.contype = 'p';

  IF n_cols <> 3 OR ok_cols <> 3 OR pk_cols IS DISTINCT FROM 'version' THEN
    RAISE EXCEPTION 'v42: public.schema_migrations_ledger exists with an unexpected shape; refusing';
  END IF;
END $$;

DO $$
DECLARE
  got text;
BEGIN
  INSERT INTO public.schema_migrations_ledger (version, sha256)
  VALUES ('v42', current_setting('flash.file_sha'))
  ON CONFLICT (version) DO NOTHING;

  SELECT sha256 INTO got FROM public.schema_migrations_ledger WHERE version = 'v42';
  IF got IS DISTINCT FROM current_setting('flash.file_sha') THEN
    RAISE EXCEPTION 'v42: the ledger already records a different sha256 for v42 (this file changed after it was applied); refusing';
  END IF;
END $$;
