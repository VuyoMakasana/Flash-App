-- flash-rollback: v42
-- issue: #71
--
-- Undoes v42 ONLY on an explicit founder decision (docs/PROD_MIGRATIONS.md s7),
-- through D-Apply.ps1 -Rollback. Never run by migrate.js.
-- Refuses unless the ledger exists with v42's exact shape and holds no row
-- other than v42 (a later migration depends on the ledger). The only data lost
-- is the v42 ledger row itself.
-- No BEGIN/COMMIT here: the runner wraps the file in one transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v42 rollback: public.schema_migrations_ledger does not exist; nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations_ledger WHERE version <> 'v42') THEN
    RAISE EXCEPTION 'v42 rollback: the ledger records later migrations; refusing';
  END IF;
  DROP TABLE public.schema_migrations_ledger;
END $$;
