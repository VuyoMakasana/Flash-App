# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Flash — a two-sided same-day clothing delivery marketplace for South Africa. Three independent apps in one repo:

- `backend/` — Node.js/Express + PostgreSQL API. Business logic, payments, Socket.io real-time events.
- `flash-user-app/` — React Native (Expo, classic navigation) customer app.
- `flash-driver-app/` — React Native (Expo Router) driver app.

`README.md` and `HOW_TO_RUN.md` are historical build logs (each numbered "FIX"/"v2"/"v3" section documents a past patch round) — useful for endpoint/socket-event lists and setup steps, but **treat specifics (env var names, order-status lists, auth model) as possibly stale**. The code below reflects the current state as of the latest audit-fix commits; when in doubt, read the source over the docs.

## Commands

### Backend (`backend/`)
```bash
npm run dev              # nodemon server.js — local dev
npm start                # node server.js — plain start
npm run migrate          # node src/db/migrate.js — idempotent, safe to re-run (CREATE TABLE IF NOT EXISTS)
npm test                 # jest --runInBand (unit + integration)
npm test -- --testPathPattern=tests/unit path/to/file.test.js   # single test file
npm run test:integration # jest --runInBand tests/integration
npm run start:prod       # pm2 start ecosystem.config.js --env production (VPS/self-host only; Render uses `node server.js` directly)
npm run logs             # pm2 logs flash-backend
```
No lint script exists for the backend.

Unit tests auto-mock `src/config/database` via `jest.config.js`'s `moduleNameMapper` → `tests/__mocks__/database.js` (a jest-mocked pg Pool). Integration tests hit a real Postgres (CI spins up `postgres:15`, `DATABASE_URL` points at it). Coverage thresholds are enforced: 60% branches / 70% functions / lines / statements — CI fails below these.

Docker stack (Postgres + Redis + backend):
```bash
docker compose up -d --build
docker compose exec backend node src/db/migrate.js
```
Or from repo root: `powershell -ExecutionPolicy Bypass -File .\scripts\ensure-docker.ps1 [-RunMigrations] [-SkipBuild]`.

### Mobile apps (`flash-user-app/`, `flash-driver-app/`)
```bash
npx expo start --clear               # user app (default port)
npx expo start --clear --port 8082   # driver app — must use a different port than the user app
expo lint                            # driver app only; user app has no lint script
```
Both apps read `EXPO_PUBLIC_API_BASE_URL` at runtime to reach the backend — set it in the shell before `expo start` rather than editing `services/api.js`.

### One-command dev startup (repo root, Windows/PowerShell)
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-dev.ps1 [-UseMockBackend]
```
Starts backend + both Expo apps in separate windows. `-UseMockBackend` runs `backend/mock-server.js` (a standalone fake-data server, no Postgres needed) instead of the Docker/Postgres backend.

### CI (`.github/workflows/ci.yml`)
Three jobs on push/PR to `main`: backend lint & test (Postgres service container, runs migration then unit then integration tests, uploads coverage), mobile dependency check (`npm ci --ignore-scripts` for both apps), and a TruffleHog secrets scan against the diff from the default branch.

## Backend architecture

Layout: `routes/` → `controllers/` → `models/` (thin DB-query wrappers) / `services/` (business logic), plus `middleware/`, `socket/`, `db/`.

**Entry points**: `backend/server.js` is a thin wrapper used by `npm start`/Docker; the real app factory is `backend/src/server.js`, which exports `createApp()` (used by tests/mock-server) and `startServer()` (used when run directly). It wires Express, Socket.io, Redis adapter (optional), cron jobs, and graceful shutdown (drains the pg pool on SIGTERM/SIGINT with a 10s force-exit timeout).

**Auth model**: JWT access tokens are short-lived (15 min, `JWT_EXPIRES_IN`). There's a refresh-token flow (`refresh_tokens` table) and a revocation list (`revoked_tokens` table, keyed by JWT `jti`) checked on every authenticated request in `middleware/auth.js` — this is *not* documented in README/HOW_TO_RUN, which still describe a single long-lived token. `requireApprovedDriver` middleware gates driver-only routes and returns role-specific messages for `pending_documents` / `documents_submitted` / `under_review` / `rejected` / `suspended` states.

**Order state machine** (`src/services/orderStateMachineService.js`) is the source of truth for order lifecycle — do not update `orders.status` directly in new code. It defines `ORDER_STATES` and `ALLOWED_TRANSITIONS` (a stricter/larger set than `src/utils/constants.js`'s `VALID_ORDER_STATUS_TRANSITIONS`, which is a legacy leftover only covering the driver-facing subset). Current full state list:
```
created → payment_pending → paid → (scheduled_for_morning |) waiting_for_driver → driver_assigned → driver_arrived_store → picked_up → in_transit → delivered → completed
                                                                                                                                              (any pre-pickup state can go → cancelled)
```
`en_route` is a legacy status name normalized to `driver_arrived_store` via `LEGACY_STATE_MAP` — expect it in old data, never write it. `updateOrderStatus()` and `assignDriver()` both run inside a transaction with `SELECT ... FOR UPDATE` to avoid races (e.g. two drivers accepting the same order), emit Socket.io events (`order:<id>` and `user:<id>` rooms), and trigger push notifications via `notificationService`. Driver payouts are staged through `DriverWallet` (pending on assignment → released on completion) rather than paid out immediately.

**Cron jobs** (registered in `src/server.js`, all wrapped in try/catch so one failing job doesn't crash the process):
- Daily 03:00 SAST — prune `driver_locations` older than 30 days.
- Daily 03:30 SAST — prune `browsing_events` older than 60 days.
- Every 5 min — `paymentReconciliationJob.reconcilePendingPayments` (catches payments stuck pending after a webhook was missed).
- Daily 01:30 UTC (03:30 SAST) — purge expired `refresh_tokens`/`revoked_tokens`.
- Daily 05:00 UTC (07:00 SAST, store open time) — release orders parked in `scheduled_for_morning` into `waiting_for_driver`.
- Every 10 min — reassign orders stuck in `driver_assigned`/`driver_arrived_store` for >45 min; increments the driver's `cancel_count` and auto-suspends at 5.
- Every 15 min — auto-cancel + refund orders stuck in `waiting_for_driver` (paid, no driver) for >30 min.

**Webhooks** (`src/routes/webhookRoutes.js`, mounted *before* the global `express.json()` body parser in `src/server.js` because Paystack signature verification needs the raw body): Paystack (HMAC-SHA512 signature check) and Payflex, each with their own body-parsing strategy.

**Payments**: Paystack is called via raw REST calls (`services/paystackService.js`), not an SDK. `PAYMENT_METHOD_ENCRYPTION_KEY` (separate from `JWT_SECRET` by design, per `.env.example` — so rotating the JWT secret doesn't break decryption of stored card auth codes) encrypts saved card data via `utils/paymentCrypto.js`. Refunds go through `services/refundService.js`, payouts through `services/payoutService.js` + `DriverWallet`.

**Validation**: `middleware/validation.js` exports `validate(validations)` (wraps express-validator chains), `validateId` (UUID-format check — use as a route middleware, not called directly as a function), and `validatePagination`.

**Testing DB isolation**: unit tests never touch Postgres (module is mocked); only `tests/integration/*` need a live `DATABASE_URL`. When adding a new model/service test, check whether an existing unit test file already mocks the pattern you need before writing new mock plumbing.

## Mobile apps

Both apps are Expo SDK 56 / React Native 0.85 / React 19. `flash-user-app` uses classic React Navigation (stack + bottom tabs, screens in `screens/`); `flash-driver-app` uses `expo-router` (file-based routing under `app/`, with `app/auth/*` and `app/driver/*` route groups and an auth-guard in `app/_layout.js` that redirects to login when no token is stored).

State: each app has one global context (`flash-user-app/context/FlashContext.js`, `flash-driver-app/context/DriverContext.js`) holding auth/session state, and for the user app, cart/product data (falls back to demo products if `/api/inventory` is unreachable). All backend calls are centralized in each app's `services/api.js` — that's the file to touch when changing API base URL logic or adding an endpoint wrapper, not individual screens.

Real-time: both apps hold a `socket.io-client` connection authenticated via `socket.handshake.auth.token`. Driver location pings are sent frequently client-side but the backend only persists history every 5th ping (~15s) to limit DB load — don't assume every emitted ping is stored.


---

# Flash Engineering Rules

## Core Principles

Flash is a real production startup.

Every decision must prioritize:

1. Reliability
2. Security
3. Maintainability
4. Scalability
5. Performance
6. Simplicity

Never sacrifice long-term quality for short-term convenience.

---

# How You Should Work

Before modifying any code:

1. Read every relevant file.
2. Understand the existing implementation.
3. Explain your understanding.
4. Explain the root cause of the issue.
5. Explain every file that will be changed.
6. Explain why each change is necessary.
7. Wait for my approval before making architectural changes.

Never make assumptions.

If something is unclear, ask me.

---

# Editing Rules

Never rewrite working code unless there is a clear technical reason.

Never refactor large sections simply because they can be improved.

Respect the existing architecture.

Keep changes as small as possible.

Only touch files directly related to the requested task.

Do not rename files, folders, variables, functions, or components unless absolutely necessary.

Avoid introducing unnecessary abstractions.

---

# Before Writing Code

Always check:

- existing services
- existing utilities
- existing components
- existing hooks
- existing middleware
- existing database models

Reuse existing code whenever possible.

Avoid duplicate logic.

---

# Debugging

Never guess.

Find the actual root cause.

If multiple possible causes exist:

List them.

Rank them by probability.

Explain how you verified each one.

Only implement a fix after identifying the actual cause.

---

# Security

Security has the highest priority.

Never:

- expose secrets
- log sensitive data
- disable validation
- bypass authentication
- bypass authorization
- weaken security for convenience

Always validate:

- input
- permissions
- authentication
- database operations

---

# Database

Never modify the database schema without checking:

- migrations
- foreign keys
- indexes
- relationships
- existing production data

Never delete data unless explicitly requested.

Never drop tables.

Never perform destructive migrations without explaining the consequences.

---

# API Rules

Maintain backwards compatibility whenever possible.

Never break an existing endpoint unless requested.

Document:

- request changes
- response changes
- database changes

---

# React Native

Keep screens focused on UI.

Move business logic into:

- hooks
- services
- utilities

Avoid putting large logic blocks inside screen components.

Prefer reusable components.

---

# Backend

Business logic belongs in services.

Controllers should remain thin.

Models should focus on database access.

Avoid placing business logic inside routes.

---

# Performance

Before writing code consider:

- unnecessary database queries
- duplicate API requests
- React re-renders
- bundle size
- memory usage
- network traffic

Never optimize prematurely.

But never introduce obvious inefficiencies.

---

# Dependencies

Do not install new libraries automatically.

Before recommending a dependency explain:

- why it is needed
- alternatives
- long-term maintenance cost

Prefer existing project dependencies.

---

# Git

Before making changes:

Explain:

- files to edit
- why

After changes:

Explain:

- every file modified
- why it changed
- risks introduced

Never rewrite Git history unless explicitly requested.

Never force push.

---

# Testing

Never claim code works unless verified.

Run relevant tests whenever possible.

If tests cannot be run:

Clearly explain why.

Never fabricate successful test results.

---

# Audits

When asked to audit:

Review:

- architecture
- bugs
- performance
- scalability
- security
- accessibility
- maintainability
- duplicated logic
- race conditions
- memory leaks

Rank findings:

Critical

High

Medium

Low

Explain every finding.

Suggest production-ready fixes.

---

# Communication

Never guess.

Never invent information.

If uncertain:

Say so.

Explain technical decisions clearly.

Use concise but complete explanations.

---

# Code Quality

Prefer:

- readable code
- maintainable code
- reusable code

Avoid:

- overengineering
- clever code
- unnecessary abstractions
- deeply nested conditions

Code should be understandable six months from now.

---

# Completion Checklist

Before saying a task is complete verify:

✓ Code compiles

✓ No syntax errors

✓ Existing functionality preserved

✓ No duplicated logic introduced

✓ Security considered

✓ Performance considered

✓ Documentation updated if required

✓ Tests passed or limitations explained

---

# AI Behaviour

Do not tell me something works unless you verified it.

Do not pretend tests passed.

Do not fabricate outputs.

Do not assume files exist.

Do not assume APIs exist.

If something cannot be verified, explicitly say:

"I could not verify this."

Never hide uncertainty.

Accuracy is more important than speed.

---

# Flash Philosophy

Flash is intended to become one of the most reliable same-day delivery platforms in South Africa.

Every decision should support long-term growth, clean architecture, operational stability, and an excellent customer experience.

When choosing between a quick fix and a scalable solution, explain the trade-off instead of deciding silently.



# Approval Rules

Before performing any of these actions, stop and ask for approval:

- deleting files
- moving files
- renaming files
- changing architecture
- changing database schema
- installing packages
- upgrading dependencies
- modifying authentication
- modifying payment logic
- modifying environment variables
- modifying CI/CD
- changing deployment configuration