# Flash — Launch Infrastructure Checklist

**Status:** started 2026-11-19 (foundation Phase 2) as a living list. Phase 9 completes and reviews it. These are **founder actions**: most are dashboard or billing settings that an AI session must not touch. Tick them only after checking them directly.

| # | Item | Why | Ref |
|---|---|---|---|
| L-1 | **Turn on GitHub branch protection for `main`**: require a PR, require passing status checks (Backend, Mobile, Store Portal, Secrets Scan), block force-pushes and deletion. | The server-side control behind the client-side rules in `.claude/settings.json`, which can be bypassed (`WORKFLOW.md` §6) | WORKFLOW.md §6 |
| L-2 | **Fix the CI Secrets Scan on `main` pushes** before relying on "deploy only after CI passes". It has failed on every push to `main` since at least 2026-10-01, so Render has deployed none of them. | FI-077 | FOUND_ISSUES.md |
| L-3 | Set Render's health-check path to `/health` (it returns 503 when the DB check fails). | FI-072 | FOUND_ISSUES.md |
| L-4 | Decide the Render plan and region: the free plan sleeps (crons miss schedules); the service is in Oregon while users are in Gqeberha. | FI-070, FI-071 | FOUND_ISSUES.md |
| L-5 | Remove or disable the Supabase MCP server in `.vscode/mcp.json` (or point it at staging), and adopt the "no production schema change outside the backup-first process" rule. | FI-001, FI-061 | SCHEMA_BASELINE.md §8 |
| L-6 | Dashboard checks from HANDOFF §3: `DRIVER_TEST_MODE=false`, a strong `CASH_OTP_SECRET`, a live Paystack key, and the remaining B3 secrets. | FI-017; HANDOFF_OCT_2026.md §3 | |
| L-7 | Protect `admin.flashdelivery.co.za` from scanning bots (IP allow-list or Cloudflare Access) and move AdminJS sessions off MemoryStore. | FI-074, FI-075 | |
