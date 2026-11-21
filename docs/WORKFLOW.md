# Flash — How Work Is Done Here (`WORKFLOW.md`)

**Who this is for:** anyone changing this repo, human or AI. Read it before the first change. It turns the rules in `CLAUDE.md` and the engineering-foundation programme into one checklist.

**Read first, in order:**
1. `docs/WORKFLOW.md` (this file)
2. `docs/PROJECT_STATE.md` (what exists, what's broken)
3. `docs/FOUND_ISSUES.md` (the open-issue register)
4. `docs/SCHEMA_BASELINE.md` (production schema and migration rules)
5. `docs/APP_STATES.md` (the standard for every money/order action)
6. `docs/WORKLOG.md` (what was done, when)

---

## 1. Absolute rules

1. **Production is off-limits to AI sessions.** No connecting to, querying, migrating, seeding or modifying the production database. No Render, Supabase or Cloudflare dashboards or APIs. No changing environment variables anywhere. Production reads are done **by the founder**, with read-only scripts written for them (`scripts/schema-baseline/prod_*.sh`).
2. **`migrate.js` is never run against production**, from anywhere, ever (`docs/SCHEMA_BASELINE.md` §6). Production gets each schema change as one standalone SQL file, applied by the founder through steps A–E in **`docs/PROD_MIGRATIONS.md`** (approved 2026-11-20, L0.2 #71).
3. **No production schema change outside `docs/PROD_MIGRATIONS.md`.** That includes the Supabase SQL editor, MCP and CLI (FOUND_ISSUES FI-061). **Every migration SQL is sent for a second review before step D** (founder rule, 2026-11-20); step D asks for the review link. **Every migration that creates a table enables RLS on it and grants nothing to `anon`/`authenticated`, and every step E records the Supabase security advisor's result** (founder rules, 2026-11-21; `PROD_MIGRATIONS.md` §1, rules 9–10).
4. **Never print secrets.** Refer to them by variable name only. When checking a URL, report only whether the host is local or remote. **The Supabase `service_role` key must never appear in the apps, the website or the repo** (founder, 2026-11-21). It bypasses RLS, and nothing in Flash needs it: the backend connects to Postgres directly.
5. **Before any command that loads env files or connects to a database, prove the database is local.** Print only host and port. If you can't prove it, don't run it; ask.
6. **Git:** never push to `main`, never force-push, never rewrite history, never delete remote branches. **The founder merges** PRs. One branch and one PR per piece of work: `foundation/<name>`, `fix/<name>`, `feat/<name>`.
7. **Minimum change.** Runtime behaviour stays the same unless the change is the point. No schema change and no new dependency without approval. Ask before deleting, moving or renaming anything.
8. **Never claim something works without running it.** If it can't be run, say "I could not verify this."
9. **Hazards that are never run:** `backend/test-db.js` and `scripts/final-verification.sh`. Both are also denied in `.claude/settings.json`.

## 2. Tools (standing rule, founder, 2026-11-19)

- Python, PowerShell or shell one-liners are fine for **reading and analysing** files, and for **editing files the current task may change**. Every such edit must appear in the PR diff.
- **Ask first** before anything that executes app code, connects to any database, installs anything, or touches files outside the task's scope.
- When a subagent or long task finishes, **report it immediately**.

## 3. The change process

1. **Read** every relevant file. Check existing services, utilities, middleware and models first, and reuse them.
2. **Explain**, in writing, before changing anything:
   - your understanding;
   - the root cause, ranked with evidence if there are several candidates;
   - every file to change, and why.
3. **Architecture decisions** go through the seven questions in `CLAUDE.md`. Business calls go to the founder.
4. **Impact analysis** before every change: what can break, who is affected, data, money, locks, deploy.
5. **Make the change** on a branch.
6. **Verify:** run the relevant tests; for schema work, run `scripts/schema-baseline/schema_check.sh` and follow `docs/PROD_MIGRATIONS.md` §4; for money/order UI, go through the `APP_STATES.md` Part 3 checklist. Print sizes and counts next to every hash or "identical" claim.
7. **Document:**
   - add a `docs/WORKLOG.md` entry;
   - add bugs found along the way to `docs/FOUND_ISSUES.md` (record them, don't fix them on the spot);
   - update any doc the change makes inaccurate.
8. **PR** using the template (summary, impact analysis, verification, docs, rollback). Wait for CI on the run's own head SHA, report, and **stop**.

**Deploy rules** (founder-confirmed from Render, 2026-11-20):
- **Backend (`Flash-App` on Render, `rootDir=backend`) auto-deploys only for commits on `main` that change something under `backend/` _and_ pass CI.** A commit that touches only docs, `.github/`, `.claude/`, the apps or the portal does **not** redeploy the backend. That is by design, not a failure. Examples: `4de9d57` (`ci.yml` only) and `abcfa49` (docs/settings only) were skipped; `9b20249` (backend) was correctly blocked by the then-failing Secrets Scan (FI-077).
- The **store portal** (a static site) redeploys on every `main` commit, within seconds.
- **Migrations are not part of any deploy.** They're manual and founder-run, and `migrate.js` is never run against production. Any PR that needs a schema change must say so at the top.
- If a GitHub check run is ever stuck `in_progress` on a backend commit (FI-079), Render will keep waiting. Check the commit's check runs first.

## 4. Money and order actions

Every change to an action that touches money, orders, OTP, payouts, refunds, returns, auth or delivery photos must follow **`docs/APP_STATES.md`**:
- three outcomes (a timeout is UNKNOWN, then re-check with the server);
- no optimistic UI;
- buttons disabled in flight;
- an idempotency key;
- the error map;
- loading / empty / error / success states with error boundaries;
- Paystack success only from the backend;
- no tokens or PII in logs.

## 5. iOS launch plan (founder, 2026-11-20) — the current programme

**This plan replaces the remaining foundation phases (§5a) until launch.** Milestone **"iOS launch"** on GitHub.

**Per-fix process, for every fix:** GitHub issue (milestone "iOS launch") → branch `launch/<id>-<name>` → impact analysis → **a failing test that proves the bug or the missing behaviour** → fix → test passes → CI green on the PR's own head SHA → PR → **STOP for approval. The founder merges.**

### Launch decisions (founder; do not re-ask, do not deviate)
1. **iOS only.** Android is out of scope.
2. **Items are Flash's own stock** (Flash Closet). No store splits and no store payouts at launch.
3. **The item is always paid by card; the delivery fee is card or cash.** The live Paystack key lives only in Render; local and CI use Paystack **test** keys only.
4. **Premium and Boosts are hidden:** UI hidden, endpoints behind flags that **default to off**. No other card flows.
5. **Driver earnings:**
   - cash delivery fee: the driver keeps 100%, with no commission debt;
   - card delivery fee: the driver's share is paid **daily by Paystack Transfer at 19:15 SAST**, one transfer per driver per day, and Flash pays the transfer fee;
   - **no withdraw button**; the driver app shows today's earnings, "paid tonight", and payout history with the transfer reference;
   - safety: `basa` recipients; Paystack account validation before the first payout; a **DB-unique constraint for one payout per driver per day**; a failed transfer retries the next evening and alerts the driver and the admin; kill switch `PAYOUTS_ENABLED`;
   - the old payout and commission-debt paths are **disabled behind flags, not deleted**; FI-010, FI-011 and FI-012 are resolved by non-use (record that on the issues).
6. **Driver plans are free for launch;** the purchase screen is hidden on iOS.
7. **Render stays on the free plan.** The founder pings `/health` every 10 minutes from 06:45 to 19:45 SAST. **Every job must run inside that window or catch up on startup.**

### Phases
| Phase | Scope | State |
|---|---|---|
| **L0** | 1. local/test isolation (#69); 2. production migration process (#71, `docs/PROD_MIGRATIONS.md`, v42 ledger); 3. cron audit + FI-014 double-registration fix + start/finish logging; 4. confirm `/health` is cheap, give the exact pinger URL; 5. kill switches `PAYOUTS_ENABLED`, `CARD_PAYMENTS_ENABLED`, `PREMIUM_ENABLED`, `BOOSTS_ENABLED` (unset = today's behaviour, except Premium and Boosts, which default to off), with tests | 1–2 done (PR #70, #72); 3 in review (#75, `docs/CRON_JOBS.md`); 4–5 next |
| **L1** | FI-016 (#46; propose the customer message), FI-013 (#43), FI-015 (#45), the startup DB timeout (FI-073), FI-018 (#47), FI-020 (#49), FI-021 (#50), FI-026 (#55) | |
| **L2** | Card checkout under the model above; webhook-verified; the cash OTP covers only the delivery fee; fix `computeCancellationSplit`; idempotency keys; a production smoke-test script | |
| **L3** | Driver earnings (decision 5) and free plans (decision 6) | |
| **L4** | App fixes: FI-019 (#48, iOS), #51, #52, #53, #54, #57, #59 (polling), status labels, rating timing, `/api/notifications`, the demo-product fallback, hiding "Pick a Driver", and `APP_STATES.md` applied fully | |
| **L5** | TestFlight and App Store readiness (**prepare only**) | |
| **L6** | Pilot verification checklist | |

### Deferred until after launch
Recorded so nothing is lost; none of these is worked on before launch unless the founder says so:
- the **Phase 5A** full app-state inventory, and the rest of **Phase 5** (characterization tests);
- **Phase 6** (CI hardening: CI Postgres 15 → 17, `schema_check.sh` in CI, the stale `production-hardening-final` trigger, pinned actions);
- **Phases 8–9** (secrets hygiene, `CLAUDE.md` rewrite, final report);
- Medium and Low FOUND_ISSUES items not named in L0–L4;
- a staging environment; the **Render paid plan**;
- multi-store payouts and splits; **Premium**; **Boosts**; **Android**.

(Phase 4's goals were delivered by L0.1; Phase 7's cron logging, kill switches and `/health` analysis moved into L0 steps 3–5.)

## 5a. Engineering-foundation programme (phases) — paused for the launch plan

Each phase has its own branch and PR, and **stops for the founder's "approved"**.

| Phase | Scope | State |
|---|---|---|
| 0 | Orientation and safety check (read-only) | Done |
| 1 | `PROJECT_STATE.md` re-audit + independent verification (Part A) | Done (PRs #34, #35) |
| 1-B | Schema baseline: fix N-18, migration v41, schema check | Done (PR #36) |
| 2 | Guardrails: `.claude/settings.json` deny rules, `WORKFLOW.md`, PR and issue templates, `WORKLOG.md`, `FOUND_ISSUES.md`, `APP_STATES.md`, "Read first" pointer in `CLAUDE.md` | Done (PR #38) |
| 3 | Branch, worktree and docs cleanup proposals; GitHub issues (with approval) | Done (PR #39) |
| 4 | Local test DB isolation: `.env.test.example`, local-host guard, seed data, `docs/TESTING.md`, `docs/ENVIRONMENT.md`. First prove docker compose and every test command use only local Postgres and get no real third-party keys. | Isolation, guard and `TESTING.md` done by L0.1 (PR #70); seed data and `ENVIRONMENT.md` deferred |
| 5 | Integration characterization tests on money and order paths (`test.failing` with issue numbers) | |
| **5A** | **App state inventory (read-only).** For every action in both apps and the portal that touches money, orders, OTP, payouts, refunds, returns, auth or delivery photos, trace button → API → backend → DB → response → screen. Record today's behaviour on success, each error type, timeout, double-tap, app backgrounded and offline (file:line), and every gap against `APP_STATES.md`, in `docs/APP_STATES_INVENTORY.md`. **No code changes.** Draft one GitHub issue per gap for founder approval. | **Added 2026-11-19** |
| 6 | CI hardening: pinned actions, `docs/CI_CD.md`, **`schema_check.sh` in CI**, **CI Postgres 15 → 17**, and **remove the stale `production-hardening-final` push trigger** in `ci.yml` (a June branch, 80 commits off `main`) | |
| 7 | Cron start/finish logging; kill switches (`PAYOUTS_ENABLED`, `CARD_PAYMENTS_ENABLED`, unset = today's behaviour); `/health` analysis; Sentry doc; `docs/RUNBOOK.md` | |
| 8 | Secrets hygiene; `docs/SECRETS.md` | |
| 9 | `CLAUDE.md` rewrite; `docs/LAUNCH_INFRA_CHECKLIST.md`; final report | |

## 6. Guardrails in `.claude/settings.json`

Project-level rules for every Claude Code session in this repo.

**Deny (never allowed):**
- force-push; pushes to `main`; remote branch deletion; history rewrites (`rebase`, `commit --amend`, `filter-branch`/`filter-repo`);
- `git reset --hard`, `git clean`, `rm -r` / `rm -rf`;
- PR merges and repo deletion;
- the two hazard scripts;
- the Supabase / Render CLIs (`supabase`, `npx supabase`, `render`) and the Supabase / Render MCP tools;
- the Read / Edit / Write tools on real `.env` files and the raw production dumps;
- **the `PowerShell` tool entirely**, so every shell command goes through Bash, where these rules apply.

**Ask (needs explicit confirmation each time):**
- **every `git push`**;
- `git branch -D`, `git restore`, `git checkout --`;
- `psql`, `pg_dump`, `pg_restore`;
- running `migrate.js` directly. That's ask, not deny, because Phase 4 runs it against local Postgres.

Deny always wins over ask and allow.

**Limits, stated honestly:**
- **Bash rules match how a command starts.** They can't stop every equivalent spelling, for example `git push origin mybranch --force` with the flag at the end, a different shell, or a wrapper script.
- **`Read(...)` rules do not block shell reads.** They govern Claude Code's Read tool only; a shell command such as `cat backend/.env` is not covered. **The real protection is that no production `.env` exists in the repo**: the founder moved `backend/.env` out, and Phase 4 recreates it pointing at local Postgres only, with no real keys. Keep it that way.
- **These rules are client-side and can be bypassed.** The server-side control is **GitHub branch protection on `main`** (require PRs, passing checks and no force-push). Turning it on is in `docs/LAUNCH_INFRA_CHECKLIST.md`.
- Rules are a backstop; §1 remains the primary control.
- Personal `.claude/settings.local.json` files may add allows, but **deny rules win**.
