-- flash-migration: v45
-- name: admin_totp
-- issue: #91
-- before-schema-sha256: 83a42d48864dbd9e6eeee0a8ed0b1d0aa5e1a59ed5967778e5fc7560f9ceb001
-- after-schema-sha256: aefbc6affe4dc1b2041aaa318721620f4abf5289810b945dae11d013ce91ccd9
--
-- What (admin MFA, founder decisions 2026-11-23; the design is
-- docs/ADMIN_MFA_DESIGN.md; the code that uses it is a later PR):
--   public.admins gets three nullable columns:
--     totp_secret_enc   text: the TOTP secret, AES-256-GCM encrypted by the
--                       backend under ADMIN_TOTP_ENCRYPTION_KEY, stored as
--                       "v<key version>:<iv>:<tag>:<ciphertext>" (base64url).
--                       The database never sees the plain secret.
--     totp_enrolled_at  timestamptz: when enrolment was confirmed with a code.
--     totp_last_step    bigint: the last 30-second time step accepted, so the
--                       same code can never be used twice.
--   admins_totp_check: secret and enrolment time are set together or not at
--   all; a last step only exists once enrolled, and is >= 0; the secret has
--   the versioned format above.
--
--   public.admin_mfa_recovery_codes: one row per recovery code.
--     id uuid PK; admin_id uuid NOT NULL -> admins(id) ON DELETE CASCADE;
--     code_hash text NOT NULL, lowercase hex sha256 (codes are 80-bit random,
--     so a plain sha256 can't be reversed); created_at; used_at (NULL until
--     used; a code is used by one UPDATE ... WHERE used_at IS NULL, so it
--     works once). UNIQUE (admin_id, code_hash) is both the lookup index and
--     the index behind the foreign key.
--   Rule 9: RLS on the new table, no policies, nothing granted to
--   anon/authenticated. (admins already has RLS on, since v43.)
--
-- Fingerprints: sha256 of normalize_schema.py --baseline output for a
-- prod_dump_schema.sh dump of public (docs/PROD_MIGRATIONS.md s3).
--
-- Runners (both wrap this whole file in ONE transaction; it has no BEGIN/COMMIT):
--   production: scripts/prod-migrations/D-Apply.ps1, i.e. psql -X
--               -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha256> -f
--   fresh / CI: migrateV45 in backend/src/db/migrate.js (applyMigrationFile),
--               which computes the same sha256 over the same bytes.
-- The psql variable is used exactly once, on the SET LOCAL line below.
--
-- Locks (first apply only; a re-run takes none):
--   public.admins: ACCESS EXCLUSIVE, taken by the one ALTER TABLE in step 2
--     and held until COMMIT (the rest of this file: milliseconds). The ALTER
--     only adds nullable columns with no default (a catalog change, no table
--     rewrite) and a CHECK that scans admins (a handful of rows). Taken
--     FIRST, so the later foreign key (SHARE ROW EXCLUSIVE on admins) never
--     has to upgrade a lock it already holds. While it is held, admin logins,
--     admin_actions inserts and other writes that check an FK to admins
--     wait; nothing else does. lock_timeout 5s: if admins is busy, the
--     file fails cleanly and changes nothing.
--   No other existing table is read or locked (except the ledger row write).
-- Idempotent. A run with a different file hash for v45 fails.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL flash.file_sha = :'file_sha';

-- 1. Guards (schema facts only, never data: step D's rehearsal restores a
--    schema-only dump, in which every table is empty).
DO $$
BEGIN
  IF current_setting('flash.file_sha') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'v45: file_sha is not a lowercase sha256 hex digest';
  END IF;
  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v45: v42 (public.schema_migrations_ledger) must be applied first; refusing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.schema_migrations_ledger'::regclass) THEN
    RAISE EXCEPTION 'v45: v43 (RLS lockdown) must be applied first; refusing';
  END IF;
  IF to_regclass('public.feature_switches') IS NULL THEN
    RAISE EXCEPTION 'v45: v44 (public.feature_switches) must be applied first; refusing';
  END IF;
  IF to_regclass('public.admins') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = 'public.admins'::regclass AND a.attname = 'id'
                       AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = 'uuid')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.admins'::regclass AND c.contype = 'p') THEN
    RAISE EXCEPTION 'v45: public.admins with a uuid primary key "id" is required; refusing';
  END IF;
END $$;

-- 2. The admins columns and their CHECK: one ALTER, one lock (see Locks).
DO $$
DECLARE
  n_present integer;
BEGIN
  SELECT count(*) INTO n_present
    FROM pg_attribute a
   WHERE a.attrelid = 'public.admins'::regclass AND NOT a.attisdropped
     AND a.attname IN ('totp_secret_enc', 'totp_enrolled_at', 'totp_last_step');

  IF n_present = 0 THEN
    ALTER TABLE public.admins
      ADD COLUMN totp_secret_enc text,
      ADD COLUMN totp_enrolled_at timestamptz,
      ADD COLUMN totp_last_step bigint,
      ADD CONSTRAINT admins_totp_check CHECK (
        (totp_secret_enc IS NULL) = (totp_enrolled_at IS NULL)
        AND (totp_last_step IS NULL OR (totp_enrolled_at IS NOT NULL AND totp_last_step >= 0))
        AND (totp_secret_enc IS NULL
             OR totp_secret_enc ~ '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'));
  END IF;

  -- Exact shape, whether just added or already there (catalog reads only).
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.admins'::regclass AND NOT a.attisdropped
         AND (a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef) IN (
           ('totp_secret_enc', 'text', false, false),
           ('totp_enrolled_at', 'timestamp with time zone', false, false),
           ('totp_last_step', 'bigint', false, false))) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.admins'::regclass AND c.contype = 'c'
                       AND c.conname = 'admins_totp_check' AND c.convalidated) THEN
    RAISE EXCEPTION 'v45: public.admins has an unexpected TOTP column or constraint shape; refusing';
  END IF;
END $$;

-- 3. The recovery-code table.
DO $$
DECLARE
  rel oid;
BEGIN
  IF to_regclass('public.admin_mfa_recovery_codes') IS NULL THEN
    CREATE TABLE public.admin_mfa_recovery_codes (
      id         uuid        NOT NULL DEFAULT gen_random_uuid(),
      admin_id   uuid        NOT NULL,
      code_hash  text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      used_at    timestamptz,
      CONSTRAINT admin_mfa_recovery_codes_pkey PRIMARY KEY (id),
      CONSTRAINT admin_mfa_recovery_codes_admin_id_fkey FOREIGN KEY (admin_id)
        REFERENCES public.admins (id) ON DELETE CASCADE,
      CONSTRAINT admin_mfa_recovery_codes_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT admin_mfa_recovery_codes_admin_code_key UNIQUE (admin_id, code_hash)
    );
  END IF;

  rel := 'public.admin_mfa_recovery_codes'::regclass;
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped) <> 5
     OR (SELECT count(*) FROM pg_attribute a
          WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef) IN (
              ('id', 'uuid', true, true),
              ('admin_id', 'uuid', true, false),
              ('code_hash', 'text', true, false),
              ('created_at', 'timestamp with time zone', true, true),
              ('used_at', 'timestamp with time zone', false, false))) <> 5
     OR (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = rel) <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = rel AND c.contype = 'f'
                       AND c.conname = 'admin_mfa_recovery_codes_admin_id_fkey'
                       AND c.confrelid = 'public.admins'::regclass AND c.confdeltype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = rel AND c.contype = 'u'
                       AND c.conname = 'admin_mfa_recovery_codes_admin_code_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = rel AND c.contype = 'c'
                       AND c.conname = 'admin_mfa_recovery_codes_code_hash_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = rel AND c.contype = 'p'
                       AND c.conname = 'admin_mfa_recovery_codes_pkey') THEN
    RAISE EXCEPTION 'v45: public.admin_mfa_recovery_codes exists with an unexpected shape; refusing';
  END IF;
END $$;

-- 4. Rule 9: RLS on (no FORCE, no policies). Nothing is granted to anyone here.
--    Only when it is off, so a re-run takes no lock on the table.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_mfa_recovery_codes'::regclass) THEN
    ALTER TABLE public.admin_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- 5. Prove it inside the transaction; any failure rolls everything back.
DO $$
DECLARE
  bad text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_mfa_recovery_codes'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admins'::regclass) THEN
    RAISE EXCEPTION 'v45: RLS must be on for admins and admin_mfa_recovery_codes; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.admin_mfa_recovery_codes'::regclass) THEN
    RAISE EXCEPTION 'v45: admin_mfa_recovery_codes must have no policies; refusing';
  END IF;
  SELECT string_agg(DISTINCT g.rolname, ', ') INTO bad
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
   WHERE c.oid IN ('public.admin_mfa_recovery_codes'::regclass, 'public.admins'::regclass)
     AND g.rolname IN ('anon', 'authenticated');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v45: % hold privileges on admins or admin_mfa_recovery_codes (rule 9); refusing', bad;
  END IF;
END $$;

-- 6. Ledger row, with the changed-file refusal (as v42-v44).
DO $$
DECLARE
  got text;
BEGIN
  INSERT INTO public.schema_migrations_ledger (version, sha256)
  VALUES ('v45', current_setting('flash.file_sha'))
  ON CONFLICT (version) DO NOTHING;

  SELECT sha256 INTO got FROM public.schema_migrations_ledger WHERE version = 'v45';
  IF got IS DISTINCT FROM current_setting('flash.file_sha') THEN
    RAISE EXCEPTION 'v45: the ledger already records a different sha256 for v45 (this file changed after it was applied); refusing';
  END IF;
END $$;
