#!/bin/sh
# READ-ONLY. Runs INSIDE the postgres:17 container, started by
# R-RlsReadiness.ps1 (v43 / FI-081 / #73). The session is switched to
# read-only first, so any write would be refused by the server. Only catalog
# views are read (pg_class, pg_roles, pg_proc, pg_default_acl): no table data,
# and no lock on any application table.
#
# Question it answers: if RLS is enabled (with no policies) on every table in
# public, can the role the BACKEND connects as still read and write every
# table? Postgres skips RLS for a table when the current role
#   - is a superuser, or has BYPASSRLS; or
#   - has the privileges of the table's owner (it IS the owner, or inherits
#     the owner role) and the table does not have FORCE ROW LEVEL SECURITY.
# Otherwise, with no policies, the role sees no rows and cannot write.
#
# Prints, one line each, '|'-separated:
#   session|current_user|session_user|server_version
#   role|<backend role>|super|bypassrls|inherit|canlogin      (or role|<name>|MISSING)
#   table|<name>|owner|rls_enabled|rls_forced|backend_has_owner_privs|exempt|anon_privs|authenticated_privs
#   sequence|<name>|owner|anon_privs|authenticated_privs
#   function|<signature>|owner|anon_execute|authenticated_execute|public_execute (PUBLIC = every role, anon included)
#   default_acl|<grantor role>|<object type>|<schema or ALL>|<acl>
#   owners|<distinct table owners>
#   summary|tables=N|exempt=N|not_exempt=N|rls_enabled=N|tables_with_anon_or_auth_privs=N
#   verdict|OK  or  verdict|STOP|<tables the backend would lose access to>
# Env: FLASH_PROD_DB_URL, FLASH_BACKEND_ROLE
set -eu
: "${FLASH_PROD_DB_URL:?FLASH_PROD_DB_URL is not set}"
: "${FLASH_BACKEND_ROLE:?FLASH_BACKEND_ROLE is not set}"
case "$FLASH_BACKEND_ROLE" in
  *[!a-z0-9_]*|"") echo "readiness: backend role must be lowercase letters, digits, underscore" >&2; exit 1 ;;
esac

psql "$FLASH_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 -At -F '|' -v backend_role="$FLASH_BACKEND_ROLE" <<'SQL'
SET default_transaction_read_only = on;
BEGIN;

SELECT 'session', current_user, session_user, current_setting('server_version');

SELECT 'role', r.rolname::text, 'super=' || r.rolsuper, 'bypassrls=' || r.rolbypassrls, 'inherit=' || r.rolinherit, 'canlogin=' || r.rolcanlogin
  FROM pg_roles r WHERE r.rolname = :'backend_role'
UNION ALL
SELECT 'role', :'backend_role', 'MISSING', '', '', ''
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'backend_role');

-- One definition of "the tables and whether the backend is exempt", reused below.
\set tables_cte 'WITH br AS (SELECT oid, rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = ' :'backend_role' '), t AS (SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced, COALESCE((SELECT pg_has_role(br.oid, c.relowner, ''USAGE'') FROM br), false) AS owner_privs, COALESCE((SELECT bypass FROM br), false) AS bypass, (SELECT count(*) FROM aclexplode(COALESCE(c.relacl, acldefault(''r'', c.relowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = ''anon'') AS anon_privs, (SELECT count(*) FROM aclexplode(COALESCE(c.relacl, acldefault(''r'', c.relowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = ''authenticated'') AS auth_privs FROM pg_class c WHERE c.relnamespace = ''public''::regnamespace AND c.relkind IN (''r'', ''p'')), e AS (SELECT t.*, (t.bypass OR (t.owner_privs AND NOT t.rls_forced)) AS exempt FROM t)'

:tables_cte
SELECT 'table', relname, owner, rls_enabled, rls_forced, owner_privs, exempt, anon_privs, auth_privs
  FROM e ORDER BY relname;

SELECT 'sequence', c.relname, pg_get_userbyid(c.relowner),
       (SELECT count(*) FROM aclexplode(COALESCE(c.relacl, acldefault('s', c.relowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = 'anon'),
       (SELECT count(*) FROM aclexplode(COALESCE(c.relacl, acldefault('s', c.relowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = 'authenticated')
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
 ORDER BY c.relname;

SELECT 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner),
       EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = 'anon'),
       EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = 'authenticated'),
       EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
 ORDER BY 2;

SELECT 'default_acl', pg_get_userbyid(d.defaclrole),
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END,
       COALESCE(d.defaclnamespace::regnamespace::text, 'ALL'),
       d.defaclacl::text
  FROM pg_default_acl d
 WHERE d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace
 ORDER BY 2, 3, 4;

SELECT 'owners', string_agg(DISTINCT pg_get_userbyid(c.relowner), ',' ORDER BY pg_get_userbyid(c.relowner))
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p');

:tables_cte
SELECT 'summary',
       'tables=' || count(*),
       'exempt=' || count(*) FILTER (WHERE exempt),
       'not_exempt=' || count(*) FILTER (WHERE NOT exempt),
       'rls_enabled=' || count(*) FILTER (WHERE rls_enabled),
       'tables_with_anon_or_auth_privs=' || count(*) FILTER (WHERE anon_privs > 0 OR auth_privs > 0)
  FROM e;

:tables_cte
SELECT 'verdict',
       CASE WHEN count(*) FILTER (WHERE NOT exempt) = 0 AND count(*) > 0 THEN 'OK' ELSE 'STOP' END,
       string_agg(relname, ',' ORDER BY relname) FILTER (WHERE NOT exempt)
  FROM e;

ROLLBACK;
SQL
