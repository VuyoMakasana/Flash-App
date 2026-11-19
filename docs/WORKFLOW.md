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
2. **`migrate.js` is never run against production**, from anywhere, until the unsafe re-run statements are fixed and a backup-first process is approved (`docs/SCHEMA_BASELINE.md` §6, §8).
3. **No production schema change outside the approved process.** That includes the Supabase SQL editor, MCP and CLI (FOUND_ISSUES FI-061).
4. **Never print secrets.** Refer to them by variable name only. When checking a URL, report only whether the host is local or remote.
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
6. **Verify:** run the relevant tests; for schema work, run `scripts/schema-baseline/schema_check.sh`; for money/order UI, go through the `APP_STATES.md` Part 3 checklist. Print sizes and counts next to every hash or "identical" claim.
7. **Document:**
   - add a `docs/WORKLOG.md` entry;
   - add bugs found along the way to `docs/FOUND_ISSUES.md` (record them, don't fix them on the spot);
   - update any doc the change makes inaccurate.
8. **PR** using the template (summary, impact analysis, verification, docs, rollback). Wait for CI on the run's own head SHA, report, and **stop**.

**Deploys:** Render auto-deploys `main` **only after CI passes** (founder, 2026-11-19). Migrations are **not** part of a deploy: they're manual and founder-run. Any PR that needs a schema change must say so at the top.

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

## 5. Engineering-foundation programme (phases)

Each phase has its own branch and PR, and **stops for the founder's "approved"**.

| Phase | Scope | State |
|---|---|---|
| 0 | Orientation and safety check (read-only) | Done |
| 1 | `PROJECT_STATE.md` re-audit + independent verification (Part A) | Done (PRs #34, #35) |
| 1-B | Schema baseline: fix N-18, migration v41, schema check | Done (PR #36) |
| 2 | Guardrails: `.claude/settings.json` deny rules, `WORKFLOW.md`, PR and issue templates, `WORKLOG.md`, `FOUND_ISSUES.md`, `APP_STATES.md`, "Read first" pointer in `CLAUDE.md` | This PR |
| 3 | Branch, worktree and docs cleanup proposals; GitHub issues (with approval) | |
| 4 | Local test DB isolation: `.env.test.example`, local-host guard, seed data, `docs/TESTING.md`, `docs/ENVIRONMENT.md`. First prove docker compose and every test command use only local Postgres and get no real third-party keys. | |
| 5 | Integration characterization tests on money and order paths (`test.failing` with issue numbers) | |
| **5A** | **App state inventory (read-only).** For every action in both apps and the portal that touches money, orders, OTP, payouts, refunds, returns, auth or delivery photos, trace button → API → backend → DB → response → screen. Record today's behaviour on success, each error type, timeout, double-tap, app backgrounded and offline (file:line), and every gap against `APP_STATES.md`, in `docs/APP_STATES_INVENTORY.md`. **No code changes.** Draft one GitHub issue per gap for founder approval. | **Added 2026-11-19** |
| 6 | CI hardening: pinned actions, `docs/CI_CD.md`, **`schema_check.sh` in CI**, **CI Postgres 15 → 17** | |
| 7 | Cron start/finish logging; kill switches (`PAYOUTS_ENABLED`, `CARD_PAYMENTS_ENABLED`, unset = today's behaviour); `/health` analysis; Sentry doc; `docs/RUNBOOK.md` | |
| 8 | Secrets hygiene; `docs/SECRETS.md` | |
| 9 | `CLAUDE.md` rewrite; `docs/LAUNCH_INFRA_CHECKLIST.md`; final report | |

## 6. Guardrails in `.claude/settings.json`

Project-level **deny** rules block the most dangerous commands for every Claude Code session in this repo:
- force-push and history rewrites, pushes to `main`, remote branch deletion, PR merges;
- the two hazard scripts;
- reading or editing real `.env` files and the raw production dumps;
- the Supabase and Render MCP tools.

Running `migrate.js` directly is **ask** (it needs explicit confirmation), not deny, because Phase 4 runs it against local Postgres.

**Limits, stated honestly:**
- Bash rules match the **command prefix**. They can't stop every equivalent spelling (for example a different shell or a wrapper script).
- Rules are a backstop; the rules in §1 remain the primary control.
- Personal `.claude/settings.local.json` files may add allows, but **deny rules win**.
