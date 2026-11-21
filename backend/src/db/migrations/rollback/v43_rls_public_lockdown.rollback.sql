-- flash-rollback: v43
-- issue: #73
--
-- Undoes v43's RLS ONLY on an explicit founder decision (docs/PROD_MIGRATIONS.md
-- s7), through D-Apply.ps1 -Rollback. Never run by migrate.js.
-- Founder decision (2026-11-21): this NEVER re-grants anything to anon or
-- authenticated, and never restores postgres's old default privileges. After
-- a rollback, RLS is off, the revokes stay, and the v43 ledger row is removed.
-- Refuses unless the ledger records v43 and nothing later than v43.
-- No BEGIN/COMMIT here: the runner wraps the file in one transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  t text;
BEGIN
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v43 rollback: public.schema_migrations_ledger does not exist; refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations_ledger WHERE version = 'v43') THEN
    RAISE EXCEPTION 'v43 rollback: the ledger has no v43 row; nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations_ledger
              WHERE version ~ '^v[0-9]+$' AND substring(version FROM 2)::int > 43) THEN
    RAISE EXCEPTION 'v43 rollback: the ledger records migrations after v43; refusing';
  END IF;

  FOR t IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;

  DELETE FROM public.schema_migrations_ledger WHERE version = 'v43';
END $$;
