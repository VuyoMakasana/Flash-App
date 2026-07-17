# Flash — Production Secrets Verification Checklist

**Date:** 2026-07-16
**Scope:** Whether five production-required backend secrets (`PAYSTACK_SECRET_KEY`, `CASH_OTP_SECRET`, `ADMIN_PASSWORD_HASH`, `ADMIN_EMAIL`, `SMTP_HOST`/`SMTP_USER`/`SMTP_PORT`/`SMTP_PASS`) are actually set with real values on the live Render backend.
**Method:** (1) One real Render log line pasted directly by the founder (`[Paystack] Initialize error: ...`, captured ~2026-07-16T19:38 UTC). (2) Live Sentry queries against the `flash-3h` org, `node` project — `errors` and `logs` datasets, 24h/30d/7d windows, both keyword and unfiltered. (3) Direct source reading of the validation logic for each var, with file:line citations, to determine what evidence *would* exist if each were missing. No Render dashboard/API/CLI access was available in this session — nothing below claims to have checked Render directly except the one pasted line.

**Bottom line: none of the five are confirmed present. One is confirmed *not a working production value* (see below), the other four are simply unknown — not because they're broken, but because nothing in this stack surfaces their failure to any tool available in this session.** This is itself a finding: these five vars can silently be wrong in production indefinitely with zero alerting.

---

## Why Sentry couldn't answer this (structural, not a search-tuning problem)

Sentry's Express integration only captures errors that reach `backend/src/middleware/errorHandler.js`'s `Sentry.captureException` — i.e. errors thrown and passed to `next(err)`, or truly unhandled ones. Confirmed live: 20/20 recent Sentry `errors` events in the last 7 days are `Not allowed by CORS` (an unhandled throw), zero are related to any of the five secrets.

Every code path below that fails on a missing secret is caught **locally** inside a controller's own `try/catch` and turned into a plain `res.status(...).json(...)` response — it never calls `next(err)`, so it structurally cannot reach Sentry. Confirmed by reading `paymentController.js` catch blocks (lines 34-36, 46-48, 403-406) and `adminController.js`'s login handler. This means Sentry will stay silent about these failures in production even if they're actively broken and being hit by real users right now.

---

## Checklist

| # | Variable | Status | Evidence |
|---|---|---|---|
| 1 | `PAYSTACK_SECRET_KEY` | ⚠️ **Confirmed NOT a working production key** — cannot distinguish *missing* vs. *set to a `sk_test_...` value* | Live Render log line: `[Paystack] CRITICAL: PAYSTACK_SECRET_KEY not configured for production. Payment processing unavailable.` This exact string fires from `backend/src/services/paystackService.js:24-28` on `!secretKey \|\| secretKey.startsWith("sk_test_")` — both conditions produce identical text, so the log alone doesn't tell us which. Real payments are broken in production either way. |
| 2 | `CASH_OTP_SECRET` | ❓ **Could not verify** | No boot-time check exists — validated lazily inside `otpSecret()` (`backend/src/services/cashOtpService.js:15-29`) only when a cash-collection OTP is actually generated/verified. A failure would throw there, get caught in `paymentController.js`'s `sendCashOtp` handler (~line 403-406), and only ever appear as a generic 400 response plus a `console.error` line in raw Render stdout — never in Sentry. Nothing in this session triggered that code path. |
| 3 | `ADMIN_PASSWORD_HASH` | ❓ **Could not verify** | Checked per login attempt, not at boot (`backend/src/controllers/adminController.js:33-43`). If missing in production, admin login returns HTTP 500 `[ERR_ADMIN_CONFIG]` and logs `[Admin Auth] CRITICAL: ADMIN_PASSWORD_HASH required in production` — never thrown, never reaches Sentry. No login attempt was made in this session. |
| 4 | `ADMIN_EMAIL` | ❓ **Could not verify** | Never validated anywhere — no required-check exists at all. If unset, `process.env.ADMIN_EMAIL` is `undefined`, so every login attempt fails the `email !== adminEmail` comparison and returns a generic 401 "Invalid credentials" — **indistinguishable from a wrong password from the outside**, and there is no distinct log line for this specific case. |
| 5 | `SMTP_HOST` / `SMTP_USER` / `SMTP_PORT` / `SMTP_PASS` | ❓ **Could not verify — and worth flagging as its own risk** | `backend/src/services/emailService.js:10-14` has **no `NODE_ENV === 'production'` check at all**. If `SMTP_HOST` or `SMTP_USER` is unset, the app silently falls into a dev-mode path that only does `console.log('[Email] DEV MODE — would send email:')` — no email is ever sent, no warning or error level log, nothing that would look abnormal in a log scan. This is the quietest possible failure mode of the five. |

---

## What only the founder can verify (Render dashboard or `render` CLI)

1. Open the backend service → **Environment** tab on Render, and confirm all five names exist with real (non-placeholder, non-`sk_test_`) values:
   `PAYSTACK_SECRET_KEY`, `CASH_OTP_SECRET`, `ADMIN_PASSWORD_HASH`, `ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.
2. For `PAYSTACK_SECRET_KEY` specifically: the dashboard will show whether it's unset vs. set to a `sk_test_...` value — something the app's own logs cannot distinguish. This determines the actual fix (add the key fresh vs. swap test for live).
3. For SMTP specifically, presence in the dashboard isn't sufficient proof it works — trigger a real registration or password-reset email and check Render's live log for `[Email] Sent to ...` (working) vs. `[Email] DEV MODE — would send email` (not configured, silently no-op in prod).
4. For `CASH_OTP_SECRET` and `ADMIN_PASSWORD_HASH`, if the dashboard confirms they're set, that's sufficient — both are used verbatim (bcrypt hash comparison / HMAC secret), so a present, non-placeholder value is safe to trust without a live trigger.

## Recommendation before enabling real payments

Until step 1 above is done, treat `PAYSTACK_SECRET_KEY` as a **known, confirmed-broken gap** — not a guess. Either add a real `sk_live_...` key on Render, or explicitly document (e.g. in a launch-readiness note) that payment initialization is a deliberate, accepted gap until go-live. Don't flip to live payments based on this checklist alone — it tells you what's *unconfirmed*, not that the other four are fine.
