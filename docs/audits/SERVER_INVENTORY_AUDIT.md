# Flash — Server Inventory Audit (Live, Read-Only)

**Date:** 2026-09-19
**Author:** Claude Code, verified live against Render, Supabase, and Vercel APIs, plus
direct HTTP checks against public URLs and direct read-only SQL against the production
database. **No restarts, redeploys, pushes, config changes, env var changes, code
changes, or migrations were performed.** Where a check would have required any action
with a side effect, it was skipped and is noted below as not checked, with why.

**Ground rule:** every claim below cites the exact live source used to confirm it —
a specific API call, a specific URL hit with `curl`, or a specific SQL query — so this
can be independently re-checked rather than taken on faith.

---

## Headline number

# **Flash currently runs 2 servers.**

That's the honest, literal count of compute/database instances Flash operates and
configures itself, verified live: **1 backend application server** (Render) and
**1 database server** (Supabase Postgres). Everything else Flash depends on to run is
either a fully-managed serverless platform with no instance count to report (the
marketing site, on Vercel), not deployed anywhere as a running service at all
(`flash-store-portal`), a third-party managed service Flash doesn't operate (Expo's
build/push infrastructure), or genuinely does not exist yet (Redis/cache layer). Full
breakdown, with live sources, below.

---

## 1. Main backend API — Render

**What it is:** The Express/Node backend — REST API, Socket.IO real-time layer, the
AdminJS admin panel, and all cron/background jobs, all running in **one process**.

**Live and healthy right now:** Yes, confirmed twice, independently:
- `curl https://flash-app-hplc.onrender.com/health` → `HTTP 200`,
  `{"status":"ok","version":"3.0.0","checks":{"database":"ok","redis":"not_configured"}}`
  (checked 2026-09-19T21:42:33Z; this specific check had to cold-start the instance
  from Render's free-tier idle-sleep first, ~52s response time, confirming it was
  genuinely asleep, not already warm).
- `curl -I https://flash-app-hplc.onrender.com/admin-panel` → `HTTP 302` →
  `/admin-panel/login` → `HTTP 200`. AdminJS mounted correctly.

**Instances:** 1 (`numInstances: 1`, live field from `Render.get_service` /
`list_services` for service id `srv-d7bn9hidbo4c73eriu0g`).

**Plan/tier:** Free (`plan: "free"`, same API response). Note: Render's free tier
idle-sleeps after ~15 minutes with no traffic and cold-starts on the next request —
confirmed as the actual, current behavior (not a config guess) by the cold-start
observed during the health check above.

**Region:** Oregon (`region: "oregon"`, same API response).

**Source:** `Render.get_service({serviceId: "srv-d7bn9hidbo4c73eriu0g"})`, live
2026-09-19; `curl https://flash-app-hplc.onrender.com/health` and
`curl -I https://flash-app-hplc.onrender.com/admin-panel`, live 2026-09-19.

---

## 2. Database — Supabase Postgres (`flash-db`)

**What it is:** The production Postgres database — all application data.

**Live and healthy right now:** Yes. `Supabase.list_projects()` reports
`status: "ACTIVE_HEALTHY"` for project `ttupbbqbplrhhtuvaaar` (`flash-db`). Independently
confirmed by running a live, read-only query against it directly:
`SELECT count(*) FROM pg_stat_activity` → **12 current connections**, and
`SELECT setting FROM pg_settings WHERE name='max_connections'` → **60** (the connection
ceiling, matching Supabase's documented free-tier cap). Postgres version:
`17.6 (aarch64-unknown-linux-gnu)`.

**Instances:** 1 (no read replicas — `list_projects` shows a single project/database;
Supabase's own free-tier offering has no replica option to check for).

**Plan/tier:** Free — inferred from the live `max_connections=60` ceiling, which
matches Supabase's documented free-tier limit exactly (paid tiers start at a
materially higher ceiling). No separate billing-tier field was available through the
Supabase MCP tools used, so this is an inference from a live, verifiable technical
signal, not a direct "plan" field read — flagged here rather than stated as
unconditionally certain.

**Source:** `Supabase.list_projects()`, live 2026-09-19; direct SQL
(`SELECT ... FROM pg_stat_activity`, `pg_settings`) run live against project
`ttupbbqbplrhhtuvaaar`, 2026-09-19 — read-only, no writes.

---

## 3. Marketing website — Vercel (`flashdelivery.co.za`)

**What it is:** The public marketing site.

**Live and healthy right now:** Yes. `curl https://flashdelivery.co.za` →
`HTTP 200` (checked live, 2026-09-19). `www.flashdelivery.co.za` returns `307`
(redirects to the canonical domain — expected, not an error).

**Instances/plan:** Not applicable in the traditional sense — this is a serverless
static/edge deployment on Vercel's own managed platform. There is no instance count or
server plan to report the way there is for Render; Vercel handles all scaling
transparently. **This is why it is not counted in the headline "2 servers" figure
above** — it's a real, live, healthy part of Flash's infrastructure, but it isn't a
server Flash operates or configures the way the Render/Supabase instances are. Flagging
this categorization explicitly rather than silently deciding it doesn't matter.

**Project:** `flash-website-rebuild` (Vercel project id `prj_zBDeqpCz7s2Vtob610N5VtDH3Lyt`).
Latest production deployment (`dpl_9dtUof3uPPLwGPqvTu74rvPpTp8J`) status: `READY`.

**Source:** `Vercel.list_projects()` and `Vercel.get_project()` (confirmed real domain
`flashdelivery.co.za` in the project's live `domains` list) and
`Vercel.list_deployments({projectId, target: "production"})`, live 2026-09-19;
`curl https://flashdelivery.co.za`, live 2026-09-19.

---

## 4. `flash-store-portal` — not deployed anywhere

**Direct answer to the question asked:** it is **not** deployed as its own hosted
service anywhere. Verified, not assumed:
- Absent from Render's live service list (`Render.list_services()` returns 7 services
  total on this account — none named `flash-store-portal` or matching its repo/rootDir).
- Absent from Vercel's live project list (`Vercel.list_projects()` returns 4 projects —
  none named `flash-store-portal`).
- Its actual source code doesn't even exist on `main` — it lives only on the separate,
  unmerged `admin-platform` branch/worktree. `main`'s own working directory has a
  `flash-store-portal/` folder, but `git status` shows it as **entirely untracked**,
  and inspecting it directly shows it contains only a stray local Vite `dist/` build
  output (dated 2026-09-03), `node_modules/`, and a `.env` file — no `package.json`, no
  source. This is leftover local build clutter from earlier work in this session, not
  evidence of any deployment.

**Conclusion:** purely a local dev app today, on an unmerged branch. Zero live server
footprint.

**Source:** `Render.list_services()` and `Vercel.list_projects()`, live 2026-09-19
(full account listings, not a name-filtered search); `git status --short
flash-store-portal` and direct `ls` of its contents on the `main` branch, 2026-09-19.

---

## 5. `flash-user-app` and `flash-driver-app` — no server component of their own

**What they are:** React Native (Expo) mobile apps — pure clients.

**Confirmed, not assumed:** no `server.js`-style file or any backend code exists inside
either app's directory (checked directly). Both apps' `services/api.js` point at the
Render backend above via `EXPO_PUBLIC_API_BASE_URL`. Push notifications are sent
**from the Render backend** directly to Expo's own hosted push relay
(`https://exp.host/--/api/v2/push/send`, confirmed in
`backend/src/services/notificationService.js`) — Flash does not run its own push relay.
Both apps have an `eas.json`, confirming they use **EAS Build**, Expo's own managed
cloud build service — Flash does not operate a build server; this is a third-party
service, not one of Flash's own.

**Conclusion:** zero server component of their own. Any "build server" or "push relay"
involved is Expo's infrastructure, not Flash's — listed under external dependencies
below, not counted as a Flash-operated server.

**Source:** direct file search (`find` for server-like files) and `grep` for
`expo-server-sdk`/`exp.host` usage in `backend/src/services/notificationService.js`,
and presence of `eas.json` in both app directories — all read directly from the repo,
2026-09-19.

---

## 6. Background workers / cron jobs / scheduled tasks

**Where they run:** entirely **inside the main backend process** (item #1) — not as
separate deployed services. Confirmed by reading `backend/src/server.js` directly: 13
`cron.schedule(...)` calls (via the `node-cron` package), covering the documented jobs
(driver-location/browsing-event pruning, payment reconciliation, refresh-token cleanup,
scheduled-order release, stuck-order reassignment, stale-order auto-cancel, and the
newer admin-alert/escalation jobs from this session's own recent work). No separate
worker/cron entrypoint file exists anywhere in the repo (`find` for `*worker*`/`*cron*`
files outside `node_modules` returns nothing), and Render's live service list (item #1's
source) shows only one service of type `web_service` for this repo — no separate
`cron_job` or `background_worker` type Render service exists for Flash.

**Conclusion:** zero separate server footprint — these run on the same single instance
as the API, and share its single-instance risk (if that instance is down, no cron jobs
run either).

**Source:** `grep -n "cron.schedule" backend/src/server.js`, direct read, 2026-09-19;
`find` for separate worker/cron files, 2026-09-19; `Render.list_services()` (item #1),
live 2026-09-19, confirming no separate service of any type exists for this purpose.

---

## 7. Redis / cache layer — still not provisioned, re-verified live

**Direct answer:** No Redis instance exists anywhere in this account right now.
Re-verified independently via **two separate live sources**, not just re-reading a past
audit:
1. `Render.list_key_value()` → `"No Key Value instances found"` (Render's own managed
   Redis-equivalent product — none exist on this account).
2. The running backend's own `/health` endpoint (item #1's live check, this session) →
   `"redis":"not_configured"` — this is the app's own runtime state, reported live by
   the actual running process, not a static config file read.

Code that's Redis-*aware* does exist (the Socket.IO adapter and the rate limiter both
check `REDIS_URL` and fall back to single-instance/in-memory mode when it's absent —
confirmed in prior work this session by reading `server.js`/`rateLimiter.js` directly),
but no instance is provisioned anywhere for it to connect to. This matches the prior
audit's finding exactly — re-confirmed as still true today, not assumed to still be
true.

**Source:** `Render.list_key_value()`, live 2026-09-19; `curl
https://flash-app-hplc.onrender.com/health` (item #1), live 2026-09-19.

---

## 8. Any other service — full account scan, not a guess

**Render — full account listing** (`Render.list_services()`, live 2026-09-19, 7
services total): only **`Flash-App`** (item #1) belongs to Flash. The other 6 —
`School-website-2`, `institution`, `vuyo-skool` (suspended), `School-website-1`,
`School-website` (suspended), `calculator-iphone` (suspended) — are confirmed separate,
unrelated personal/client projects on the same Render account (different GitHub repos:
`School-website`, `institution`, `vuyo-skool`, `calculator-iphone` — none reference
Flash-App's repo). Explicitly excluded from Flash's count.

**Vercel — full account listing** (`Vercel.list_projects()`, live 2026-09-19, 4
projects total, no teams on this account per `Vercel.list_teams()`): only
**`flash-website-rebuild`** (item #3) belongs to Flash. `photographer`, `school-website`,
and `institution` are the same kind of unrelated personal/client projects. Explicitly
excluded.

**Supabase — full account listing** (`Supabase.list_projects()`, live 2026-09-19, 2
projects total): `flash-db` (item #2, production) and `VuyoMakasana's Project`
(`djysoxflenujmoqxttxd`) — the latter is a separate, isolated **test/scratch** Supabase
project created and used earlier this session for verifying code changes against a
real Postgres without touching production or needing Docker. It is not part of Flash's
production infrastructure and is excluded from the count, noted here for completeness
and transparency rather than silently omitted.

**Not checked, and why (per this audit's own read-only scope):** any hosting
platform/dashboard beyond Render, Vercel, and Supabase — no API/tool access exists in
this session to any other provider (AWS, GCP, Azure, Netlify, Cloudflare, etc.). If
Flash has infrastructure on a platform not listed here, this audit cannot see it and
does not claim to. Worth Vuyo confirming directly if there's any doubt.

**Source:** `Render.list_services()`, `Vercel.list_projects()`, `Vercel.list_teams()`,
`Supabase.list_projects()` — all full, unfiltered account listings, live 2026-09-19.

---

## External third-party dependencies (explicitly NOT counted as Flash's own servers)

Per the brief, these are real services Flash depends on but does not operate itself —
listed for completeness, not part of the headline number:

- **Paystack** — payment processing.
- **Cloudinary** — image storage/hosting (`CLOUDINARY_*` config confirmed present in
  `backend/.env`, live account status not checked — would require an authenticated
  dashboard/API call outside this session's tool access).
- **Resend** — transactional email (`SMTP_HOST=smtp.resend.com` in `backend/.env`).
- **Sentry** — error tracking (`SENTRY_DSN` present in `backend/.env`).
- **PostHog** — product analytics (mobile apps only; per `docs/audits/OPEN_FOLLOWUPS.md`
  and this session's own prior work, `EXPO_PUBLIC_POSTHOG_API_KEY` is unset, so no real
  events are currently being sent — the dependency exists in code but isn't active yet).
- **Expo (EAS Build + push notification relay)** — see item #5.
- **Google Maps API** — used by both mobile apps and the backend for geocoding/ETA.

None of these were checked for their own live/health status beyond confirming they're
configured — checking each would mean hitting paid third-party APIs repeatedly, which
this audit's own read-only/no-side-effects scope excludes per your instruction.

---

## Explicitly not checked, and why (side-effect risk)

- **Restarting any service to confirm it comes back up** — skipped; would be a real
  action with a side effect (briefly drops the single backend instance and every live
  Socket.IO connection to it).
- **Running any migration** to check schema state beyond what read-only `SELECT`
  queries already confirmed — not needed; nothing here required it.
- **Repeated/authenticated calls to Paystack, Cloudinary, Resend, Sentry, or PostHog's
  own APIs** to check their account status — skipped; several are metered/paid and
  hitting them repeatedly for an inventory audit isn't worth the cost or risk of
  tripping a rate limit on a real account.
- **EAS/Expo build-server status** — no EAS CLI/API access exists in this session's
  tools; confirmed from code (item #5) that Flash doesn't operate this infrastructure
  itself, but the live status of Expo's own service was not and could not be checked
  from here.

---

## Summary for Vuyo

**2 servers, both live and healthy right now:** the Render backend (`Flash-App`, 1
instance, free plan, Oregon) and the Supabase database (`flash-db`, 1 instance, free
tier, 12/60 connections in use). Both confirmed by hitting them directly, not by
reading a dashboard field and assuming. The marketing site is live and healthy too but
architecturally serverless, not a "server" in the same sense. `flash-store-portal` has
zero live footprint anywhere — it's local-only, on an unmerged branch. The mobile apps
have no server of their own. Cron jobs run inside the one backend instance, not
separately. Redis still doesn't exist anywhere, re-confirmed live via two independent
sources. No other Flash infrastructure was found on Render, Vercel, or Supabase — the
whole account on each platform was scanned, not just searched by name.
