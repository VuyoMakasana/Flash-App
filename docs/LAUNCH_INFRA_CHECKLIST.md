# Flash — Launch Infrastructure Checklist

**Status:** started 2026-11-19 (foundation Phase 2) as a living list. Phase 9 completes and reviews it. These are **founder actions**: most are dashboard or billing settings that an AI session must not touch. Tick them only after checking them directly.

| # | Item | Why | Ref |
|---|---|---|---|
| L-1 | **Turn on GitHub branch protection for `main`**: require a PR, require passing status checks (Backend, Mobile, Store Portal, Secrets Scan), block force-pushes and deletion. | The server-side control behind the client-side rules in `.claude/settings.json`, which can be bypassed (`WORKFLOW.md` §6) | WORKFLOW.md §6 |
| L-2 | ✅ **Done (PR #37, 2026-11-19).** Fixed the CI Secrets Scan on `main` pushes. It had failed on every push to `main` since at least 2026-10-01, so Render deployed none of them. Verified on `main` run #128. Founder to confirm Render deployed `4de9d57`. | FI-077 | FOUND_ISSUES.md |
| L-2a | **Know the deploy rule:** the backend auto-deploys only for `main` commits that **touch `backend/` and pass CI** (`rootDir=backend`). Docs-, CI- or app-only merges do not redeploy it; the store portal redeploys on every commit. After merging a backend change, confirm Render picked it up. | Avoids mistaking "skipped by design" for a broken pipeline | WORKFLOW.md §3 |
| L-2b | Remove unused GitHub apps with repo access (Netlify, Vercel, Railway, Cursor, Expo, Sentry, Claude: keep only what's used). | FI-080 | FOUND_ISSUES.md |
| L-3 | Set Render's health-check path to `/health` (it returns 503 when the DB check fails). | FI-072 | FOUND_ISSUES.md |
| L-4 | Decide the Render plan and region: the free plan sleeps (crons miss schedules); the service is in Oregon while users are in Gqeberha. | FI-070, FI-071 | FOUND_ISSUES.md |
| L-5 | Remove or disable the Supabase MCP server in `.vscode/mcp.json` (or point it at staging), and adopt the "no production schema change outside the backup-first process" rule. | FI-001, FI-061 | SCHEMA_BASELINE.md §8 |
| L-6 | Dashboard checks from HANDOFF §3: `DRIVER_TEST_MODE=false`, a strong `CASH_OTP_SECRET`, a live Paystack key (**now exists, in Render env only**, founder 2026-11-20; card payments remain OFF in the apps until switched on), and the remaining B3 secrets. | FI-017; HANDOFF_OCT_2026.md §3 | |
| L-7 | Protect `admin.flashdelivery.co.za` from scanning bots (IP allow-list or Cloudflare Access) and move AdminJS sessions off MemoryStore. | FI-074, FI-075 | |
