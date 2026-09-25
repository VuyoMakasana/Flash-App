# Store Onboarding — Frontend Record (Phase 3, front half)

Companion to `STORE_PORTAL_PHASE1_RECORD.md`. The backend half
(`POST /api/store-onboarding/apply`, admin approve/reject, migration v36)
shipped in PR #12 and is live. This document covers the store-owner–facing
pages built on top of it, and what a future developer needs to know before
changing them.

---

## 1. The flow end to end

```
  Owner opens /apply  ──────────────────────────────────────────┐
         │  POST /api/store-onboarding/apply                     │
         │  (public, rate-limited 5/hour/IP)                     │
         ▼                                                       │
  stores row:      is_active = false, status = 'pending'         │  one
  store_users row: is_active = false, role = 'owner',            │  transaction
                   password_hash = bcrypt(discarded randomness)  │
         │                                                       │
         ▼                                                       ┘
  Confirmation screen — "we'll review and email you"
         │
         ▼
  Admin opens the Stores list in the AdminJS panel and runs
  the approveStore action  ──►  StoreOnboardingService.approve()
         │
         │  one transaction:
         │    stores.status      = 'approved', is_active = true
         │    store_users        = is_active true
         │    store_password_tokens ← new single-use token, 7-day expiry
         │  then, AFTER commit: sendStoreWelcomeEmail (fire-and-forget)
         ▼
  Owner receives email containing the setup code and a link to
  STORE_PORTAL_URL/set-password
         │
         ▼
  Owner opens /set-password, pastes the code, chooses a password
         │  POST /api/store-auth/reset-password   ← the EXISTING endpoint
         ▼
  store_users.password_hash updated, password_changed_at stamped,
  force_password_reset cleared, token's used_at stamped — all in one
  transaction
         │
         ▼
  Owner signs in at /login. Store is live.
```

### Files

| File | Role |
|---|---|
| `flash-store-portal/src/pages/SignupPage.jsx` | The public application form + confirmation screen |
| `flash-store-portal/src/pages/SetPasswordPage.jsx` | Step 3 — spends the invite token |
| `flash-store-portal/src/services/api.js` | `applyForStore()`, plus `fieldErrors` normalization |
| `flash-store-portal/src/App.jsx` | Routes `/apply` and `/set-password` (both public) |
| `flash-store-portal/src/pages/LoginPage.jsx` | "Apply to open a store" entry point |
| `flash-store-portal/src/index.css` | `.onboard-*` block |
| `backend/src/services/emailService.js` | Welcome email now links to `/set-password` |

---

## 2. Why the token step reuses the reset-password endpoint

`StoreOnboardingService.approve()` writes its invite into
**`store_password_tokens`** — the same table password resets use — and
`/set-password` spends it through **`POST /api/store-auth/reset-password`**,
the same endpoint `/reset-password` uses.

This is deliberate, and it is the single most important thing to understand
before changing this flow. That endpoint already:

- accepts a token only when `used_at IS NULL AND expires_at > NOW()`
- spends it inside a transaction alongside the password write, so a token
  cannot be redeemed twice even under a race
- stamps `password_changed_at` and clears `force_password_reset`
- returns **one generic message** for invalid, expired and already-used
  codes alike, so a wrong code cannot be distinguished from an expired one

A separate "accept invite" endpoint would have to re-implement all four
correctly. The only difference between an invite and a reset is the TTL:
`INVITE_TOKEN_TTL_DAYS = 7` versus 1 hour for a reset, because an invite
arrives unprompted after a review that may have taken days.

**`/set-password` and `/reset-password` are two pages over one mechanism.**
They are separate pages only because the copy differs — a newly approved
owner should not be greeted with "Set a *new* password" and a field labelled
"Reset code". If you ever need to change how tokens are validated, there is
exactly one place to do it.

---

## 3. Contract with the API

Field names are the snake_case ones `storeOnboardingRoutes.js` validates, and
are passed through untranslated so a validation error's `path` matches the
form field it belongs to:

| Field | Required | Server rule |
|---|---|---|
| `store_name` | yes | 2–200 chars |
| `owner_name` | yes | 2–200 chars |
| `owner_email` | yes | `isEmail()`, `normalizeEmail()` |
| `owner_phone` | no | ≤ 20 chars |
| `address` | no | ≤ 500 chars |

Responses the pages handle:

| Status | Body | UI behaviour |
|---|---|---|
| 201 | `{ success, message }` | Confirmation screen |
| 400 | `{ errors: [{ path, msg }] }` | Inline, per field |
| 429 | `{ error }` | Friendly "try again later", form preserved |
| 5xx | `{ error }` | "Couldn't submit", never claims success |

`services/api.js` previously threw away `body.errors` entirely, leaving pages
with only a generic string. `request()` now normalizes it to
`error.fieldErrors = { fieldName: message }`. This is additive — `message`
and `status` are unchanged for every existing caller, and a plain
`{ error }` response produces no `fieldErrors` at all.

Validation is **mirrored client-side** in `validateLocally()`. That is not
duplication for its own sake: the endpoint allows 5 applications per hour per
IP, so letting a typo consume one of an applicant's five slots is a real
cost. The server remains the authority; the local check only prevents the
obviously-invalid round trip. If you change a server rule, change `LIMITS` in
`SignupPage.jsx` to match.

---

## 4. Security properties that must not be broken

These are not style preferences. Each one is load-bearing and has a test.

**4.1 — The confirmation screen must not distinguish a duplicate email.**
The endpoint answers `201` with an *identical* message whether the
application was new or the email was already registered (its `23505`
branch), specifically so it cannot be used to test which businesses have
applied. The UI is the other half of that contract. A screen that said
"you've already applied" would hand back exactly the oracle the backend
refuses to give. Locked down by a test that renders both responses and
asserts the resulting DOM is byte-identical.

**4.2 — Nothing here may grant access before admin approval.**
`/apply` creates an inactive store and an inactive owner with a bcrypt hash
of randomness that is then discarded — unusable by anyone, including Flash,
rather than a guessable sentinel that would become a live credential the
moment the account is activated. `/set-password` can only spend a token that
approval itself minted. `authenticateStore` re-checks `is_active` on every
request, so even a valid password grants nothing while the account is off.

**4.3 — The copy must not imply the store is live.**
An application is pending review. Telling an owner otherwise sends them
looking for orders that cannot exist. Tested both positively (the
"isn't live yet" text is present) and negatively (no "your store is live"
text anywhere).

**4.4 — The setup code stays out of the URL.**
The email shows the code in its body and links to a bare `/set-password`;
the owner pastes it. A one-click magic link would be friendlier, but a
single-use credential in a query string leaks into browser history, into the
`Referer` header of any third-party request the page makes, and into the
static host's access logs. This preserves the existing flow's own choice.
**Changing it is a founder decision, not a refactor** — see §7.

---

## 5. Adversarial testing performed

| Check | Method | Result |
|---|---|---|
| Email enumeration via the form | Rendered the duplicate-email response and a new-application response; compared full DOM | **Identical** — no oracle |
| Enumeration via a status endpoint | Reviewed routes | None exists, deliberately (`storeOnboardingRoutes.js` says why) |
| Rate-limit bypass via `X-Forwarded-For` | Sent a request with a spoofed XFF, then one without, against production; compared `ratelimit-remaining` | **4 → 3 on one shared counter** — not bypassable. `app.set('trust proxy', 1)` trusts exactly one hop, so Express reads the entry Render appends, not the client's |
| Rate limit surfaced as a raw 429 | Unit test | Friendly message; form and input preserved |
| Expired token | Unit test against the 400 contract | Explains expiry + single use, gives recovery path, never claims success |
| Reused token | Unit test | Treated identically to expired — no oracle |
| Client validation used to bypass server rules | Reviewed | Impossible; server validates independently of the client |
| Token brute force | Reviewed | Token is `crypto.randomBytes(48)` = 384 bits. Infeasible. See §6 for the missing limiter |

Test counts: portal suite **8 → 30 tests**, 2 → 4 files. Backend unit suite
unchanged at **409 passing**.

---

## 6. Known gaps and residual risks

**6.1 — `/api/store-auth/reset-password` has no rate limiter.**
Token entropy (384 bits) makes brute force infeasible, so this is not
urgent, but it is the only unthrottled write in the auth surface. Worth
adding for symmetry.

**6.2 — Email squatting.** Anyone can apply using someone else's email
address. Because `store_users.email` is globally unique, that pre-empts the
real business from applying later. The controls are the 5/hour limit and the
fact that a human reviews every application before anything activates — an
admin seeing a suspicious application should reject it. Rejection
deliberately keeps the row (so the address is not silently freed), which
means a genuine business blocked this way needs an admin to intervene.
**There is currently no admin tooling to release a squatted email.**

**6.3 — Duplicate-email timing side channel.** The duplicate path does a
transaction rollback where the new path does a commit, so response times may
differ measurably. This is a backend property, not a frontend one, and
exploiting it needs many samples against a 5/hour limit. Noted, not fixed.

**6.4 — No confirmation email on application.** Email is sent only at
approval. The UI is accurate about this ("we'll email you the next steps"),
but an applicant gets nothing immediately. Deliberate — sending mail on an
unauthenticated public endpoint would make it an email-bombing vector.

**6.5 — Not verified end to end against production.** See §8.

---

## 7. Open decision for the founder

**Should the approval email carry a one-click link (`/set-password?token=…`)
instead of a code to paste?**

- *For*: materially easier, especially on a phone, which is where most South
  African SMB owners will open it.
- *Against*: puts a single-use credential in a URL — browser history,
  `Referer` headers, static-host access logs. It also makes the token
  visible to anyone with brief access to the device.
- *Middle option*: keep the paste flow, but have the page accept a token in
  the URL if present, and immediately strip it from the address bar with
  `history.replaceState`. Reduces but does not remove the exposure.

Not decided here, because it weakens a security property that is currently
intact.

---

## 8. What has NOT been verified

Stated plainly so nobody assumes otherwise:

- **No real application has been run end to end against production.** The
  live endpoint was exercised only with invalid bodies (HTTP 400), which
  create no rows — confirmed by re-querying: still 1 store, 1 store_user.
  A true end-to-end run needs a real application, an admin approval, a
  delivered email and a redeemed token.
- **The pages have not been loaded in a real browser against the live
  backend.** They are verified by unit tests (30 passing) and a production
  build (`vite build`, 81 modules, clean). Layout on a real phone is
  unconfirmed.
- **The approval → email → set-password leg is unexercised.** It depends on
  Resend delivery, which is working as of the last test but has not been
  exercised for *this* email template since it was repointed at
  `/set-password`.
- **The admin-panel Stores list has not been loaded by an authenticated
  admin.** Same caveat as the previous round: that needs admin credentials.

---

## 9. If you are changing this flow

1. Read `storeOnboardingController.js` and `storeOnboardingService.js`
   first. The frontend is the thin half; every guarantee lives server-side.
2. Do not add a "check my application status" endpoint. Keyed by an email
   the applicant already knows, it would be an enumeration oracle.
3. Do not branch the confirmation screen on anything in the response.
4. If you add a field, add it to `storeOnboardingRoutes.js`'s validator,
   `LIMITS` in `SignupPage.jsx`, and `applyForStore()` in `api.js` together.
5. If you touch token handling, change `/api/store-auth/reset-password` —
   not this page. Both flows depend on it.
