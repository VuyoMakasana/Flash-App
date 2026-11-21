# Flash: how a schema change reaches production (`PROD_MIGRATIONS.md`)

**Status:** approved by the founder 2026-11-20 (launch plan L0.2, #71). **Who this is for:** the founder, who runs every production step, and any developer writing a migration.

`migrate.js` is **never** run against production (`SCHEMA_BASELINE.md` §6, FI-060). From v42 on, every schema change is **one standalone SQL file**. The same bytes are applied in two places:

| Where | How |
|---|---|
| Fresh / CI / local databases | `migrate.js` → `migrateV42`… → `applyMigrationFile()` (`backend/src/db/migrationFile.js`) |
| Production | The founder runs steps **A–E** (`scripts/prod-migrations/*.ps1`). Step D runs `psql -X -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha256> -f <file>` |

## 1. Rules

1. Production schema changes happen **only** through steps A–E below. No Supabase SQL editor, MCP or CLI (FI-061).
2. **Every migration SQL gets a second review before step D** (a GitHub review or comment that names the file and its sha256). Step D asks for the link.
3. **Step B (backup) is mandatory** until the founder confirms that Supabase's own backups exist on the current plan (Dashboard → Database → Backups). Even then, B stays recommended.
4. **Additive first** (expand, then contract). A `DROP`, a data rewrite or a type change is a separate PR with its own explicit approval.
5. **Deploy order:** the migration PR must be safe to deploy *before* the SQL is applied. Code that needs the new schema ships in a later PR, merged only after step E passes.
6. **A migration file never changes after it is applied anywhere that matters.** The ledger records its sha256, and re-applying a changed file fails.
7. **Index changes on large tables** (`orders`, `order_items`, `driver_locations`, `browsing_events`, …) may need `CREATE INDEX CONCURRENTLY`. That **cannot run inside a transaction**, so it does not fit step D (`--single-transaction`). When that day comes, it gets **its own reviewed procedure**. Step D does not detect this by itself; the second reviewer must reject a plain `CREATE INDEX` on a large table (it takes a lock that blocks writes for the whole build).
8. Apply inside the awake window (06:45–19:45 SAST), at a quiet time. Step D warns outside the window. `lock_timeout = 5s` makes a migration give up rather than queue behind live traffic.
9. **Every migration that creates a table must `ENABLE ROW LEVEL SECURITY` on it, in the same file, and must grant nothing to `anon` or `authenticated`** (founder rule, 2026-11-21; FI-081). No policies unless the founder approves one: the backend role owns the tables and is exempt, and every other role is denied. This applies from v43 on. v42's ledger table predates the rule, and v43 enables RLS on it.
10. **Step E for every migration includes the Supabase security advisor** (Dashboard → Advisors → Security). Record its result in the migration PR: the date, and the remaining lints by name and count. A new ERROR or WARN that the migration introduced counts as step E failing. The founder runs it. Claude Code sessions in this repo cannot: the Supabase tools are denied in `.claude/settings.json` (`WORKFLOW.md` §1, rule 1).
11. **Every migration that creates a function in `public` must `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC`, in the same file, and must grant nothing to `anon` or `authenticated`** (founder rule, 2026-11-21; FI-085). Postgres gives `PUBLIC` (every role, `anon` included) `EXECUTE` on every new function by default, and v43 does not change that.

## 2. Files

| File | What |
|---|---|
| `backend/src/db/migrations/vNN_<name>.sql` | The migration: header, then SQL. No `BEGIN`/`COMMIT`; both runners wrap it in one transaction. |
| `backend/src/db/migrations/rollback/vNN_<name>.rollback.sql` | Reviewed rollback, applied only on an explicit founder decision (§7). |
| `backend/src/db/migrations/SHA256SUMS` | `sha256sum` format, one line per migration and rollback file. CI checks it (`tests/unit/migrationFile.test.js`). |
| `backend/src/db/migrationFile.js` | Node side: hash, header parse, `:'file_sha'` binding, `applyMigrationFile()`. |
| `scripts/prod-migrations/A-…E-*.ps1` + `FlashMigration.psm1` | The founder's steps. Windows PowerShell 5.1, ASCII-only, **everything through `docker run`**. No bash, WSL or Python on the host. |
| `scripts/prod-migrations/*.sh`, `schema_delta.py` | Run **inside** containers (`postgres:17`, `python:3.12-alpine`). `run.sh` wraps every step container and reports its exit code (§5, Docker Desktop hang). |
| `scripts/prod-migrations/R-RlsReadiness.ps1` + `rls_readiness.sh` | **Read-only** readiness check (FI-081): table owners, RLS flags, `anon`/`authenticated` privileges, default privileges, and whether the backend role stays exempt from RLS on every table. With **`-PostV43`** it is also the v43 check after step E (§5). |
| `scripts/schema-baseline/v43_grant_rehearsal.sh` | Developer tool, local only: rebuilds production's real **grant** state (Supabase roles, grants, both default ACLs) and rehearses v43 apply / re-apply / wrong sha / rollback / guards / lock timeout. Step D's rehearsal can't do that, because its dump has no privileges. |
| `scripts/schema-baseline/v44_rehearsal.sh` | Developer tool, local only: production's post-v43 state (owner, grants, default ACLs), then v44 apply / seeds / a flipped switch surviving a re-apply / wrong sha / rollback / guards / applying while `orders`, `users` and `admins` are exclusively locked. |
| `scripts/schema-baseline/production_schema_baseline.sql` | The committed baseline. After a migration PR, it is the **expected production schema after** the migration. |
| `scripts/schema-baseline/baseline_to_restorable.py` | Developer tool: builds a local prod-shaped database from the baseline (§4). |
| `schema-baseline-input/vNN/` (git-ignored) | Step working folder. **Schema dumps only, never table data.** |
| `C:\Users\makas\flash-secrets\backups\` | Full backups (§6). Outside the repo. |

**Header** (every migration file starts with it):
```
-- flash-migration: v42
-- name: schema_migrations_ledger
-- issue: #71
-- before-schema-sha256: <BEFORE fingerprint>
-- after-schema-sha256: <AFTER fingerprint>
```

## 3. Fingerprints and the file hash

- **Schema fingerprint** = sha256 of the bytes of `normalize_schema.py --baseline <dump>`. The dump is a `prod_dump_schema.sh` dump (schema-only, public, `--no-owner --no-privileges`). That is exactly the committed baseline's format.
  - **BEFORE:** production must match it before step D (checked in A and again just before applying).
  - **AFTER:** production must match it in step E. It must **also equal sha256 of the committed baseline**: CI checks this for the latest migration, and step E checks it again.
  - Consecutive migrations chain: v(n+1).BEFORE = v(n).AFTER (CI checks this).
  - No git ref (`main~1` etc.) is ever used to decide what production should look like. The header is the authority.
- **File hash (`file_sha`)** = lowercase hex sha256 over the file's **exact bytes**. `.gitattributes` forces LF for `backend/src/db/migrations/**`, so every OS sees the same bytes.
  - Production runner: PowerShell `Get-FileHash` (`Get-FlashFileSha256`), passed as `psql -v file_sha=…`. `apply_migration.sh` re-checks it with `sha256sum` inside the container before psql runs.
  - Fresh/CI: Node `crypto` in `migrationFile.js`, substituted for the file's single `:'file_sha'` placeholder as a quoted literal, exactly as psql does.
  - The file uses the variable **once**, `SET LOCAL flash.file_sha = :'file_sha';`. Every later statement reads `current_setting('flash.file_sha')`, because psql never substitutes inside `$$` blocks.
  - **Proven identical:** unit tests compare Node with GNU `sha256sum`, with the PowerShell module, and with `SHA256SUMS`. The integration test applies the file through psql exactly as step D does and checks the ledger row Node wrote. A wrong `file_sha` and a missing `file_sha` are both refused.

### Why some checks compare *changes*, not hashes
Restoring a dump and dumping it again **re-spells two CHECK constraints** on the production-only settlement tables. Postgres prints the restored `= ANY ((ARRAY[...])::text[])` as `= ANY (ARRAY[(...)::text, ...])`. Same meaning, different bytes (found and proven during L0.2). So a local copy of production never has production's fingerprint.

The rule that follows:
- Checks **on production** (A, D's re-check, E) compare **fingerprints**.
- Checks **on local copies** compare **like with like**:
  - step C compares the restored backup with step A's dump restored the same way;
  - step D's rehearsal checks that the copy's *change* (before → after) equals BEFORE → AFTER (`schema_delta.py same-delta`), and that the rollback returns the copy exactly to its start.

## 4. Writing a migration (developer)

1. Write `vNN_<name>.sql` from v42's pattern:
   - `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; SET LOCAL flash.file_sha = :'file_sha';`
   - guarded DDL (`to_regclass` / `pg_attribute` / `pg_constraint`, never `information_schema` or `pg_get_expr`, which lock tables; see `SCHEMA_BASELINE.md` §9);
   - an unexpected shape **raises** (it does not silently skip);
   - last, the ledger insert plus the "different sha256 → `RAISE EXCEPTION`" check.

   Then write its `rollback/…rollback.sql`.
   **Guards check the schema, never data.** Step D's rehearsal restores a **schema-only** dump, where every table, the ledger included, is empty. A guard such as "refuse unless the ledger has a v43 row" therefore fails in every rehearsal. Check a schema fact instead: v44 checks RLS on `schema_migrations_ledger`, which is v43's visible effect.
2. Add `migrateVNN` to `migrate.js`: one line calling `applyMigrationFile`. Move `pool.end()` to it.
3. **Compute AFTER** (all local, throwaway containers):
   `baseline_to_restorable.py <baseline>` → a local prod-shaped DB (its re-dump differs from the baseline only by the §3 re-spelling) → `rehearse.sh` → `schema_delta.py apply <baseline> rehearsal_before rehearsal_after_1` → the new baseline → its sha256 = AFTER; the old baseline's sha256 = BEFORE.
4. Commit the new baseline, put both fingerprints in the header, and regenerate `SHA256SUMS` (`sha256sum vNN_*.sql rollback/*.sql`).
5. Run `npm test` (unit and integration, local DB) and `bash scripts/schema-baseline/schema_check.sh`.
6. The PR description states:
   - at the top, **"Schema change: vNN, applied by the founder through steps A–E after merge"**;
   - the file's sha256 and the rollback's sha256 (step D asks for them);
   - BEFORE and AFTER;
   - the exact change (`schema_delta.py show`), the locks taken, and the deploy-order note.
7. Get the second review (§1.2) before step D.

## 5. Founder runbook (PowerShell, from the repo root, Docker Desktop running)

Every script that touches production asks for the **Session pooler** connection string with `Read-Host -AsSecureString`, inside the script. It never prints the string, passes it to Docker by name only, and clears it at the end, even on failure. Step C never asks for it.

Before step A: `git checkout main` and `git pull`. Step D refuses otherwise.

```powershell
# A. Read-only: server check, schema dump, ledger. Production must equal BEFORE.
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\A-ReadOnlyChecks.ps1 -Migration v42

# B. Read-only: full backup of public (schema + data) to C:\Users\makas\flash-secrets\backups\
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\B-Backup.ps1 -Migration v42

# C. Local only: restore the backup in a no-network container, row counts, schema == step A's. Type "yes" if counts look right.
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\C-VerifyBackup.ps1 -Migration v42 -Backup "C:\Users\makas\flash-secrets\backups\flash_public_<stamp>_pre-v42.dump"

#    -> second review of the SQL (link it in the PR)

# D. THE ONLY WRITE. Pre-checks, local rehearsal, typed confirmation "APPLY v42", re-check, apply.
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\D-Apply.ps1 -Migration v42 -Backup "C:\Users\makas\flash-secrets\backups\flash_public_<stamp>_pre-v42.dump"

# E. Read-only: production == AFTER == committed baseline; ledger row sha == file sha. Paste the summary into the PR.
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\E-Verify.ps1 -Migration v42
```

**What step D checks, in order** (it stops at the first failure):
1. **Git:**
   - no tracked changes;
   - no untracked files under `backend/src/db/migrations` or `scripts/`;
   - on `main`;
   - local `main` == `origin/main` after a fetch;
   - the file is tracked.

   (Unrelated untracked files, such as the store portal's local `.env`, don't block it.)
2. **File hash:** sha256 == `SHA256SUMS` == the value you paste from the merged PR.
3. **Second review:** you paste the link.
4. **Earlier steps:**
   - step A passed less than 12 h ago, on this file, with the BEFORE fingerprint;
   - the backup is unchanged since step C;
   - step C verified it less than 24 h ago, against step A's schema.
5. **Rehearsal** on step A's dump, in a no-network container:
   - the change equals BEFORE → AFTER;
   - a second apply is a no-op;
   - a wrong `file_sha` is refused and changes nothing;
   - the rollback returns to the start.
6. **Confirmation:** outside 06:45–19:45 SAST, type `OUTSIDE WINDOW`; then type `APPLY v42`.
7. **Production, just before applying:**
   - the server check;
   - production **still** equals BEFORE;
   - then `apply_migration.sh` re-checks the sha inside the container and applies it in one transaction.

**If step D fails at apply time:** `--single-transaction` plus `ON_ERROR_STOP` means **nothing was applied**. Send the error text; it contains no secrets.

**Docker Desktop hang (handled automatically).** Docker Desktop on Windows can leave a *finished* container "running" with no process inside, so an attached `docker run` never returns. That happened twice in about 40 container runs during L0.2's local proof. The scripts therefore never wait on an attached `docker run`. `Invoke-FlashContainer` instead:
- starts each container detached, inside `run.sh`, which prints `FLASH_EXIT=<code>`;
- polls it until it stops, or until it has shown no process for 10 seconds;
- takes the exit code from the marker line;
- always removes the container.

A step therefore shows a container's output when it finishes, not live. If the marker is missing, the step **fails**; it never guesses. `Clear-FlashProdUrl` also removes any leftover `flash-step-*` container, because a container holds the passed connection string in its config until it's removed.

**If step D's apply fails or is interrupted:** `--single-transaction` means it either committed or rolled back as a whole, never half. **Run step E: it reads production and tells you which.**

**If step E fails:** stop. Don't deploy code that depends on the change. Report the output, then decide (§7).

**v44: the check after step E.** Run `R-RlsReadiness.ps1 -BackendRole postgres` (**without** `-PostV43`, which is v43-specific and expects 67 tables). It should show:
- `summary|tables=68|exempt=68|not_exempt=0|rls_enabled=68|tables_with_anon_or_auth_privs=0` and `verdict|OK`;
- `table|feature_switches|postgres|t|f|t|t|0|0`.

Then the advisor: no ERROR or WARN, and INFO `rls_enabled_no_policy` on **68** tables (expected). The 8 seed rows are data, so the fingerprint can't see them. v44 checks them inside its own transaction.

**v43 only: the check after step E.** The fingerprints compare `pg_dump --no-privileges` dumps. They see v43's 67 `ENABLE ROW LEVEL SECURITY` statements, but **not** its `REVOKE`s or default-privilege changes, so A–E alone can't verify half of v43. After step E passes, run (read-only):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\R-RlsReadiness.ps1 -BackendRole postgres -PostV43
```
It **passes only if** all of these hold:
- `rls_enabled=67` (and `tables=67`);
- `tables_with_anon_or_auth_privs=0`;
- no sequence or function in `public` is granted to `anon`/`authenticated`;
- `postgres`'s default ACLs no longer mention `anon`/`authenticated`;
- the verdict is OK (the backend role keeps access to every table).

`supabase_admin`'s default ACLs are printed as an accepted gap and aren't checked. Then **the security advisor (rule 10):**
- expect both `pg_graphql_anon_table_exposed` and `pg_graphql_authenticated_table_exposed` to go from 67 to **0**;
- expect **`rls_enabled_no_policy` (INFO) on all 67 tables**. That is intended: RLS on with no policy means deny-all for every role that doesn't bypass RLS. The backend role (`postgres`, BYPASSRLS, owner) is unaffected.
- Any new ERROR or WARN means step E failed.

## 6. Backups

- **Location:** `C:\Users\makas\flash-secrets\backups\` by default (`-BackupDir` to change it). Step B refuses a folder inside the repo.
- **Contents:** each file is `flash_public_<yyyyMMdd_HHmmss>_pre-vNN.dump` (custom format, the public schema's schema **and data**), with a `.sha256` file next to it and, after step C, a `.verified` file.
- **What's covered:** every Flash table lives in `public`. Supabase's own schemas (auth, storage) aren't used by Flash and are covered by Supabase's backups.
- **Retention:** keep the **newest 5**, and keep every **pre-migration backup for at least 30 days**. Step B lists older files and deletes them **only if you type `DELETE`**.
- **They contain customer data.** Any copy that leaves this laptop must be **encrypted first**: 7-Zip, AES-256, "encrypt file names" on, the password stored in the password manager. Never email one, and never put one in the repo or in chat.
- **Supabase backups: none.** The founder confirmed in the dashboard on 2026-11-21 that the **free plan has no backups**. **Step B is the only backup Flash has**, so it stays mandatory for every migration. Before launch, the founder decides between Supabase Pro (7 days of daily backups) and our own encrypted daily backup (`LAUNCH_INFRA_CHECKLIST.md` L-9).

## 7. Rollback

Rollback happens only on your explicit decision, for example when step E fails, or when the change itself turns out wrong after it's applied. It runs the same steps with `-Rollback`:
- **A:** production must equal AFTER, and the ledger must record vNN.
- **B and C:** a fresh backup, verified.
- **D:** applies `rollback/vNN_*.rollback.sql`. The rehearsal checks that the rollback's change equals AFTER → BEFORE. Paste the rollback file's sha from the PR.
- **E:** production must equal BEFORE, and the ledger no longer records vNN.

Then revert the migration PR, so the committed baseline matches production again.

**Last resort:** restore from the step B backup. That procedure is deliberately not scripted. Restoring over live production loses every write since the backup, so it's a decision for the moment, with Supabase support if needed.

**v42's rollback** drops the ledger table. It refuses if the ledger records any later migration.

## 8. What is and isn't proven (L0.2, 2026-11-20)

**Proven locally** (PR #72 verification), on throwaway containers only:
- A local database built from the committed baseline, standing in for production on an `--internal` Docker network with no route out. **Every container script** ran against it: server check, dump, ledger read, backup (it refuses to overwrite), restore check, rehearsal, both apply refusals (no confirmation; wrong sha), apply, idempotent re-apply, the step E delta check, rollback, and rollback-with-nothing-to-roll-back.
- All 6 PowerShell files parse under Windows PowerShell 5.1.26100 and are ASCII-only. These ran under 5.1:
  - the module's hash and migration loader, which agree with Node and `sha256sum`;
  - the local half of step D: the rehearsal, all fingerprints, the delta checks (including a negative), and the markers;
  - `Invoke-FlashContainer`:
    - exit 0 and output captured;
    - a non-zero exit propagated, and thrown unless `-AllowFailure`;
    - env passed by name;
    - no leftover containers;
    - `Clear-FlashProdUrl` removed a simulated leftover step container.

  The Docker Desktop fault itself can't be triggered on demand, so the 10-second no-process path is exercised only when the fault occurs.

**Not run by Claude Code, and not verifiable by it:**
- The `.ps1` scripts as a whole against production. Their production parts need your interactive Session-pooler prompt, and the scripts deliberately refuse any non-pooler host.
- **The first real run of step A is therefore also the first end-to-end run of the PowerShell glue.** Step A is read-only, so that is safe. If any step errors, send the output.

## 9. Production migration history

| Version | PR | Applied by / date (SAST) | BEFORE | AFTER | Ledger sha256 |
|---|---|---|---|---|---|
| v41 | #36 | **Not applied, not needed**: proven a no-op on production's shape (`SCHEMA_BASELINE.md` §11) | `697134af…` | `697134af…` | — |
| v42 | #72 (merged, deployed `09bf0d3`) | **Applied 2026-11-21 07:55 SAST by the founder**; steps A–E all passed, verified 09:38 SAST ([step E record](https://github.com/VuyoMakasana/Flash-App/pull/72#issuecomment-7059420526); [second review](https://github.com/VuyoMakasana/Flash-App/pull/72#issuecomment-7047079722)) | `697134af…2a6962d` | `4355621a…951cd3` (73,021 bytes, 67 tables) | `b4dd4c84…df55fd` = file sha; ledger `applied_at 2026-11-21 05:55:45 UTC` |

**v42 details (from the step E record):**
- **Backup (step B):** `flash_public_20261121_074206_pre-v42.dump`, sha256 `f8d8b5a3e177e400269ef9ec8eec3ea7413758be0a34d122d60abe12c1355a93`, verified by step C.
- **Security advisor (rule 10), 2026-11-21 07:56 SAST:**
  - **no ERRORs**;
  - `pg_graphql_anon_table_exposed` and `pg_graphql_authenticated_table_exposed` each went from **66 to 67**.
- **Why the +1:** the new `schema_migrations_ledger` table inherited `postgres`'s default privileges, which grant `anon`/`authenticated` on every new table. v42 predates rule 9. It isn't reachable externally (the Data API is disabled), and the table holds only migration names and hashes.
- **Accepted by the founder, not rolled back.** v43 must cover all 67 tables, `schema_migrations_ledger` included, and alter `postgres`'s default privileges (FI-081).

| v43 | #80 (merged `5ce588d`) | **Applied 2026-11-21 11:09 SAST by the founder**; steps A–E and the `-PostV43` check all passed, verified 11:12 SAST ([step E record](https://github.com/VuyoMakasana/Flash-App/pull/80#issuecomment-7060545953); [second review](https://github.com/VuyoMakasana/Flash-App/pull/80#issuecomment-7060172358)) | `4355621a…951cd3` | `689f03b4…5cf113` (77,270 bytes, 67 tables) | `4c26cb102bf3f30d2ea6d8c7f1d83ee6c79d1835a80e268a021b4b115eb11689` = file sha; ledger `applied_at 2026-11-21 09:09:52 UTC` |

**v43 details (from the step E record):**
- **Backup (step B):** `flash_public_20261121_105627_pre-v43.dump`, sha256 `eeba74694b79d192a4b376366fd2ca2b37e6bf30b3259b7829b92e2995273f73`, verified by step C.
- **Post-check (`R-RlsReadiness.ps1 -PostV43`): PASSED.** `tables=67`, `rls_enabled=67`, `tables_with_anon_or_auth_privs=0`; `postgres`'s default ACLs list only `postgres` and `service_role`; verdict OK.
- **Remaining, accepted gap:** `supabase_admin`'s default ACLs still list `anon`/`authenticated`. They only apply to objects `supabase_admin` creates; Flash's tables are created by `postgres`.
- **Security advisor (rule 10), 2026-11-21 11:10 SAST:**
  - **no ERRORs**;
  - `pg_graphql_anon_table_exposed` and `pg_graphql_authenticated_table_exposed` both went from **67 to 0**;
  - INFO `rls_enabled_no_policy` on 67 tables, as expected: only the backend role, which bypasses RLS, can read or write.
- **Live check (Render logs), 11:15–11:20 SAST:**
  - `GET /api/inventory` returned 200;
  - the startup catch-up jobs (`prune-driver-locations`, `prune-browsing-events`, `purge-expired-tokens`, `morning-release`, `wallet-and-refund-reconciliation`) and the 11:20 scheduled jobs all finished;
  - no permission or row-level security errors.

| v44 | #85 (merged `aae101a`) | **Applied 2026-11-21 14:17 SAST by the founder**; steps A–E and the v44 readiness check passed, verified 14:19 SAST ([step E record](https://github.com/VuyoMakasana/Flash-App/pull/85#issuecomment-7063019801); [second review](https://github.com/VuyoMakasana/Flash-App/pull/85#issuecomment-7062314292)) | `689f03b4…5cf113` | `83a42d48…f9ceb001` (77,854 bytes, 68 tables) | `332926f437bf11a68f36b59810ff1f9881b1e6808ebffebfba22c6332c74d68c` = file sha; ledger `applied_at 2026-11-21 12:17:31 UTC` |

**v44 details (from the step E record):**
- **Backup (step B):** `flash_public_20261121_140851_pre-v44.dump`, sha256 `94563bd59daf5f30e690fe7a72a17317202c3740f038d685ee466a78e717de30`, verified by step C.
- **Readiness (`R-RlsReadiness.ps1 -BackendRole postgres`):** `tables=68`, `rls_enabled=68`, `tables_with_anon_or_auth_privs=0`; `postgres`'s default ACLs list only `postgres` and `service_role`; verdict OK.
- **Security advisor (rule 10), 2026-11-21 15:04 SAST:** no ERRORs; no WARNs; INFO `rls_enabled_no_policy` on **68** tables (was 67; the +1 is `feature_switches`, expected).
- **No code reads the table yet;** that's L0.5b. The seed values on production are the v44 defaults: on for `card_payments`, `new_orders`, `cash_orders`, `store_portal_writes` and `signups`; off for `driver_payouts`, `premium` and `boosts`.
