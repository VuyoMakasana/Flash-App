# Flash — Work Log

Newest first. One entry per merged or open piece of work: date, branch/PR, what changed, how it was verified, and anything left open. Code history is in git; this log records the **why** and the **evidence**.

---

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
