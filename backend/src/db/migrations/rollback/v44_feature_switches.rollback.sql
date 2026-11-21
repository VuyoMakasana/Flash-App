-- flash-rollback: v44
-- issue: #84
--
-- Undoes v44 ONLY on an explicit founder decision (docs/PROD_MIGRATIONS.md
-- s7), through D-Apply.ps1 -Rollback. Never run by migrate.js.
-- Drops public.feature_switches (and with it every switch value) and removes
-- the v44 ledger row. Refuses unless the ledger records v44 and nothing later.
-- WARNING for after L0.5b ships: the backend reads this table; deploy code
-- that no longer needs it BEFORE rolling back, or every switch falls back to
-- its cold-start default (money-moving switches closed).
-- No BEGIN/COMMIT here: the runner wraps the file in one transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v44 rollback: public.schema_migrations_ledger does not exist; refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations_ledger WHERE version = 'v44') THEN
    RAISE EXCEPTION 'v44 rollback: the ledger has no v44 row; nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations_ledger
              WHERE version ~ '^v[0-9]+$' AND substring(version FROM 2)::int > 44) THEN
    RAISE EXCEPTION 'v44 rollback: the ledger records migrations after v44; refusing';
  END IF;
  IF to_regclass('public.feature_switches') IS NOT NULL THEN
    DROP TABLE public.feature_switches;
  END IF;
  DELETE FROM public.schema_migrations_ledger WHERE version = 'v44';
END $$;
