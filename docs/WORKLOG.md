# Flash — Work Log

Newest first. One entry per merged or open piece of work: date, branch/PR, what changed, how it was verified, and anything left open. Code history is in git; this log records the **why** and the **evidence**.

---

## 2026-11-19 — Phase 2: guardrails (`foundation/guardrails`)
- **Added:**
  - `docs/WORKFLOW.md`, `docs/FOUND_ISSUES.md` (67 items: condition-5 hazards, re-verified audit findings, N-1–N-21, schema-baseline items, founder-reported Render findings), `docs/APP_STATES.md` (money/order app-state standard, with today's backend and client error behaviour documented first), `docs/WORKLOG.md`;
  - PR and issue templates;
  - `.claude/settings.json` deny/ask rules;
  - a "Read first" pointer in `CLAUDE.md`.
- **Plan change:** Phase 5A (app state inventory, read-only) added after Phase 5.
- **Found while writing APP_STATES.md:** FI-059 (`validate()` uses `err.param`, undefined on express-validator 7.3.2).
- **Verification:** documentation and config only, so no runtime change. The deny rules' effect was confirmed via `/permissions`, run by the founder.

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
