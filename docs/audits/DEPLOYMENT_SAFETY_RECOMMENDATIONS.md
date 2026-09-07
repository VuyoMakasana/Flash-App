# Deployment Safety — Two Ready-to-Apply Render Dashboard Changes

**Date:** 2026-09-07. **Source:** production-readiness audit §2.5
(deployment/migration/release safety). **Status:** not yet applied — both
require a Render dashboard change no available tool can make safely (see
"Why this wasn't done automatically" below).

---

## 1. Auto-run migrations as part of the build, not manually

**What's true today:** Render's build command for the `Flash-App` service
is `npm install`; the start command is `node server.js`. Nothing runs
`npm run migrate` automatically. Whoever deploys a change that depends on
a new migration has to remember to run it manually, in the right order
(before the new code that needs it) — a real, easy-to-forget step, and
`migrate.js`'s own idempotent design (every migration uses
`CREATE TABLE IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`) means it's safe
to fold into the automatic build path.

**Recommended change** (Render dashboard → Flash-App service → Settings
→ Build & Deploy → Build Command):

```
npm install && npm run migrate
```

**Why build-time, not boot-time (server.js):** `migrate.js` is a
self-invoking top-level script (`migrate().catch(...)` runs immediately
on require, no `require.main === module` guard, and it opens its own
separate `pg.Pool` straight off `DATABASE_URL`) — it's designed to be run
as `node src/db/migrate.js`, not imported and called programmatically.
Wiring it into `server.js`'s own boot sequence would need a real refactor
of a script that's been stable and correct for 36 migrations, and — more
importantly — running it from application boot code means it runs **once
per instance**, not once per deploy. That's fine today at `numInstances:
1`, but the moment this service scales to more than one instance,
concurrent boot-time migration attempts would need their own
coordination (e.g. a Postgres advisory lock) to avoid racing each other.
Build-time migration sidesteps this entirely — Render's build step runs
exactly once per deploy, before any instance (old or new) starts serving
traffic, correct at 1 instance today and at any instance count later.

## 2. Wire up the existing `/health` endpoint

**What's true today:** `backend/src/server.js` already has a real,
well-built `/health` route — it checks actual Postgres connectivity
(`SELECT 1`) and Redis (correctly treating a Redis outage as
non-fatal, since caching/rate-limiting already degrade gracefully
without it elsewhere in the codebase). But Render's service config has
`healthCheckPath` set to empty — Render currently has no way to know
this endpoint exists, so it can't use it to confirm a new deploy is
actually healthy before cutting traffic over from the old instance, or
to detect and restart a hung instance later.

**Recommended change** (Render dashboard → Flash-App service → Settings
→ Health & Alerts → Health Check Path):

```
/health
```

## Why this wasn't done automatically

No tool available in this session can modify an *existing* Render
service's `buildCommand` or `healthCheckPath` — only `create_web_service`
(would create a brand-new, duplicate service) and
`update_environment_variables` (environment variables only) exist. Both
changes above are two-minute dashboard edits; applying them is safer done
directly by whoever has dashboard access than attempted blind through an
unrelated tool.
