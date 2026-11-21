-- flash-migration: v43
-- name: rls_public_lockdown
-- issue: #73
-- before-schema-sha256: 4355621aeb6a76825ffa1d41c9f674fc4dfa0c7ae2ba2f70731afbf25e951cd3
-- after-schema-sha256: 689f03b475668d489e614e8f1ae4538045a7c1734b0b9f2507519b79ea5cf113
--
-- What (FI-081, founder decisions 2026-11-21, docs/PROD_MIGRATIONS.md):
--   1. ENABLE ROW LEVEL SECURITY on every table in public (67 on production,
--      schema_migrations_ledger included). No FORCE, no policies: the backend
--      role (postgres on production: owner of every table, BYPASSRLS) is not
--      subject to RLS; every other role sees no rows and cannot write.
--   2. REVOKE ALL on all tables, sequences and functions in public FROM anon
--      and authenticated.
--   3. ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL
--      on tables, sequences and functions FROM anon and authenticated, so a
--      future table is not granted to them either.
--   Left alone on purpose: service_role; supabase_admin's default privileges
--   (accepted gap: they only apply to objects supabase_admin creates);
--   schema USAGE on public.
--   Steps 2-3 run only where those roles exist (Supabase). Fresh/CI databases
--   do not have them, so there only step 1 applies.
--
-- Fingerprints: sha256 of normalize_schema.py --baseline output for a
-- prod_dump_schema.sh dump of public (docs/PROD_MIGRATIONS.md s3). The dump
-- uses --no-privileges, so the fingerprint shows step 1 (67 ENABLE ROW LEVEL
-- SECURITY lines) but NOT steps 2-3. Those are proved by the in-transaction
-- check below and, on production, by R-RlsReadiness.ps1 -PostV43 after step E.
--
-- Runners (both wrap this whole file in ONE transaction; it has no BEGIN/COMMIT):
--   production: scripts/prod-migrations/D-Apply.ps1, i.e. psql -X
--               -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha256> -f
--   fresh / CI: migrateV43 in backend/src/db/migrate.js (applyMigrationFile),
--               which computes the same sha256 over the same bytes.
-- The psql variable is used exactly once, on the SET LOCAL line below.
--
-- Locks: ENABLE ROW LEVEL SECURITY takes an ACCESS EXCLUSIVE lock on each
-- table it changes, held until COMMIT; lock_timeout 5s makes any wait behind a
-- running query fail the whole transaction cleanly (nothing applied).
-- A re-run changes nothing and takes none of those locks.
-- Idempotent. A run with a different file hash for v43 fails.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL flash.file_sha = :'file_sha';

-- 1. Guards (nothing has changed yet).
DO $$
DECLARE
  expected   text[] := ARRAY[
    'addresses', 'admin_actions', 'admins', 'app_ratings',
    'brand_size_mappings', 'browsing_events', 'chat_reports',
    'commission_rates', 'driver_commission_debts', 'driver_documents',
    'driver_locations', 'driver_payout_requests', 'driver_payouts',
    'driver_penalties', 'driver_ratings', 'driver_subscriptions',
    'driver_wallet_ledger', 'driver_wallets', 'drivers', 'email_events',
    'email_tokens', 'feed_comments', 'feed_likes', 'feed_post_products',
    'feed_posts', 'flagged_accounts', 'flash_inventory',
    'marketing_applications', 'marketing_contact_messages',
    'marketing_waitlist', 'messages', 'order_cancellation_store_shares',
    'order_cancellations', 'order_items', 'order_stops', 'orders',
    'payflex_webhook_events', 'payment_methods', 'payment_refunds',
    'payments', 'payout_transactions', 'premium_subscription_payments',
    'premium_subscriptions', 'refresh_tokens', 'return_request_items',
    'return_requests', 'revoked_tokens', 'saved_cards',
    'schema_migrations_ledger', 'settlement_config', 'size_profiles',
    'sos_alerts', 'store_actions', 'store_boosts', 'store_credits',
    'store_password_tokens', 'store_promotions',
    'store_settlement_line_items', 'store_settlements',
    'store_transfer_recipients', 'store_users', 'stores',
    'transfer_recipients', 'trusted_drivers', 'user_blocks', 'users',
    'webhook_events'
  ];
  settlement text[] := ARRAY['settlement_config', 'store_settlement_line_items', 'store_settlements'];
  actual     text[];
  missing    text[];
  extra      text[];
  locked_out text;
BEGIN
  IF current_setting('flash.file_sha') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'v43: file_sha is not a lowercase sha256 hex digest';
  END IF;
  -- The applying role must keep access to every table once RLS is on.
  -- Checked first, from the catalog only, so a wrong role gets this message.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO locked_out
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND NOT (
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user)
       OR (pg_has_role(current_user, c.relowner, 'USAGE') AND NOT c.relforcerowsecurity)
     );
  IF locked_out IS NOT NULL THEN
    RAISE EXCEPTION 'v43: role % would lose access to these tables once RLS is on: %; refusing', current_user, locked_out;
  END IF;

  IF to_regclass('public.schema_migrations_ledger') IS NULL THEN
    RAISE EXCEPTION 'v43: v42 (public.schema_migrations_ledger) must be applied first; refusing';
  END IF;

  -- The exact table set, checked by name, before the first application only
  -- (a re-run after later migrations added tables must stay a no-op).
  -- Production must hold exactly these 67 tables. A fresh/CI database built by
  -- migrate.js holds the same set minus exactly the 3 production-only
  -- settlement tables (docs/SCHEMA_BASELINE.md s4.2). Anything else: refuse.
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations_ledger WHERE version = 'v43') THEN
    SELECT COALESCE(array_agg(c.relname::text), '{}') INTO actual
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p');
    SELECT COALESCE(array_agg(x), '{}') INTO missing FROM unnest(expected) x WHERE NOT (x = ANY (actual));
    SELECT COALESCE(array_agg(x), '{}') INTO extra   FROM unnest(actual) x WHERE NOT (x = ANY (expected));
    IF cardinality(extra) > 0
       OR NOT (cardinality(missing) = 0 OR (missing @> settlement AND missing <@ settlement)) THEN
      RAISE EXCEPTION 'v43: public must hold exactly the 67 expected tables (production) or those minus the 3 production-only settlement tables (fresh/CI); found % tables; missing: %; unexpected: %; refusing',
        cardinality(actual), missing, extra;
    END IF;
  END IF;

END $$;

-- 2. RLS on every table in public that does not have it yet. No FORCE.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 3. Revoke anon/authenticated, and stop postgres's default privileges from
--    granting them again. Only where the roles exist (Supabase).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 4. Prove it inside the transaction; any failure rolls everything back.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v43: RLS is still off on: %; refusing', bad;
  END IF;

  SELECT string_agg(DISTINCT c.relname || ' (' || g.rolname || ')', ', ') INTO bad
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
     AND g.rolname IN ('anon', 'authenticated');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v43: anon/authenticated still hold privileges on: %; refusing', bad;
  END IF;

  SELECT string_agg(DISTINCT p.oid::regprocedure::text || ' (' || g.rolname || ')', ', ') INTO bad
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
   WHERE p.pronamespace = 'public'::regnamespace AND g.rolname IN ('anon', 'authenticated');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v43: anon/authenticated can still execute: %; refusing', bad;
  END IF;

  -- postgres's default privileges, in public AND global ones (namespace 0):
  -- a global entry cannot be removed by the IN SCHEMA public revoke above, so
  -- if one exists this refuses and says so rather than leave it unseen.
  SELECT string_agg(DISTINCT d.defaclobjtype::text || ' in ' || COALESCE(d.defaclnamespace::regnamespace::text, 'ALL schemas') || ' (' || g.rolname || ')', ', ') INTO bad
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    JOIN pg_roles g ON g.oid = a.grantee
   WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
     AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
     AND g.rolname IN ('anon', 'authenticated');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v43: postgres default privileges still grant anon/authenticated: % (an ALL-schemas entry needs a separate, reviewed change); refusing', bad;
  END IF;
END $$;

-- 5. Ledger row, with the changed-file refusal (as v42).
DO $$
DECLARE
  got text;
BEGIN
  INSERT INTO public.schema_migrations_ledger (version, sha256)
  VALUES ('v43', current_setting('flash.file_sha'))
  ON CONFLICT (version) DO NOTHING;

  SELECT sha256 INTO got FROM public.schema_migrations_ledger WHERE version = 'v43';
  IF got IS DISTINCT FROM current_setting('flash.file_sha') THEN
    RAISE EXCEPTION 'v43: the ledger already records a different sha256 for v43 (this file changed after it was applied); refusing';
  END IF;
END $$;
