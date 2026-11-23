-- flash-rollback: v45
-- issue: #91
--
-- Undoes v45 ONLY on an explicit founder decision (docs/PROD_MIGRATIONS.md
-- s7), through D-Apply.ps1 -Rollback. Never run by migrate.js.
-- Drops public.admin_mfa_recovery_codes (every recovery code) and the three
-- TOTP columns on public.admins (every enrolment), with admins_totp_check,
-- and removes the v45 ledger row. Refuses unless the ledger records v45 and
-- nothing later.
-- WARNING for after the MFA code (PR 3) ships: the backend requires these
-- columns for every admin login. Deploy code that no longer uses them
-- BEFORE rolling back, or no admin can log in. Every admin must re-enrol if
-- v45 is applied again.
-- Locks: ACCESS EXCLUSIVE on admins (dropping columns is a catalog change, no
-- rewrite) until COMMIT, milliseconds; lock_timeout 5s.
-- No BEGIN/COMMIT here: the runner wraps the file in one transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v45 rollback: public.schema_migrations_ledger does not exist; refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations_ledger WHERE version = 'v45') THEN
    RAISE EXCEPTION 'v45 rollback: the ledger has no v45 row; nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations_ledger
              WHERE version ~ '^v[0-9]+$' AND substring(version FROM 2)::int > 45) THEN
    RAISE EXCEPTION 'v45 rollback: the ledger records migrations after v45; refusing';
  END IF;
  -- admins first (the strongest lock first, as in v45), then the table.
  ALTER TABLE public.admins
    DROP CONSTRAINT IF EXISTS admins_totp_check,
    DROP COLUMN IF EXISTS totp_secret_enc,
    DROP COLUMN IF EXISTS totp_enrolled_at,
    DROP COLUMN IF EXISTS totp_last_step;
  IF to_regclass('public.admin_mfa_recovery_codes') IS NOT NULL THEN
    DROP TABLE public.admin_mfa_recovery_codes;
  END IF;
  DELETE FROM public.schema_migrations_ledger WHERE version = 'v45';
END $$;
