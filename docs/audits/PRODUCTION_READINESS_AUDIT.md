# Flash — Production Readiness, Security & Fraud-Prevention Audit

**Date:** 2026-07-15
**Scope:** Full-codebase audit (`backend/`, `flash-user-app/`, `flash-driver-app/`, infra/CI/git history), explicitly building on — not repeating — `docs/audits/FLASH_AUDIT_REPORT.md` (2026-07-08), `ACCESS_SECURITY_AUDIT.md` (2026-07-11), `RETURNS_AND_LEGAL_AUDIT.md` (2026-07-09), and `PHASE_1_CHANGE_REPORT.md`. Every finding in those four reports was read in full before this audit began. Findings already fixed-and-verified there are treated as done and are only referenced, not re-litigated. This report's value is: (1) fresh verification of what those reports left *open*, since real time and real work has passed since they were written, and (2) genuinely new ground — fraud-specific vectors, mobile-security specifics, Socket.IO depth, database integrity, and infrastructure/secrets — that none of the four prior reports covered in full depth.
**Method:** Direct source reading with exact file:line citations for every claim, plus four parallel specialist research passes (fraud vectors, mobile security, Socket.IO + database integrity, and status re-verification of every previously-open item), each independently grepping and reading the real, current source — not relying on the prior reports' claims. Live checks were run where possible (fresh `npm audit`, a live GitHub Actions status check, a fresh full-history secret grep). Every "not verified" below is stated explicitly, not glossed over.

---

## 1. Executive Summary

Flash's security posture is genuinely stronger than a first-time audit of an app this size would typically find — this is the fourth audit pass in this engagement, and three prior passes already closed real Critical/High findings with live proof (payment idempotency, JWT-in-logs, IDOR on driver location, OAuth audience scoping, Cloudinary signed URLs, returns admin bug, saved addresses, legal/age-verification gaps). That work held up under fresh re-verification in this session: of the ten specific previously-open items re-checked, six are now confirmed fixed.

What's left, and what's new in this report, clusters into three themes:

1. **An ongoing process failure that undermines confidence in everything else**: GitHub Actions CI has run zero tests, zero coverage checks, and zero secret scans on any commit since at least 2026-06-11 — including every fix this entire four-report engagement has produced — because of an account billing lock only the founder can resolve. This is unchanged since the first report flagged it a week ago.
2. **A handful of genuinely new, concrete gaps this session found**: an OAuth account-auto-linking path that doesn't check the provider's email-verification claim (a real, if not universally exploitable, account-takeover vector); GPS location pings with zero server-side plausibility checking, which is a real fraud-enablement gap for order-matching integrity; no chargeback/dispute webhook handling at all; a Google Maps API key that was flagged a week ago as "leaked in git history, unconfirmed whether rotated" — this session confirms it was **not** rotated and is still the live production key today.
3. **A still-real financial feature left half-built**: store credit issued by returns has no way to ever be spent, and — new since the last check — the current return flow doesn't even issue store credit anymore at all (it refunds to the original payment method instead), leaving the entire `store_credits` table and its UI as orphaned, dead functionality that should either be finished or removed.

None of this is a "start over" situation. It's a short, concrete list, same as every prior report in this engagement — the pattern holds.

---

## 2. Architecture Review

Three independent services: `backend/` (Node/Express + PostgreSQL/Supabase + Redis + Socket.IO), `flash-user-app/` and `flash-driver-app/` (Expo SDK 56 / React Native 0.85). Layered backend (`routes/` → `controllers/` → `models/`/`services/`), consistent with the documented architecture rules. One architectural fact worth stating plainly since the audit brief explicitly asks about store-to-store isolation: **there is no multi-store/multi-tenant concept in this codebase at all.** There is no `stores` table, no store-role account, no store login. `Boost`/promotion creation (`backend/src/routes/boostRoutes.js:17-18`) is admin-only (`requireRole("admin")`) — a single admin manages all "store" merchandising on behalf of what is currently one retail partner. This means "can a store access another store's data" is not currently a live attack surface, because there is no second, independently-authenticated store to isolate from. **This is worth flagging as a forward-looking architectural note, not a bug**: if Flash ever becomes a genuine multi-vendor marketplace, store-level authentication and data isolation will need to be built from scratch — it does not exist today even in skeleton form.

Payment processing is correctly backend-mediated: the mobile apps never see or transmit raw card data (confirmed independently by this session's mobile-security pass) — all card payments go through Paystack's own hosted checkout, opened via `Linking.openURL`, not the app's own network stack.

---

## 3. Security Review

### 3.1 Confirmed still-fixed from prior sessions (not re-tested in full depth, spot-checked where cited)
- Bearer JWT redaction in logs (C-1), dead tracking/chat screens (C-2), negative-quantity price manipulation (C-3), unauthenticated driver-location broadcast (C-4), OAuth audience scoping (H-3), delivery-fee manipulation (H-4), payout step-up auth (H-5), cash-fail abuse gate (H-6), request timeouts (H-7), session-expiry handling (H-8) — all previously fixed with live proof in `FLASH_AUDIT_REPORT.md` §9. Not re-verified line-by-line in this pass (would duplicate prior work); no evidence found during this session's otherwise-thorough file reading that any of these regressed.
- Sentry capture + recursive `beforeSend` scrubbing on all three surfaces, Cloudinary signature/size enforcement — previously fixed in `ACCESS_SECURITY_AUDIT.md`.

### 3.2 NEW — OAuth account auto-linking does not check the provider's email-verification claim (HIGH)

**File:** `backend/src/controllers/authController.js:306-315` (Google, user), `:368-378` (Google, driver), `:591-600` (Apple, user), `:648-659` (Apple, driver).

Both `verifyGoogleToken` (`backend/src/services/googleAuthService.js:46`) and `verifyAppleToken` (`backend/src/services/appleAuthService.js:93`) correctly extract an `emailVerified` boolean from the provider's own token claims. **Neither is ever checked before auto-linking a new sign-in to an existing Flash account by email match:**

```js
// authController.js:306-315 (Google, user) — no emailVerified check anywhere in this branch
if (googleUser.email) {
  const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [googleUser.email]);
  if (byEmail.rows.length) {
    const user = byEmail.rows[0];
    await pool.query(`UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2`, [googleId, user.id]);
    // ...logs the attacker straight into the victim's existing account
```

The identical pattern repeats in all four OAuth sign-in paths (Google/Apple × user/driver).

**Attack scenario:** if an attacker can obtain any Google- or Apple-issued identity token whose `email` claim matches a victim's existing Flash account email but whose `email_verified` claim is `false`, signing in with that token silently links the attacker's OAuth identity to the victim's existing Flash account — from then on, the attacker can sign in as the victim indefinitely via that OAuth provider. This is a well-documented real-world OAuth vulnerability class (most practically exploitable against Google Workspace/G Suite custom-domain accounts with a loosely-verified domain, or any other identity provider Google/Apple allow to federate in with a lower assurance level — **not** generally exploitable against a victim's plain consumer `@gmail.com`/`@icloud.com` address, since those are always fully verified before the account can be used at all).

**Why this is real but not universally exploitable, stated plainly**: exploiting this requires the attacker to actually possess a validly-signed token from Google/Apple with `email_verified: false` and an email claim matching the victim's — not something achievable against every possible victim, but a real, non-theoretical path against victims who signed up with a custom/work domain email.

**Fix:** one added condition per branch — `if (googleUser.email && googleUser.emailVerified)` / `if (email && appleUser.emailVerified)` — before doing the auto-link. If unverified, either reject the sign-in or require the user to prove ownership of the existing account another way (e.g., password confirmation) before linking.

### 3.3 NEW — Age verification (18+) is enforced on password registration but bypassable via Google/Apple sign-in (Medium)

**File:** `backend/src/routes/authRoutes.js:19-30` (the `dateOfBirthValidator`, correctly wired to `/user/register` line 34 and `/driver/register` line 71) vs. `authController.js`'s four OAuth sign-in handlers (`googleSignInUser`, `googleSignInDriver`, `appleSignInUser`, `appleSignInDriver`), none of which collect or validate `date_of_birth` at any point in new-account creation.

This is a real, previously-undocumented gap in an otherwise-genuine fix (the age check itself, confirmed **now fixed** in §9 below, was correctly added to the email/password path). A user under 18 can simply register via "Sign in with Google/Apple" instead of email/password and completely bypass the age gate. **Fix:** either collect and validate date of birth as a required follow-up step after OAuth sign-in for new accounts, or, at minimum, document this as an accepted gap if OAuth-based age assurance isn't feasible today.

### 3.4 NEW — No account-level brute-force lockout, only IP-based rate limiting (Medium)

**File:** `backend/src/routes/authRoutes.js:13` (`authLimiter` — 10 req/15min — applied per-IP to the whole auth router, covering both register and login).

There is no secondary control keyed to the *account* being attacked — no failed-attempt counter on the `users`/`drivers` row, no temporary account lock after N wrong passwords. An attacker distributing login attempts against one specific victim's email across many source IPs (a botnet, a residential proxy pool, or simply many real users legitimately sharing one CGNAT IP, which the original audit's load test already demonstrated is a realistic South African scenario) faces no additional friction once the shared IP-based budget is available. This is consistent with, not worse than, similar findings already accepted elsewhere in this engagement (e.g., the `forgotPassword` timing side-channel) — flagging as a real, low-cost-to-fix gap (`failed_login_count`/`locked_until` columns, incremented in `User.verifyPassword`/`Driver.verifyPassword`) rather than a Critical, since the IP-based limiter does provide real protection against the common case.

### 3.5 Dead code, correctly ruled out as a non-issue (documented so it isn't rediscovered and misreported later)

`backend/src/utils/helpers.js:15-30`'s `generateToken(id, role, status)` accepts an optional third `status` argument, and `middleware/auth.js:31` (`if (decoded.status === "approved") req.driverStatus = "approved"`) contains matching logic to trust a cached approval status embedded in the JWT rather than hitting the database. **Traced fully: `generateToken` is never actually called with a third argument anywhere in the current codebase** (confirmed via repo-wide grep — both call sites, `authController.js:24` and `:464`, pass only `(id, role)`). This means `decoded.status` is always `undefined`, `req.driverStatus` is never set via this shortcut, and `requireApprovedDriver` (`middleware/auth.js:51-72`) always performs a live `SELECT status FROM drivers` check — meaning an admin suspending a driver takes effect on the very next request, not after a stale-JWT delay. Worth removing as dead code for clarity, but genuinely not a security gap.

---

## 4. Authentication Review

Covered in §3.2-3.5 above (new findings) plus the already-solid, previously-verified foundation: 15-minute access tokens, real refresh-token rotation with reuse-detection revoking the whole token family (`authController.js:439-461`), `jti`-based revocation checked on every request (`middleware/auth.js:20-27`), password reset that invalidates all other sessions (`authController.js:264-268`), and one-time, expiring email-verification/reset tokens with proper `used_at`/`expires_at` DB-level gating. Password policy: minimum 10 characters, enforced identically at registration (`authRoutes.js:34,71`) and reset (`authController.js:232`). No MFA/2FA exists anywhere in the system — reasonable for this app's risk profile today (no client-side stored balance, payment processing is backend/Paystack-mediated), but worth listing explicitly as **MFA readiness: not implemented, not currently required**, should be revisited if a fraud pattern targeting account takeover ever emerges.

---

## 5. Authorization Review

The existing route/permission matrix in `FLASH_AUDIT_REPORT.md` §6 was read and is not repeated here — it was thorough (every ID-bearing route across 19 route files) and nothing in this session's file reading contradicted it. Two new items:

- **NEW — `GET /api/drivers/nearby` is confirmed still fully unauthenticated** (`backend/src/routes/driverRoutes.js:117`) — no `authenticate`/`requireRole` middleware at all, unlike every neighboring route. Confirmed still open by this session's status-verification pass (originally flagged as Medium in the first report; restating here since it's still live).
- **Architectural note**: see §2 — there is no store-role account to test isolation against; admin isolation itself (every `/api/admin/*` and `/api/returns/admin/*` route correctly gated by `requireRole('admin')`) was already live-tested with a fresh driver token in `ACCESS_SECURITY_AUDIT.md` §4.3 and is not re-tested here.

---

## 6. Database Review

Full findings from this session's dedicated database research pass:

- **Medium** — Inconsistent cascade-delete policy: `orders`/`payments` foreign keys to `users`/`drivers` correctly have no `ON DELETE` clause (Postgres default `NO ACTION`, blocking deletion), but `payment_refunds`, `driver_payout_requests`, `driver_payouts`, `driver_wallet_ledger`, `driver_penalties`, `payout_transactions`, and `store_credits` all use `ON DELETE CASCADE` on `driver_id`/`user_id`. **Not currently exploitable** — the app never hard-deletes `users`/`drivers` rows (see next point) — but a real schema-consistency gap: any future manual `DELETE FROM users`/`drivers` (or a code path added later without the same discipline) would silently destroy financial audit trail for that person. Recommend tightening to `RESTRICT` for consistency.
- **Not a gap — genuinely solid** — Account deletion (`User.deleteAccount`, `Driver.deleteAccount`) is a real anonymization pattern, not a hard delete: PII is scrubbed, password replaced with a random unusable hash, refresh tokens revoked, and all order/payment/review history is left completely intact. `Driver.deleteAccount` additionally blocks deletion while an order is active or a wallet balance is outstanding. No hard `DELETE FROM users`/`drivers` exists anywhere in the codebase.
- **Not a gap — genuinely solid** — Every financially-critical multi-step write path (order creation + stock decrement, refund creation/finalization, payout processing, wallet debit) is correctly wrapped in a real `BEGIN`/`COMMIT`/`ROLLBACK` transaction with row-level `FOR UPDATE` locks where races matter, verified independently in `Order.js`, `refundService.js`, and `payoutService.js`. External API calls (Paystack) are correctly kept outside the transaction boundary, with idempotent status transitions handling the async gap. Webhook idempotency (`webhook_events.paystack_event_id`, `payflex_webhook_events.payflex_event_id`, `payments.provider_transaction_id`) is enforced with real DB-level `UNIQUE` constraints, not just application logic.
- **Low-Medium** — No DB-level `CHECK` constraints on any money column (`amount`, `balance`, `total`, etc.) preventing negative values — all such protection is application-level only (e.g., `payoutService.js`'s guarded `wallet_balance >= $2` update). Defense-in-depth gap, no live exploit path found.
- **Informational** — No backup/restore script or documentation exists anywhere in this repository; backup posture depends entirely on Supabase/Render's out-of-repo defaults, which this audit cannot verify from the codebase.

---

## 7. Payment Security Review

Reviewed `DriverWallet.js` and `refundService.js` directly this session (both correctly transactional, correctly row-locked, correctly idempotent — no new issues found), plus everything already verified in prior reports (webhook HMAC-SHA512 signature verification, live-tested double-webhook-delivery idempotency, commission math, saved-card tokenization via Paystack with encryption at rest and no raw PAN ever stored). One new, real gap:

### 7.1 NEW — No chargeback/dispute webhook handling at all (Medium-High)

**File:** `backend/src/controllers/webhookController.js:85-95` — the Paystack event switch handles only `charge.success`, `charge.failed`/`abandoned`, `transfer.success`/`failed`/`reversed`, and `refund.processed`/`failed`. There is no case for Paystack's dispute events (`charge.dispute.create`, `.remind`, `.resolve`). If a customer successfully charges back a completed order with their bank, Flash has no automated reaction: the order stays `payment_status='paid'`, no commission reversal happens, no driver-wallet clawback occurs, nothing is flagged — it requires entirely manual, out-of-band reconciliation. **Recommend:** add a dispute-event handler that at minimum flags the order and notifies an admin; a full automated clawback is a larger, deliberate design decision (reversing an already-paid-out driver commission has its own fairness implications) that should be a founder decision, not a silent fix.

---

## 8. Fraud Prevention Review

This is the area the audit brief specifically asked to prioritize since prior reports didn't cover it. Full findings from this session's dedicated fraud-vector research pass, ranked by severity:

### 8.1 HIGH — GPS/location spoofing has no server-side plausibility check

**File:** `backend/src/models/Driver.js:183-224` (`updateLocation` — a bare `UPDATE` of client-supplied `lat`/`lng`, no speed/distance-over-time sanity check at all), `backend/src/utils/geoBoundary.js` (the Nelson Mandela Bay geofence check, invoked only at order-dropoff creation and when a driver flips online — **never re-checked on subsequent location pings**), `backend/src/services/autoMatchService.js:35-53` (nearest-driver order-matching computed directly off this same unvalidated, self-reported location).

A driver (via a location-mocking app, or direct API calls bypassing GPS entirely) can report coordinates adjacent to any pickup point to win order-matching priority regardless of true physical location, with no speed-of-travel check ever catching an impossible jump, and no re-validation that they're still within the service area after the one-time online-toggle check. This directly undermines order-matching fairness and delivery reliability, with zero compensating detection. **Recommend:** add a basic speed-plausibility check between consecutive pings (reject/flag a ping implying >150-200 km/h travel), and re-run the geofence check periodically, not just at the online-toggle moment.

### 8.2 MEDIUM-HIGH — Account farming has only one line of defense (IP rate limiting)

No CAPTCHA anywhere in the registration flow, no disposable-email blocklist, and critically — **`users.phone`/`drivers.phone` have no `UNIQUE` constraint** (`backend/src/db/migrate.js:125,139`) and are never checked for prior registration, so the same phone number can register unlimited accounts. No device ID/fingerprint is collected anywhere in either mobile app. Combined, an attacker willing to wait out the 15-minute IP window (or using a small proxy pool) can script unlimited fake accounts, each of which can then evade the `flagged_for_cash_abuse` per-user counter (`paymentController.js:444-454`) simply by registering fresh. **Recommend, in priority order**: add a `UNIQUE` constraint (or at least a soft duplicate-check) on phone number per role; consider CAPTCHA on registration if farming is observed in practice; device-fingerprint collection is a larger mobile-side change, worth deferring until there's evidence of actual abuse.

### 8.3 MEDIUM — No driver order-velocity or minimum-transit-time check (collusion-fraud enabler)

No rate limit beyond the generic 100-req/15-min limiter on order acceptance, and no minimum-elapsed-time check anywhere in the order state machine between accept → pickup → delivered. The cash-on-delivery flow is well-protected against *solo* driver fraud specifically because `confirmCashReceived` requires a real customer-supplied OTP (verified, row-locked, ownership-checked — genuinely solid, confirmed by direct reading this session). But for **card-paid orders**, there is no equivalent friction on the delivery-completion transition — a colluding driver+customer pair (enabled by §8.2's account-farming gap) could accept, fast-track, and "complete" fabricated orders with no real transit occurring, generating payout-eligible earnings history. **Recommend:** a minimum-elapsed-time sanity check between order-acceptance and delivery-completion timestamps, flagged for manual review rather than auto-blocked (real deliveries can occasionally be fast).

### 8.4 MEDIUM — No cross-account linkage for penalty evasion

Direct consequence of §8.2: no device ID, no phone uniqueness means any per-account penalty (cash-abuse flag, suspension after 5 cancellations) is trivially evaded by registering a new account. Not a standalone exploit, a compounding factor.

### 8.5 LOW/INFORMATIONAL — No coupon/referral system exists; `store_promotions` is decorative

Exhaustive grep confirms **no coupon, referral, or invite system exists anywhere** in this codebase. What does exist, `store_promotions` (`backend/src/db/migrate.js:493-499`, written via `Boost.createPromotion`, admin-only), stores a `discount_percent` that **is never read anywhere in order pricing logic** — it's a merchandising-banner display value only, never actually applied at checkout. **No coupon-abuse vector exists today, precisely because nothing redeems it.** Worth flagging as a product-integrity note (a store could advertise "20% off" that checkout doesn't honor) rather than a security finding — and a clear requirement for whoever eventually builds real discount codes: server-side per-user redemption-count and usage-limit enforcement will need to be designed in from the start, since this codebase has no precedent for it yet.

---

## 9. Mobile Security Review

Full findings from this session's dedicated mobile-security research pass — deliberately calibrated to this app's actual risk profile (a delivery+payment app with backend-mediated card processing, not a banking app with client-side stored value):

- **Secure storage: genuinely well-separated (Low).** Every token (`FLASH_TOKEN`/`FLASH_REFRESH_TOKEN`, `FLASH_DRIVER_TOKEN`/`FLASH_DRIVER_REFRESH_TOKEN`) lives in `expo-secure-store`, consistently, including inside the driver app's background-location task. AsyncStorage holds only non-credential data (profile snapshot, cart contents, checkout draft, active-order-id). One minor note: the checkout draft (name/phone/email/address) persists unencrypted in AsyncStorage until checkout completes or logout — PII exposure to a device-level attacker with file access, not a credential leak.
- **Deep links, clipboard: not applicable — no gap, because no surface exists.** Neither app registers a URL scheme or has any incoming-deep-link handler; every `Linking` call is outbound-only. Neither app uses the clipboard at all.
- **Screenshot protection, root/jailbreak detection: absent, and genuinely low-impact given this app's design.** No PAN/CVV is ever rendered (card screens show only brand/last4/expiry), and there's no client-side stored value a rooted device could manipulate to defraud anyone but its own owner. Reasonable trade-offs, not meaningful gaps for this app class.
- **Certificate pinning: absent (Low-Medium), but blast radius is limited.** A MITM on public WiFi or a rooted device with a malicious CA could intercept login credentials or session tokens in transit to the Flash API — serious but recoverable via password reset/token revocation — but never raw card data, since all card payments route through Paystack's own hosted checkout page, outside the app's own network stack entirely.
- **Hardcoded secrets: none of concern.** All `EXPO_PUBLIC_*` values embedded client-side are intentionally-public-by-design (API base URL, Sentry DSN, OAuth client IDs). One dead, unused Paystack **test** publishable key hardcoded in both apps' `eas.json` (`pk_test_...`, not referenced anywhere in source, and publishable keys are meant to be client-visible by design) — a cleanup item, not a leak.
- **No code obfuscation configured** — standard/expected for Expo/React Native apps of this size, not an incremental risk given no real secrets are present to extract.

---

## 10. API Security Review

OWASP API Top 10 coverage, synthesizing this session's findings with the prior route-matrix audit: **Broken Object Level Authorization** — one gap found across the whole API surface, already fixed (C-4, driver location ownership). **Broken Authentication** — see §3-4. **Mass Assignment** — not separately re-tested this session; prior report noted several admin-only routes use ad-hoc presence checks rather than `express-validator`, low risk given admin is already highest-trust. **Rate Limiting** — real and IP-scoped throughout, with the one new gap found this session being Socket.IO's `join_driver_pool` handler having no per-socket rate limit at all (§11). **Input Validation** — `express-validator` used consistently on the auth surface; negative-quantity/price manipulation already fixed. **Excessive Data Exposure** — `GET /api/drivers/nearby` still unauthenticated (§5), discloses driver names/ratings/vehicle plates/live positions to anyone with network access — the one live BOLA-adjacent finding still open in this entire engagement.

---

## 11. Socket.IO Review

Full findings from this session's dedicated research pass:

- **Not a gap — room authorization is genuinely enforced.** Every room-join path (`track_order`, `join_order_chat`, `driver_location_update`, `join_driver_pool`) re-validates the authenticated socket's actual ownership/role against the database before joining a room or broadcasting — a customer cannot join another customer's order-tracking room by guessing (or even knowing) the order UUID. No event lets a client's payload get relayed to other clients without server-side validation first — no event-injection/message-spoofing vector found.
- **Low-Medium — `join_driver_pool` has no per-socket rate limit**, unlike every sibling event (all others are capped at 60-120/min). It runs a live DB query per invocation. A modified driver client could hammer this event, generating unbounded DB load with a valid driver JWT and zero cost.
- **Low — a 30-second authorization cache** on order-room access means a driver reassigned off an order retains room/location-broadcast access for up to 30 more seconds. Explicitly documented in the code's own comments as an accepted, bounded tradeoff — not a new finding, confirmed still accurate.
- **Confirmed still open (not new) — revoked tokens are not re-checked on the periodic socket keep-alive**, only at initial handshake, meaning a logged-out session's open socket can remain live for up to ~14 more minutes. Already a documented Medium finding from the first report; re-confirmed true, not yet fixed.
- Room names use UUIDs throughout (`orders.id`, `users.id`, `drivers.id`), not sequential integers — not guessable, reinforcing that the enforced authorization checks are the real protection, not security-through-obscurity.

---

## 12. Infrastructure Review

- **CRITICAL, ongoing — GitHub Actions CI is still completely non-functional.** Re-checked live via `gh run list`/`gh run view` against the actual repository this session: the most recent run (triggered by this engagement's own latest commit) fails in 3 seconds with `"The job was not started because your account is locked due to a billing issue"` — identical to the very first report's finding a week ago. **Every commit across this entire four-report, multi-week engagement has landed with zero automated test execution, zero coverage verification, and zero automated secret scanning.** This is squarely the founder's action item (GitHub account billing settings) and cannot be fixed from within the codebase.
- **HIGH, escalated from "unconfirmed" to confirmed — a Google Maps API key leaked in git history was never rotated.** The first report flagged `AIzaSyBx_Y-spzI7JK5Jx1NHG9ctjQFAZckHkmU` as permanently present in old commits and explicitly stated "not verified whether rotated." This session confirms directly: **that exact same key is still the live `GOOGLE_MAPS_API_KEY` value in `backend/.env` today.** It has never been rotated. Anyone who clones an old commit (this repo's history has not been rewritten, per policy) can extract and use this key against Flash's Google Cloud billing account, unless restricted by HTTP referrer/package name/SHA-1 fingerprint in Google Cloud Console — a setting only the founder can confirm, and which the first report already flagged as unconfirmed. **Recommend:** rotate this key in Google Cloud Console now, and confirm API restrictions are actually configured.
- **Fresh secret scan — clean, no new leaks.** Re-ran a full-history grep for live Paystack (`sk_live_`), AWS (`AKIA...`), and private-key header patterns across `git log --all -p`: the only `sk_live_` matches are documentation text in `.env.example` explaining the naming convention, not a real key. No new secrets found beyond the already-known, already-flagged Google Maps key.
- **Docker Compose configuration reviewed directly — solid, no new findings.** Required secrets (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`) use Compose's `:?` syntax to fail fast if unset; Postgres/Redis are `expose`d internally only, never bound to the host's public ports; Redis requires a password; per-service memory limits prevent a runaway process from OOM-killing the host.
- **Dependency audit — unchanged, still open.** Fresh `npm audit` this session shows the exact same High-severity findings as both prior reports, in all three apps (`basic-ftp`, `form-data`, `nodemailer`, `systeminformation`, `undici`, `ws` — backend; `engine.io-client`, `ws` — both mobile apps). `npm audit fix` (the non-breaking subset) has still not been run.

---

## 13. Privacy Review

Account deletion (§6) is a genuine, solid anonymization flow — this directly answers the audit brief's explicit ask ("deleted accounts remove all appropriate personal information safely... no deleted account leaves recoverable sensitive data"). No hard deletes anywhere; financial/order history is deliberately preserved (correct for compliance/dispute-resolution purposes) while PII is scrubbed. Users can sign up, sign in, sign out, recover/change passwords, and delete accounts — all confirmed functional. Data export (a POPIA/GDPR "right to access" mechanism) was **not found anywhere in this codebase** — no `GET /users/export` or equivalent exists. This wasn't flagged in any prior report either; noting it here as a real, currently-absent capability worth a decision (South Africa's POPIA, like GDPR, generally expects a data-subject-access mechanism, even if manual/email-based rather than a self-service API for a startup at this stage).

---

## 14. Performance Review

Not a primary focus of this session (the first report already ran a real, 5-minute load test with 165 seeded accounts and captured genuine numbers — not repeated here). Nothing in this session's file reading surfaced a new N+1 query, obvious blocking call, or Redis-misuse pattern beyond what's already documented (the `getNearby`/`autoMatchService` haversine queries lacking a bounding-box pre-filter, already flagged as Medium in the first report and still unaddressed per this session's spot check of `autoMatchService.js`).

---

## 15. Compliance Review

POPIA/GDPR-adjacent findings: age verification (18+) now enforced on password registration (confirmed fixed, §9 of the prior returns/legal audit's original gap), still bypassable via OAuth registration (§3.3, new). Data-subject export capability absent (§13, new observation). Legal-domain and driver-Terms-acceptance mismatches from the third report are confirmed fixed (§16 below). PCI DSS: correctly out-of-scope for card data by design — Flash never stores or transmits raw PAN/CVV, all card handling is Paystack-hosted (SAQ-A-equivalent posture, the least-burdensome PCI category, appropriate for this architecture).

---

## 16. Status of Every Previously-Open Finding (fresh re-verification, this session)

| # | Finding (source report) | Status as of this session |
|---|---|---|
| 1 | Store credit has no redemption path (Returns audit, HIGH) | **STILL OPEN** — see §17 |
| 2 | Returned stock never restored to inventory (Returns audit, MEDIUM) | **STILL OPEN** |
| 3 | No admin dashboard/app for returns (comment in `returnRoutes.js`) | **NOW FIXED** — `backend/public/admin/` is real and wired correctly; the source comment claiming otherwise is stale and should be removed |
| 4 | `approveReturn` UUID crash (Returns audit, CRITICAL) | **NOW FIXED** — `ADMIN_USER_ID` is a real UUID, correctly used as the JWT `id` claim |
| 5 | Saved addresses backend missing (Returns audit) | **NOW FIXED** — real `addresses` table, full CRUD routes, matches the pre-existing frontend exactly |
| 6 | Legal/compliance mismatches — wrong domain, no age check, no driver Terms (Returns audit) | **NOW FIXED** — domain references cleaned up, `dateOfBirthValidator` added to both registration paths, driver app has a real Terms-acceptance screen now |
| 7 | Cloudinary permanent URL / broken deletion (Access audit) | **NOW FIXED** — confirmed via `public_id`/`resource_type` columns and corrected `getSignedUrl()`/`deleteFile()` calls |
| 8a | H-9 — payment redirect / deep-link scheme (original audit) | **STILL OPEN** — `paystackService.js` still builds a `/payment/callback` URL that has no matching backend route; neither app registers an `expo.scheme` |
| 8b | H-10 — missing address/notification routes (original audit) | **PARTIALLY FIXED** — addresses done (#5); no general notifications list/read route exists yet |
| 9a | `payment_pending → scheduled_for_morning` bypass edge (original audit, Medium) | **STILL PRESENT** |
| 9b | `GET /api/drivers/nearby` unauthenticated (original audit, Medium) | **STILL OPEN** |
| 9c | `npm audit fix` not run (original + access audits) | **STILL OPEN**, identical package set |
| 10 | Dependency/EOL versions | **Confirmed current** (Expo ~56.0.14, RN 0.85.3 in both apps), no new high/critical findings |

---

## 17. Hacker Attack Simulation

Three concrete, chained attack scenarios, combining this session's new findings with what's still open from prior sessions:

**Scenario A — Fraud ring via account farming + GPS spoofing + weak dispute handling.** An attacker registers dozens of throwaway accounts (§8.2 — no phone uniqueness, no CAPTCHA, only a 15-minute IP window to wait out) as both customers and drivers. Using a GPS-spoofing tool (§8.1 — no server-side plausibility check), the fraudulent driver accounts always appear "nearest" to win order-matching for the fraudulent customer accounts' fabricated orders. Since these are card-paid orders with no minimum-transit-time check (§8.3), the "delivery" completes in seconds. The fraudulent driver earns payout-eligible commission. If the "customer" then charges back the card payment with their bank, Flash has no automated dispute-handling (§7.1) to catch or reverse it — the driver keeps the payout, Flash absorbs the loss twice (fake payout + charged-back revenue), and there's no cross-account signal (§8.4) linking the fraudulent accounts to stop a repeat.
*Mitigation priority: §8.1 (GPS plausibility) and §8.2 (phone uniqueness) close the most leverage points cheaply; §7.1 (dispute handling) closes the financial blind spot.*

**Scenario B — OAuth account takeover against a custom-domain email victim.** An attacker who can obtain (or engineer, e.g. via a loosely-verified Google Workspace domain) a Google identity token bearing an `email` claim matching a real Flash customer's work-domain email address, with `email_verified: false`, signs in via "Continue with Google." Because `authController.js` never checks that claim (§3.2), the attacker's Google identity is silently linked to the victim's existing Flash account — including their order history, saved-card references, and personal data — with no notification to the victim.
*Mitigation: the one-line `emailVerified` check in §3.2 closes this completely.*

**Scenario C — Leaked, unrotated API key abused for cost/quota exhaustion.** Anyone who clones or already has a copy of this repository's git history (never rewritten, per project policy) can extract the Google Maps API key confirmed still-live in §12. If unrestricted in Google Cloud Console (unconfirmed either way — founder-only to check), an attacker could embed it in unrelated projects or script high-volume requests against Flash's own Google Cloud billing account.
*Mitigation: rotate the key now; confirm HTTP-referrer/package-name/SHA-1 restrictions are actually configured.*

---

## 18. Risk Assessment

| Risk | Likelihood | Impact | Priority |
|---|---|---|---|
| GPS spoofing undermining order-matching integrity | High (no control exists at all) | Medium (delivery reliability, customer trust) | High |
| OAuth account-linking without email-verification check | Low-Medium (needs a specific token property) | High (full account takeover) | High |
| Account farming enabling fraud/abuse-evasion | Medium (some effort required, but cheap) | Medium | Medium-High |
| No chargeback/dispute handling | Medium (any real chargeback triggers it) | Medium-High (direct financial loss, no automated recovery) | Medium-High |
| CI billing lock (zero automated verification) | Certain (already true) | Systemic (undermines confidence in every future change) | Critical (process, not code) |
| Leaked, unrotated Google Maps key | Low-Medium (depends on API restriction config) | Low-Medium (cost/quota, not user data) | Medium |
| Store credit orphaned / unspendable | Certain (already true) | Medium (real money-like liability with no UI path to honor it) | Medium-High |

---

## 19. Production Readiness Score

**6.5 / 10 — closer to launch-ready than not, but not yet there, for reasons that are almost entirely process and completeness gaps rather than active vulnerabilities.**

Justification: the core money-handling paths (payment idempotency, refund/payout transactions, wallet ledger, order-state-machine locking) are genuinely well-built and independently re-confirmed solid this session. Authentication and most authorization is solid. The blockers to a clean readiness score are: (1) CI still provides zero automated safety net on any future change — this is the single biggest process risk in the entire engagement; (2) a live, if narrow, fraud-enablement gap (GPS spoofing) with no detection; (3) one real account-takeover-class bug (§3.2); (4) an orphaned financial feature (store credit) that looks live to users but leads nowhere.

---

## 20. Critical Issues

1. GitHub Actions CI billing lock — zero automated verification on any commit, ongoing since 2026-06-11 (founder action required, not fixable in code).

*(No new code-level Critical findings this session — the prior reports' Criticals are all fixed and verified; this session's most severe new/reopened items land at High, reflecting real but not maximally-severe risk.)*

---

## 21. High Issues

1. OAuth account auto-linking doesn't check `emailVerified` (§3.2) — real account-takeover vector under specific conditions.
2. GPS/location spoofing has no server-side plausibility check (§8.1) — undermines order-matching fairness and delivery reliability.
3. Google Maps API key confirmed leaked *and* never rotated (§12) — escalated from prior "unconfirmed."
4. Store credit has no redemption path, and the current return flow no longer even issues it (§17, #1) — an orphaned, dead financial feature.

---

## 22. Medium Issues

1. Age verification bypassable via OAuth registration (§3.3).
2. No account-level brute-force lockout, IP-only (§3.4).
3. Account farming — no phone uniqueness, no CAPTCHA, no device fingerprint (§8.2).
4. No driver order-velocity/minimum-transit-time check (§8.3).
5. No chargeback/dispute webhook handling (§7.1).
6. Inconsistent cascade-delete policy on financial tables (§6).
7. No DB-level `CHECK` constraints against negative money values (§6).
8. Returned stock never restored to inventory (§17, #2).
9. `payment_pending → scheduled_for_morning` bypass edge, still present (§17, #9a).
10. `GET /api/drivers/nearby` still unauthenticated (§17, #9b).
11. H-9 payment callback route still missing (§17, #8a).
12. `join_driver_pool` socket event has no rate limit (§11).

---

## 23. Low Issues

1. Checkout draft PII lingers unencrypted in AsyncStorage until completion/logout (§9).
2. No certificate pinning (§9) — limited blast radius given Paystack-hosted card flow.
3. Dead hardcoded Paystack test publishable key in both apps' `eas.json` (§9).
4. 30-second stale room-access window on Socket.IO driver reassignment (§11) — already an accepted, bounded tradeoff.
5. No general notifications list/read backend route (§17, #8b).
6. `npm audit fix` (non-breaking subset) still not run in any of the three apps (§17, #9c).
7. Stale source comments claiming "no admin dashboard exists" (§17, #3).

---

## 24. Best Practices Missing

- No data-subject export/access mechanism (§13).
- No CAPTCHA anywhere in registration.
- No MFA/2FA (acceptable for now, worth revisiting if account-takeover fraud is ever observed).
- No device fingerprinting for fraud correlation.
- No automated chargeback/dispute handling.
- No DB-level negative-value constraints as defense-in-depth.

---

## 25. Immediate Fixes (low-effort, high-value)

1. Add the `emailVerified` check before OAuth account auto-linking (§3.2) — one conditional per branch, four branches.
2. Rotate the Google Maps API key and confirm Cloud Console restrictions (§12).
3. Resolve the GitHub billing lock (founder-only action).
4. Add a `UNIQUE` (or soft duplicate-check) constraint on `users.phone`/`drivers.phone` (§8.2).
5. Either remove the `payment_pending → scheduled_for_morning` bypass edge or document why it's intentionally allowed (§17, #9a).
6. Add `authenticate` to `GET /api/drivers/nearby` (§17, #9b).
7. Run `npm audit fix` (non-breaking subset) across all three apps (§17, #9c).
8. Remove the stale "no admin dashboard exists" comments (§17, #3).

---

## 26. Long-Term Improvements

1. Decide and build store-credit redemption, or remove the feature entirely rather than leave it orphaned (§17, #1).
2. Add GPS speed-plausibility checking and periodic (not just one-time) geofence re-validation (§8.1).
3. Build chargeback/dispute webhook handling with at minimum admin notification (§7.1).
4. Add a minimum-elapsed-time sanity flag between order acceptance and delivery completion (§8.3).
5. Add DB-level `CHECK` constraints on money columns as defense-in-depth (§6).
6. Tighten cascade-delete policy on financial tables to `RESTRICT` (§6).
7. Complete the address/notification route work (H-9/H-10 remainder, §17 #8a/8b).
8. Consider device-fingerprint collection if account-farming abuse is ever actually observed in production.

---

## 27. Suggested Architecture Improvements

- If multi-vendor/multi-store ever becomes a real product direction, store-level authentication and data isolation needs to be designed from scratch (§2) — nothing today provides even a skeleton for it.
- Consider a dedicated fraud-signals table (device ID, IP history, velocity counters) rather than scattering ad-hoc flags (`flagged_for_cash_abuse`, `cancel_count`) across multiple tables, to make future fraud rules composable.
- The dead `status`-caching capability in JWT generation (§3.5) should be removed for code clarity, since it's unused and could confuse a future contributor into thinking it's an active security control.

---

## 28. Industry Best Practices Not Yet Implemented

CAPTCHA on registration; device fingerprinting; MFA; automated chargeback handling; DB-level monetary constraints; data-subject export API; CI/CD-enforced test/coverage/secret-scan gates (blocked entirely by the billing lock, not a code gap); certificate pinning (acceptable gap given this app's architecture, not urgent).

---

## 29. Production Launch Checklist

- [ ] Resolve GitHub Actions billing lock and get CI actually running (§12)
- [ ] Fix OAuth email-verification check (§3.2)
- [ ] Rotate the Google Maps API key (§12)
- [ ] Decide: finish or remove store-credit redemption (§17 #1)
- [ ] Add phone-number duplicate check on registration (§8.2)
- [ ] Add `authenticate` to `/api/drivers/nearby` (§17 #9b)
- [ ] Run `npm audit fix` across all three apps (§17 #9c)
- [ ] Add GPS speed-plausibility check (§8.1)
- [ ] Confirm Google Cloud Console API-key restrictions are actually configured (founder-only)
- [ ] Confirm Render production environment variables/team roles per `ACCESS_SECURITY_AUDIT.md` §4.2 (founder-only, still outstanding from that report)

## 30. Future Scaling Checklist

- Add bounding-box pre-filter to nearest-driver geo queries before driver-pool size makes the current full-scan haversine query a real latency problem (already flagged in the original report).
- Build real multi-store data isolation before onboarding a second retail partner (§2).
- Add DB-level monetary constraints and tightened cascade policy before financial-history tables grow large enough that a future bug's blast radius matters more.
- Revisit MFA and device-fingerprinting once real user/driver volume makes account-takeover and farming fraud economically attractive to a real attacker (both are currently reasonable-for-stage gaps, not currently urgent).

---

## Final Verdict

Flash is not yet production-ready, but — consistent with every prior report in this engagement — the gap between today and launch-ready is a short, concrete, well-understood list, not a fundamental redesign. The single biggest issue is process, not code: CI has provided zero automated safety net for a week of real fixes, and that needs the founder's direct action before this codebase's quality can be trusted to hold under future changes without manual re-verification every time. Of the code-level findings, none are silently catastrophic — the highest-severity new items (OAuth email-verification check, GPS plausibility checking, the unrotated Maps key) are each a small, targeted fix, and the payment/wallet/refund core that would be hardest to get right is already genuinely solid. Ship-readiness realistically depends on: resolving the CI lock, closing the OAuth and GPS gaps, and making an explicit decision on store credit — everything else on this list can reasonably follow launch as a prioritized backlog.
