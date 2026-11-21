# Flash: scheduled jobs (`CRON_JOBS.md`)

**Status:** L0.3 (#75). **Source of truth:** `backend/src/server.js` (the `job(...)` calls) and `backend/src/jobs/cronRunner.js`. **Who this is for:** anyone changing a job or reading Render's logs. (`CLAUDE.md` still lists 7 crons; that list is stale. The `CLAUDE.md` rewrite is deferred to Phase 9.)

## The rules
1. **Registered once per process, only by `startServer()`** (`createApp({ withCronJobs: true })`). `createApp()` on its own (tests, the lazy `app` export) registers none. A second registration attempt registers nothing and logs a warning. Before L0.3, production registered every job twice (FI-014).
2. **Every run logs** `cron start`, then `cron finish` (with `durationMs`) or `cron failed` (with the error message), as JSON lines carrying `job` and `trigger` (`schedule` or `startup-catch-up`). At startup, each job logs one `cron registered` line with its expression and timezone.
3. **A job never overlaps itself.** If the previous run is still going, the tick is skipped and `cron skip: previous run still in progress` is logged.
4. **The awake window** (founder launch decision 7):
   - Render's free plan sleeps. The founder pings `/health` every 10 minutes from **06:45 to 19:45 SAST**, so only that window is guaranteed.
   - **Daily jobs are scheduled inside it, in `Africa/Johannesburg` time.** `dailySast()` refuses a slot outside the window.
   - **Startup catch-up:** if the process starts inside the window after a daily job's slot has passed today (a deploy, a restart, a late wake), that job runs once at startup.
   - **Interval jobs** (every N minutes) need no catch-up: they run whenever the process is up, including outside the window if something keeps it awake.
5. **No last-run record is persisted**, so a restart inside the window can re-run a daily job that already ran today. Every daily job below is idempotent, which is what makes that safe. If that ever stops being true, the job needs a persisted last-run row (a schema change, through `PROD_MIGRATIONS.md`).

## The jobs (16)

Before L0.3, `node-cron` ran in the server's timezone, which is **UTC on Render**. The "before" column converts that to SAST.

| Job | Before (SAST) | Now | Catch-up on startup | What it does | Re-run safe? |
|---|---|---|---|---|---|
| `prune-driver-locations` | 05:00 daily (outside the window) | **06:50 daily** | yes | delete `driver_locations` older than 30 days | yes |
| `prune-browsing-events` | 05:30 daily (outside) | **06:52 daily** | yes | delete `browsing_events` older than 60 days | yes |
| `purge-expired-tokens` | 03:30 daily (outside) | **06:54 daily** | yes | delete expired `refresh_tokens` / `revoked_tokens` | yes |
| `wallet-and-refund-reconciliation` | 04:00 daily (outside) | **06:56 daily** | yes | ledger vs `wallet_balance` for every driver; spot-check the last 20 completed refunds with Paystack; Sentry on mismatch | yes (read-only; a re-run can repeat a mismatch alert) |
| `morning-release` | 07:00 daily | 07:00 daily (unchanged instant, now explicit SAST) | **only during operating hours** (07:00–19:00) | `scheduled_for_morning` → `pending_store_acceptance` | yes (state machine; only `scheduled_for_morning` rows) |
| `payment-reconciliation` | every 5 min | every 5 min | — | stuck pending payments, stuck and missing refunds | yes |
| `escalate-acceptance-and-preparation` | every 5 min | every 5 min | — | one-time escalation emails. **The UPDATE is now the claim** (`… IS NULL RETURNING id`): only one run can send (FI-014). | yes |
| `reassign-stuck-assigned-orders` | every 10 min | every 10 min | — | requeue orders stuck >45 min in `driver_assigned` / `driver_arrived_store`; driver `cancel_count` +1; suspend at 5 | row-locked by the state machine |
| `flag-driver-connection-lost` | every 10 min | every 10 min | — | flag `picked_up` / `in_transit` orders whose driver has been silent >25 min | yes (`IS NULL` flag) |
| `flag-stuck-delivered` | every 30 min | every 30 min | — | flag orders stuck at `delivered` >2 h | yes (`IS NULL` flag) |
| `cancel-no-driver-orders` | every 15 min | every 15 min | — | cancel + refund paid orders with no driver >30 min | state machine |
| `cancel-store-acceptance-timeout` | every 15 min | every 15 min | — | cancel + refund orders unaccepted >15 min | state machine |
| `cancel-payment-never-initiated` | every 15 min | every 15 min | — | cancel abandoned `payment_pending` orders | state machine |
| `cancel-stale-preparing` | every 15 min | every 15 min | — | cancel orders stuck in `preparing` | state machine |
| `recover-stuck-paid` | every 15 min | every 15 min | — | retry `paid` → `pending_store_acceptance` | state machine |
| `sync-flagged-accounts` | every 15 min | every 15 min | — | sync cash-abuse flags into `flagged_accounts` | yes |

**Coming in L3:** the daily driver payout at 19:15 SAST (inside the window, before it closes).

## Keeping the backend awake: the external pinger (L0.4, #82)
Render's free plan puts `Flash-App` to sleep after 15 minutes without traffic, and asleep it runs no jobs. A cron-job.org job therefore calls `GET /health` every 10 minutes.

**What the endpoints do:**
- **`GET /health`** is a liveness check: `200 {"status":"ok"}`, `Cache-Control: no-store`. It does no database work and reveals nothing. It's mounted before the request logger, so pings add no log lines.
- **`GET /health/db`** is the protected deep check:
  - it needs the `X-Health-Token` header to equal the Render variable `HEALTH_CHECK_TOKEN` (constant-time comparison);
  - otherwise it returns the normal `404`, and always `404` if the variable isn't set;
  - the result is cached for 15 s;
  - it returns `{"database":"ok"|"error","latencyMs":N}`, with `503` on a database error.

### Job 1: keep-awake (one job; founder decision 2026-11-21)
| Setting | Value |
|---|---|
| URL | `https://api.flashdelivery.co.za/health` |
| Method / headers | `GET`, no headers, no body |
| Time zone | **Africa/Johannesburg** |
| Schedule | every day; hours **06–19**; minutes **05, 15, 25, 35, 45, 55** (first ping 06:05, last 19:55) |
| Timeout | **30 s** (cron-job.org's maximum, as far as known) |
| Notifications | notify **on failure**, **after 2 failures** if offered; notify **on recovery** |
| Expected | HTTP 200, body `{"status":"ok"}` |

**What the alerts mean:**
- **The 06:05 ping may fail once:** startup takes about a minute (FI-073), longer than the 30 s timeout, but the ping still wakes the server. That's why the alert waits for 2 failures.
- **A real problem** is two failures in a row during the day.
- **Check weekly:** cron-job.org can disable a job after many failures in a row.

**The awake window:** pings run from 06:05; the server sleeps about 15 minutes after the 19:55 ping, around 20:10. That covers the **06:45–19:45 SAST** window the jobs above rely on (rule 4).

### Job 2: database check (optional deep check)
| Setting | Value |
|---|---|
| URL | `https://api.flashdelivery.co.za/health/db` |
| Method / headers | `GET`, header **`X-Health-Token: <the value of HEALTH_CHECK_TOKEN in Render>`** (typed into cron-job.org only; never in the repo, docs or chat) |
| Time zone | Africa/Johannesburg |
| Schedule | every day; hours **07–19**; minutes **00, 30** (every 30 minutes, 07:00–19:30) |
| Timeout / notifications | 30 s; on failure after 2 failures; on recovery |
| Expected | HTTP 200, `{"database":"ok",...}` |

**What its results mean:**
- **`503`:** the server is up but can't reach the database.
- **`404`:** the token in cron-job.org doesn't match Render's, or `HEALTH_CHECK_TOKEN` isn't set.

### Free instance hours (Render: 750 per workspace per month)
| | Hours |
|---|---|
| Pinger: 06:05 to about 20:10 | about **14.1 h/day**, so **≤ 437 h** in a 31-day month |
| Night wakes (estimate: about 10 a night × about 16 minutes) | about **83 h** |
| **Total for `Flash-App`** | **about 520 h**, leaving about **230 h** |

- The store portal is a static site and uses no instance hours.
- **Founder check:** Render → Billing → free usage, and the list of web services in the workspace. Another free web service that stays awake (about 720 h) would exhaust the 750, and Render suspends free services for the rest of the month. I couldn't verify this from here.

## Reading the logs (Render)
- **Search `cron registered`:** there must be exactly 16 lines per boot. Two lines for the same job would mean FI-014 is back.
- **Search `cron failed`:** a job threw. The `error` field says why.
- **Search `cron skip`:** a run took longer than its own interval.
- **Search `startup-catch-up`:** daily jobs run because the process started after their slot.
