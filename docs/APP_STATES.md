# Flash — App State Standard (`APP_STATES.md`)

**Status:** standard adopted 2026-11-19 (foundation Phase 2). **Nothing in the apps has been changed to meet it yet.** The per-action gap list is Phase 5A (`docs/APP_STATES_INVENTORY.md`), and fixes follow as individually approved issues.

**Applies to:** every action in `flash-user-app`, `flash-driver-app` and `flash-store-portal` that touches **money or orders**: payments, payouts, cash OTP, accept/reject/ready, cancel, refunds, returns, delivery photos, plus auth/session.

**Read with:** `docs/WORKFLOW.md` (how changes are made) and `docs/FOUND_ISSUES.md` (known gaps).

---

## Part 1 — What exists today (documented before proposing anything)

### 1.1 Backend error responses today

| Source | HTTP | Body shape | Notes |
|---|---|---|---|
| Controllers (about 400 sites) | 400 / 401 / 403 / 404 / 409 / 500 / 502 | `{ error: "<human message>" }` | `res.status(n).json({ error })` everywhere. 28 sites put `err.message` into a 400/409 body. **No 500 echoes an exception message.** |
| A few controllers / middleware | 401 / 403 | `{ error, code }` | Only 3 machine codes exist: `STORE_SUSPENDED`, `FORCE_PASSWORD_RESET_REQUIRED`, `COMMISSION_DEBT_BLOCKED` |
| `middleware/auth.js` | 401 | `{ error: "TOKEN_EXPIRED" }`, `{ error: "Invalid token" }`, `{ error: "No token provided" }` | The **enum lives in `error`**, not in a `code` field |
| `middleware/validation.js` `validate()` | 400 | `{ errors: [{ field, message }] }` | **A second shape.** `field` is `err.param`, which is **undefined on express-validator 7.3.2** (it is `err.path`), so field names are lost (FI-059) |
| `middleware/rateLimiter.js` | 429 | `{ error: "Too many …" }` | |
| `middleware/errorHandler.js` | 409 / 400 / 500 | `{ error, message }` | Maps pg `23505` → 409, `23503` → 400, `42P01` → 500. In production the default 500 body is `{ error: "Server error", message: "Internal server error" }`. Every error goes to Sentry with headers, stripped of `authorization`/`cookie` in `beforeSend` (`src/server.js` ~line 28). |
| `notFound` | 404 | `{ error: "Not found", message: "Cannot GET /x" }` | |
| `GET /health` | 200 / **503** | `{ status, version, timestamp, checks }` | **The only 503 in the codebase.** There is no "feature paused" 503 yet (kill switches are Phase 7). |
| Driver login | 403 | `{ error, status: "<driver status>" }` | A body field named `status` that is **not** the HTTP status |

**Idempotency today:** none on client requests. There is no `Idempotency-Key` handling anywhere; only the Paystack webhook is idempotent, through `webhook_events.paystack_event_id`.

### 1.2 How each client handles errors today

| Client | Timeout | Non-2xx | What the screen gets |
|---|---|---|---|
| `flash-user-app/services/api.js` | 20 s `AbortController` → throws `Error('Request timed out. Check your connection and try again.')` (`:64-74`) | `throw new Error(body.error \|\| 'Request failed')` (`:133-134`) | **A plain Error string only.** The HTTP status, `code` and `errors[]` are all **dropped**. A **timeout looks exactly like a failure.** |
| `flash-driver-app/services/api.js` | same 20 s pattern (`:56-62`) | same, plus `thrown.status = body.status` (`:124-132`), which is the driver *account* status, not the HTTP status | Same as above |
| `flash-store-portal/src/services/api.js` | **no timeout** | `Error(body.error)` with `.status` (HTTP), `.code` and `.fieldErrors` (from `errors[]`); `403 STORE_SUSPENDED` ends the session | Structured, but no timeout and no "unknown" state |
| Both apps on 401 | refresh then retry, no single-flight (FI-018); on failure `throw Error('SESSION_EXPIRED')` | | |

**Consequence:** today a lost connection during a payment, OTP confirmation, accept or cancel is shown to the user as a **failure**, inviting a blind retry, while the server may already have done it.

---

## Part 2 — The standard

### Rule 1 — Three outcomes: SUCCESS, FAILURE, UNKNOWN

Every money or order action ends in exactly one of these:

| Outcome | When | What the user sees | What the app does |
|---|---|---|---|
| **SUCCESS** | The server returned 2xx **and** the app re-fetched the resource and it shows the new state | the confirmed new state | nothing more |
| **FAILURE** | The server **answered** with a definite refusal (4xx with a message, or a known code) | the mapped message (Rule 4) plus its recovery action | the state is unchanged; the user may correct and resubmit |
| **UNKNOWN** | **Timeout, lost connection, app backgrounded or killed mid-request, 5xx, 502 or 503** | **"Checking…"**, never "failed" | **Re-fetch the real status from the server** (`GET` the order / payment / payout), then resolve to SUCCESS or FAILURE. Keep re-checking with backoff while offline. **Never** auto-retry a money action blind. |

A timeout on a money or order action is **always UNKNOWN**, never FAILURE.

### Rule 2 — The server is the only source of truth

- Show success only **after** the server confirms **and** the app re-fetches.
- **No optimistic UI** for payments, payouts, cash OTP, accept/reject/ready, cancel, refunds or returns.
- Socket events (`order_update`) are a **hint to re-fetch**, not data to render.
- **Paystack:** success only from the **backend's** confirmation (webhook or verify, reflected in the order/payment `GET`). **Never** from the checkout redirect or callback URL.

### Rule 3 — In-flight protection and idempotency

- The action's button is **disabled from tap until the outcome resolves**, including through UNKNOWN. That makes a double-tap impossible.
- **Every money action sends an `Idempotency-Key` header** (a UUID generated once per user intent, reused on every re-check or retry of that same intent). The backend stores the key with the result and returns the **same** result for a repeat. *(Backend support does not exist yet, and is an approved-issue item. Until then the client still generates and sends the key.)*
- Money actions in scope: payment init and verify, cash-on-delivery, cash OTP confirm, `markCashFailed`, payout request, refund finalize, return request, cancel, subscription and boost purchase.

### Rule 4 — The error map

Every client maps the server's response to one of these, and **never shows raw enums (`TOKEN_EXPIRED`, `pending_cash`), stack traces, `undefined`, `[object Object]` or HTTP codes**.

| Class | Detected by | User message (default; a screen may be more specific) | Recovery action | Money/order outcome |
|---|---|---|---|---|
| **Offline** | no network before sending | "You're offline. We'll try again when you're back." | queue nothing; show a retry button **for reads**; for money actions, disable until online | not sent: FAILURE (safe) |
| **Timeout / connection lost** | no response, or abort after sending | "Checking with Flash…" | **re-fetch status** (Rule 1) | **UNKNOWN** |
| **Validation** (400 / 422) | 4xx with `errors[]` or a field `code` | the field's message next to the field | the user corrects the input | FAILURE |
| **Session** (401) | 401, or `TOKEN_EXPIRED` after a refresh attempt | "Please sign in again." | one single-flight refresh, then the sign-in screen, preserving the draft | FAILURE (nothing done) |
| **Forbidden** (403) | 403 (`STORE_SUSPENDED`, `FORCE_PASSWORD_RESET_REQUIRED`, `COMMISSION_DEBT_BLOCKED`, …) | a per-code message, e.g. "This store isn't active. Contact Flash support." | per code: end the session, go to change-password, or open the debt screen | FAILURE |
| **Not found** (404) | 404 | "This item is no longer available." | refresh the list | FAILURE |
| **Conflict** (409) | 409 (e.g. already accepted, wrong state) | "This order was updated elsewhere." | **re-fetch** and show the current state | resolve by re-fetch |
| **Rate limited** (429) | 429 | "Too many attempts. Try again in a moment." | a countdown, then allow a retry | FAILURE (not done) |
| **Feature paused** (503 + code) | 503 with a `code` such as `FEATURE_PAUSED` (Phase 7 kill switches) | "Card payments are paused right now. You can pay cash." (per feature) | offer the alternative path | FAILURE (not done) |
| **Server error** (5xx, 502, 503 without a code) | 5xx | "Something went wrong on our side. Checking…" | **re-fetch status**; offer support contact | **UNKNOWN** for money/order actions |

### Rule 5 — One backend error format (proposal; a separate approved change)

Proposed shape, **additive and backwards-compatible**, because every client today reads `error`:

```json
{ "error": "Human-readable message (unchanged, still read by today's apps)",
  "code": "MACHINE_CODE",
  "fields": { "fieldName": "message" },
  "requestId": "pino req.id" }
```

Migration rules:
- `error` stays (no breaking change).
- `code` is added everywhere a client must branch, starting with the enums that today live in `error` (`TOKEN_EXPIRED`).
- `validate()` gains `fields` (fixing FI-059) while keeping `errors[]` for one release.
- `requestId` lets support match a user report to the logs.

### Rule 6 — Every screen has four states plus a boundary

`loading`, `empty`, `error` (Rule 4 message plus retry) and `success`. Each app wraps navigation stacks (React Native) or routes (portal) in an **error boundary** that shows a recovery screen, never a blank or white screen. It reports to Sentry with no PII (Rule 7).

### Rule 7 — No secrets or personal data in logs or Sentry

- **Never log or send to Sentry:** access/refresh tokens, `Authorization`/cookie headers, OTP codes (including `cash_otp_plain`), passwords or hashes, card or bank details, Paystack authorization codes, full names with phone or address, or exact live locations.
- Identify users by **id only**.
- Client crash reports scrub request bodies for money and auth endpoints.
- The backend's `beforeSend` already strips `authorization`/`cookie`. Extend that list rather than relying on each call site.

---

## Part 3 — Checklist for any PR touching a money or order action

- [ ] The outcome is SUCCESS / FAILURE / UNKNOWN, and a timeout or 5xx maps to UNKNOWN with a status re-fetch
- [ ] Success is shown only after server confirmation plus a re-fetch; no optimistic UI
- [ ] The button is disabled while in flight; an `Idempotency-Key` is sent for money actions
- [ ] Every error class in Rule 4 is mapped; no raw enum, `undefined` or stack trace can reach the screen
- [ ] The screen has loading / empty / error / success states and sits inside an error boundary
- [ ] Paystack success comes from the backend, never the redirect
- [ ] No token, OTP or PII is added to logs or Sentry
- [ ] `docs/APP_STATES_INVENTORY.md` (Phase 5A) is updated for the action touched
