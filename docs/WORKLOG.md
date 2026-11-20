# Flash — Work Log

Newest first. One entry per merged or open piece of work: date, branch/PR, what changed, how it was verified, and anything left open. Code history is in git; this log records the **why** and the **evidence**.

---

## 2026-11-20 — FI-081 raised to Critical; v43 readiness check (#73, `launch/v43-rls-readiness`)
- **Founder-reported (2026-11-20):**
  - The Supabase advisor confirmed `rls_disabled_in_public` (ERROR) on all 66 tables.
  - The founder disabled the Data API; the waitlist still works, and that warning cleared.
  - `pg_graphql_anon_table_exposed` and `pg_graphql_authenticated_table_exposed` remain, on 66 tables each.
  - No app uses supabase-js, the anon key, or REST/GraphQL.
- **FI-081 → Critical**, mitigated by the Data API being off. The fix is v43: RLS on every `public` table, revoke from `anon`/`authenticated`, default privileges. It is a **proposal under review, not written**.
- **New:** `scripts/prod-migrations/R-RlsReadiness.ps1` + `rls_readiness.sh`, a read-only check that the backend role stays exempt from RLS on every table. Verified locally only, on a prod-shaped DB with Supabase-like roles; see PR.
- **New FI-083 (High):** Supabase is in Frankfurt and Render in Oregon, so every query crosses the Atlantic. Added `LAUNCH_INFRA_CHECKLIST.md` **L-8** (move `Flash-App` to Render Frankfurt).
- **PR #72 merged and deployed** (`09bf0d3`). The founder posted the second-review comment on it. **v42 is not yet applied**; the founder runs A–E next.

## 2026-11-20 — Launch plan L0.2: production migration process (#71, PR #72, merged)
- **Process approved by the founder** with six changes. All six are implemented, and the process is documented in **`docs/PROD_MIGRATIONS.md`**:
  - BEFORE/AFTER header fingerprints;
  - the ledger hash passed as `-v file_sha`;
  - step D's git and PR-hash pre-checks;
  - PowerShell-only steps A–E through `docker run`;
  - backup location, retention and encryption;
  - a second review before step D.
- **v42 (approved):** `schema_migrations_ledger (version text PK, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`, as a standalone file. `migrateV42` only runs that file. There is a guarded rollback file.
  - Baseline: `697134af…` (66 tables) → `4355621a…` (67 tables). The change is exactly the new table and its PK.
- **v42 is NOT applied to production.** The founder applies it with steps A–E after merge.
- **Found while building it:** a restored copy of production re-spells 2 CHECK constraints (FI-082). That's why steps C and D compare like with like, or compare deltas. Also recorded FI-081 (no RLS on `public`; Supabase Data API exposure unverified; founder check).
- **WORKFLOW.md:** the launch plan, the founder decisions, the per-fix process and the deferred list are recorded; rule 3 now requires a second review.
- **Verification:** local throwaway containers only; production was never contacted. See PR #72.

## 2026-11-20 — Launch plan L0.1: local/test isolation (#69, PR #70, merged)
- **Added:**
  - A jest `setupFiles` bootstrap that refuses any run whose `DATABASE_URL` host isn't `localhost`, `127.0.0.1` or `::1` (or that matches a production marker), or that holds a **live** Paystack key.
  - `backend/.env.test.example` (`backend/.env.test` is now git-ignored; it wasn't before).
  - `docker-compose.test.yml`: Postgres 17, `127.0.0.1:55432`, tmpfs.
  - npm scripts `test:db:up` / `test:db:migrate` / `test:db:down` (the migrate helper is guarded the same way).
  - `docs/TESTING.md`.
- **Test-first:** `tests/unit/testEnvGuard.test.js` failed before the fix (`Cannot find module`) and passes after (14 tests, including jest wiring and child-process runs of the bootstrap).
- **Verified locally against Postgres 17.12 only:** migrate v1–v41 with no v41 skips; unit 637/637 (44 suites); integration 7/7 (2 suites). A full run with a remote URL, and a full run with a live key, were each refused before any test executed.
- **FI-004:** mitigated.
- **No runtime change.**

## 2026-11-20 — Phase 3: cleanup (`foundation/cleanup`)
- **Deploy diagnosis** (founder, from Render): the backend (`rootDir=backend`) auto-deploys only for `main` commits that touch `backend/` and pass CI.
  - `4de9d57` (CI only) and `abcfa49` (docs/settings only) were skipped by design.
  - `9b20249` was blocked by the old Secrets Scan failure.
  - The store portal deployed all three.
  - **My earlier top hypothesis (Render waiting on queued, zero-run check suites) was wrong**, and the founder's evidence replaced it.
  - Recorded in WORKFLOW §3 and LAUNCH L-2a.
  - New issues: FI-079 (a stuck check-run record) and FI-080 (unused GitHub apps).
- **Local branches** (List A): `git branch -d` deleted 37 of the 38 approved merged branches.
  - It refused `multi-tester-readiness`: it has 4 commits its remote lacks, all 4 already in `main`. Needs `-D`, which is a founder call.
- **Worktrees:** removed `ci-secrets-scan` and `main-adminjs-fix`, without `--force`, both clean; deleted the `status-check` branch.
  - `agent-acb9bacfac06dd01a` is waiting for the founder to move its pentest-report copy out.
  - `agent-a6598502319f8f63f` and `feature-storefront-port` are kept untouched.
- **Kept all 33 unmerged branches** (List D).
- **Docs** (List E): added `docs/audits/INDEX.md` and historical-log banners on `README.md` and `HOW_TO_RUN.md`; **no files moved**.
- **GitHub:** 8 labels to be created; 27 issues drafted for founder approval (List F).
- **Remote merged branches** (List B) are left for the founder to delete in the GitHub UI.
- **Follow-up (2026-11-20, founder-approved):**
  - The founder moved **both** pentest-report copies out of the repo. `.gitignore` now blocks `SECURITY_SELF_PENTEST_REPORT*.md`, and INDEX.md and PROJECT_STATE.md note that the report is kept outside the repo.
  - Worktree `agent-acb9bacfac06dd01a` and its branch removed, without `--force`, clean.
  - `multi-tester-readiness` deleted with `-D` after `git cherry` showed 0 outstanding commits.
- **Context recorded:**
  - A live Paystack key exists (Render env only); card payments stay OFF in the apps. FI-041 and FI-062 now read "latent until card payments are switched on in the app".
  - iOS-only launch: FI-019's Android `FOREGROUND_SERVICE` part is out of scope for launch, and FI-033's iOS external-checkout item is flagged as launch-relevant.
- **GitHub:**
  - Milestone **iOS launch** (#1) created, with no issues assigned.
  - **29 issues created (#40–#68)** with labels, verified against GitHub (29 open, 0 on a milestone, labels match exactly).
  - Issue numbers added to `FOUND_ISSUES.md`.

## 2026-11-19 — Phase 2: guardrails (`foundation/guardrails`)
- **Added:**
  - `docs/WORKFLOW.md`, `docs/FOUND_ISSUES.md` (69 items: condition-5 hazards, re-verified audit findings, N-1–N-21, schema-baseline items, founder-reported Render findings), `docs/APP_STATES.md` (money/order app-state standard, with today's backend and client error behaviour documented first), `docs/WORKLOG.md`;
  - PR and issue templates;
  - `.claude/settings.json` deny/ask rules;
  - a "Read first" pointer in `CLAUDE.md`.
- **Plan change:** Phase 5A (app state inventory, read-only) added after Phase 5.
- **Found while writing APP_STATES.md:** FI-059 (`validate()` uses `err.param`, undefined on express-validator 7.3.2).
- **Found checking why Render did not deploy PR #36:** FI-077. The CI Secrets Scan failed on **every push to `main`** (TruffleHog base == head); 8 of 8 recent `main` runs failed on that job alone. **Fixed separately in PR #37** (approved, merged first); verified on `main` push run #128 (`4de9d57`): all 4 jobs passed, Secrets Scan `commits_scanned: 2`, 0 secrets.
- **Added FI-078** (Medium): the scan's `--only-verified` lets unverifiable leaked credentials pass CI; revisit in Phase 8.
- **Started `docs/LAUNCH_INFRA_CHECKLIST.md`** (L-1 branch protection on `main`, L-2 fix the Secrets Scan, …).
- **Verification:** documentation and config only, so no runtime change.
  - Deny rules tested live, with harmless `--help` forms only: `gh pr merge`, `git rebase`, `git reset --hard`, `git clean`, `rm -rf`, `rm -r`, `supabase`, `npx supabase` and `render` were all denied.
  - The Supabase and Render MCP tools became unavailable in-session once the file was saved.
  - Ask rules not exercised.
  - **Confirmed via `/permissions` on 2026-11-19** (run and reviewed by the founder) for the rules that existed then: 43 deny, 8 ask (commit `5b39eab`). The founder also removed the local allow `Bash(git stash *)` from `.claude/settings.local.json`.
  - **Also confirmed via `/permissions` on 2026-11-19** (second check, run by the founder after the session reloaded them): the additions in `7c6c223` (every `git push` → ask; deny `git reset --hard`, `git clean`, `rm -r`/`-rf`, `supabase`, `npx supabase`, `render`; ask `git branch -D`, `git restore`, `git checkout --`, `psql`, `pg_dump`, `pg_restore`) and the `PowerShell` tool deny (`22d2acc`). Final totals: 52 deny, 16 ask.
  - **`PowerShell` tool denied entirely** (`/permissions` lists rules, not tools; the AI session confirmed it has a PowerShell tool). All shell commands now go through Bash, where the Bash rules apply.

## 2026-11-19 — Schema baseline, fix N-18 (PR #36, merged)
- Production schema baseline committed (normalized, secret-scanned).
- Migration v41 brings fresh DBs to production's definition, proven a zero-DDL no-op on production's schema.
- `scripts/schema-baseline/schema_check.sh` added.
- **v41 has NOT been run on production.**
- **Verification:** 8 local proofs plus an independent review (`docs/SCHEMA_BASELINE.md` §11); CI green on Postgres 15.
- **Open:** `migrate.js` is unsafe on production (FI-060); Supabase-tooling DDL outside review (FI-061); Phase 6 items FI-068 and FI-069.

## 2026-11-19 — Phase 1 Part A: independent verification (PR #35, merged)
- A fresh subagent re-checked 25 claims: 18 confirmed, 4 with wrong lines or timing, 3 partially correct.
- `PROJECT_STATE.md` corrected and checked against the confirmed payment model.

## 2026-11-18 — Phase 1: `PROJECT_STATE.md` (PR #34, merged) + docs PRs #16, #25 merged
- Read-only re-audit of `main`.
- PRs #16 (squatted-email proposal) and #25 (payment-model audit) merged as documents only.
