# Flash — Production Readiness Audit: Final Consolidated Report

**Date:** 2026-09-10. **Scope:** Section 2.15, the final deliverable for the
multi-week Sections 2.1–2.14 audit. This is not a summary of how the audit
went — it's meant to answer, for an outside reader or a future version of
either of us, "where does Flash actually stand today, what's still broken,
and what has to happen before this can be a real public product." Every
claim below is either cited to a specific audit doc, a specific commit, or
was independently re-verified live in this session (grepped/read directly,
not recalled) — flagged inline where something was re-checked rather than
carried forward from an older report.

**How this document is organized:**
1. Section-by-section index (2.1–2.14) — what each found and fixed.
2. Pre-launch gates — must be flipped before any public, non-pilot launch.
3. Deferred work, by theme (consolidated from `OPEN_FOLLOWUPS.md`).
4. Founder/legal action items — explicitly not code work.
5. Findings from the original (July) audit that are still open — carried
   forward, not rediscovered, and not silently dropped.
6. Production readiness score, with real reasoning.

---

## 1. Section-by-section index (2.1–2.14)

Sections 2.1–2.7 predate the per-section audit-doc convention (that starts
at 2.8) — their record lives in their commit messages, each of which
self-identifies its section number in the commit body. Reconstructed by
direct git-log archaeology this session; all high-confidence, cited by hash.

### §2.1 — Account-deletion messaging accuracy
**Found:** both apps' delete-account confirmation claimed order/earnings
history would be deleted along with the account; in reality
`User.deleteAccount`/`Driver.deleteAccount` anonymize PII but retain
orders/payments/payouts for accounting/dispute/tax reasons — an overpromise
that misleads a user about what "delete" actually does.
**Fixed:** corrected the dialog text in both apps; also swapped a stray
founder-personal-Gmail fallback contact for `support@flashdelivery.co.za`.
**Evidence:** commit `67c25a1`. No dedicated audit doc.

### §2.2 — Customer↔driver communication (chat)
**Found:** the order chat itself was already solid (real-time, correctly
authorized), but had three real gaps: no push notification for a new
message when the app is backgrounded/killed; no cutoff of messaging after
an order finishes; only a blanket 100-per-15-min API rate limit, not a
chat-specific one. Masked calling and block/report were both explicitly
scoped out — masked calling deferred to the pre-launch checklist (see §2
below), block/report folded into §2.7.
**Fixed:** `notificationService.js`'s `notifyNewMessage()`; `Message.js`
blocks sending more than 24h after a terminal order status (history/reads
stay open); a new 20/min POST-only `messageLimiter`. 11 new unit tests.
**Evidence:** commit `1654e44`. No dedicated audit doc.

### §2.3 — Navigation and live tracking
**Found:** navigation itself (customer tracking, driver routing) was
already solid; the real gap was no *persistent* ETA — only one-time
milestone toasts — plus a stale code comment in `CheckoutScreen.js`
claiming geocoding didn't exist when it already had been fixed elsewhere.
**Fixed:** `Driver.js`'s `updateLocation()` now computes distance/ETA per
location ping and emits it; `TrackingScreen.js` shows a persistent
"8 min away · 1.5km." 7 new unit tests. Wrong-direction detection and real
road-routing ETA (vs. straight-line-distance-over-assumed-speed) were both
deliberately deferred — see §3 below.
**Evidence:** commit `b600926`. No dedicated audit doc.

### §2.4 — Driver fraud/theft/order-security lifecycle
**Found:** (a) the generic order-status endpoint blocked reaching
`completed` without OTP, but had no equivalent block on `picked_up`/
`delivered` — a driver could skip the pickup/dropoff photo requirement
entirely by hitting the generic endpoint instead; (b) the 45-minute
stuck-order-reassignment cron auto-suspended a driver after 5 abandoned
orders, but only logged to `console.warn` — invisible to any admin.
**Fixed:** (a) `orderController.js` now rejects `picked_up`/`delivered` on
the generic endpoint (409, points at the real photo-submission endpoints)
— also hotfixed directly to `main` in advance, given the severity. (b)
Auto-suspension now writes a real `driver_penalties` row instead of a
console log.
**Evidence:** commits `e143e1b`/`ae255f8`/`07a6d19` (the photo-bypass fix,
including its `main` hotfix), `791d0d1` (the penalty-visibility fix). No
dedicated audit doc.

### §2.5 — Deployment, migration, and release safety
**Found:** migrations aren't run automatically on deploy (a manual,
forgettable step); the real, already-working `/health` endpoint isn't
wired into Render's health-check config, so Render can't use it to gate
traffic cutover or detect a hung instance.
**Fixed in code:** nothing — both recommended fixes are Render *dashboard*
settings (`buildCommand`, `healthCheckPath`) that no available tool can
change on an existing service. **Still not applied** — see §2 (pre-launch
gates) below; this is a real, currently-open, two-minute fix, not a
completed one.
**Evidence:** `docs/audits/DEPLOYMENT_SAFETY_RECOMMENDATIONS.md`, commit `5ffaeb7`.

### §2.6 — Live-usage failure scenarios
**Found:** `sendPushNotification()` silently swallowed transport failures
and never inspected Expo's per-ticket error codes (e.g.
`DeviceNotRegistered`) — a real push failure was indistinguishable from a
successful send anywhere in the system.
**Fixed:** the function now returns a discriminated result; a new
`reportPushFailure()` reports failures to Sentry with order/recipient
context, wired into all 6 real call sites. 10 new unit tests. A
`MapView` `onError`-handling gap on the tracking screen was found and
explicitly logged as low-severity, not fixed (see §3 below).
**Evidence:** commit `ad27273`. No dedicated audit doc.

### §2.7 — Malicious/accidental user behavior
**Found:** block/report (deliberately deferred from §2.2 as a real design
decision, not a chat bolt-on) needed a real design and build. Once built,
a same-section follow-up covered two more gaps: blocking didn't cut off
an already-active order's chat/calls, and the matching-query changes
hadn't been checked for query-plan behavior at scale.
**Fixed:** new `user_blocks`/`chat_reports` tables (migration v37);
`UserBlock`/`ChatReport` models; report/block endpoints (5/hour rate
limit); enforcement wired into matching (`autoMatchService.js`,
`Driver.getNearby()`); a real AdminJS review queue. Follow-up: active-order
messaging/calling now genuinely cut off on block, phone numbers redacted
from a blocked pair's order data; the matching-query path was refactored
to a fetch-once pattern with composite indexes, verified via
`EXPLAIN ANALYZE` at 20,000-row synthetic scale.
**Evidence:** commits `5e2448e`, `ce6fcba`. No dedicated audit doc. This
is also the work `APPLE_APP_STORE_COMPLIANCE_AUDIT.md` §6 later confirmed
satisfies Apple's Guideline 1.2 (User-Generated Content) requirements.

### §2.8 — Payments, and (requested alongside it) commission debt
**Found (payments):** card-payment double-charge protection was already
solid on the webhook-retry path (unique event-id constraint, row lock,
conflict-safe ledger insert) — but a genuinely reachable gap existed on
the user-double-tap/slow-network path: `initializePayment` read the order
unlocked, then updated it only after a potentially slow external Paystack
call, with nothing spanning the sequence with a lock.
**Found (commission debt):** `recordCashCommission` charged a hardcoded
flat R20 instead of the real percentage-based commission formula —
real money, wrong on every cash order since it was written; 2 real
production rows were already wrong and needed correcting.
**Fixed:** the payment-initialization race relocked around the full
sequence, matching the same lock-before-side-effect pattern used
throughout this audit. Commission debt now correctly computed against
the real formula; the 2 wrong production rows corrected after direct
investigation.
**Docs:** `SECTION_2.8_PAYMENTS_AUDIT.md`, `SECTION_2.8_COMMISSION_DEBT_AUDIT.md`.

### §2.9 — Refund lifecycle
**Found:** `cancelOrder` computed its refund split from a pre-transaction,
unlocked snapshot of the order — the same race-condition shape as §2.8's
payment-initialization bug, in the cancellation/refund path instead.
Reconciliation also didn't handle split refunds or a stuck "processing"
refund state correctly.
**Fixed:** `cancelOrder` relocked to compute financial effects only from a
`SELECT ... FOR UPDATE` read; `paymentReconciliationJob.js` gained
split-aware reconciliation and orphaned-processing-refund recovery; a
Payflex resource leak in `server.js` fixed alongside.
**Doc:** `SECTION_2.9_REFUND_LIFECYCLE_AUDIT.md`, commit `642be16`.

### §2.10 — Stuck-order state machine
**Found:** three real stuck-state gaps with no automated recovery: orders
abandoned mid-payment, orders stuck `preparing` past a reasonable window,
and orders that reached `paid` but were never picked up by the matching
flow.
**Fixed:** three new state-machine functions
(`cancelAbandonedPaymentPendingOrders`, `cancelStalePreparingOrders`,
`recoverStuckPaidOrders`), each a thin cron wrapper with a configurable
threshold. **Known, deliberately-flagged residual gap:** an order already
past `picked_up` has no automated *or* admin-manual recovery path at all
if it gets stuck there — see Open Followup #12 in §3 below; this was a
genuine founder-decision point the section declined to decide unilaterally.
**Doc:** `SECTION_2.10_STUCK_ORDER_STATE_MACHINE_AUDIT.md`, commit `837da18`.

### §2.11 — Traffic scaling path
**Found:** the three new §2.10 cron queries weren't scale-tested the way
earlier work had been; and a concrete "what actually breaks between ~7
drivers/19 orders and 50 drivers/a few hundred orders a day" analysis was
requested.
**Fixed now, cheap:** two new indexes (`orders(status, updated_at)`,
`orders(parent_order_id)`), verified via `EXPLAIN ANALYZE` at 80,000
synthetic rows; `DB_POOL_MAX` lowered from 50 to 30 the same day, after
confirming the Supabase project is genuinely on the free 60-connection-cap
tier.
**Deliberately deferred, cost-gated, not built:** a second Render
instance, Redis for shared rate-limiting/session state — both correctly
identified as real infrastructure-spend decisions to make only as driver
count actually grows, not built speculatively.
**Doc:** `SECTION_2.11_TRAFFIC_SCALING_AUDIT.md`, commits `0a9f984`, `195fd48`.

### §2.12 — Store missed-order reliability
**Found:** a new order could sit `pending_store_acceptance` or
`preparing` indefinitely with no admin visibility if a store simply never
acted on it — the store side had zero automated escalation.
**Fixed:** two new escalation flags (`acceptance_escalated_at`,
`preparation_escalated_at`), each a nullable timestamp set exactly once;
a real two-tier admin alert (live socket event + durable email fallback)
on both the initial "new order" moment and each escalation threshold.
**Doc:** `SECTION_2.12_STORE_MISSED_ORDER_RELIABILITY_AUDIT.md`, commit `6fc0bc2`.

### §2.13 — Full admin visibility
**Found:** the existing table-coverage registry was already sound (no
table was silently undecided) — but two tables carrying real,
currently-accumulating financial/dispute data (`driver_commission_debts`,
`driver_penalties`) were aggregate-only, with no way to browse an
individual record; two more (`admin_actions`, the subscription tables)
had no per-row view at all.
**Fixed:** five new read-only AdminJS resources, each correctly
timestamp-sorted and indexed; `commission_blocked` surfaced on the
drivers list view; a stale hardcoded startup-log string replaced with one
built from the real registered-resource list.
**Doc:** `SECTION_2.13_FULL_ADMIN_VISIBILITY_AUDIT.md`, commit `d6eb473`.

### Apple App Store compliance pass (inserted between §2.13 and §2.14)
**Found:** the privacy policy doesn't name the real third-party services
Flash uses; one deprecated/unused location-permission key in the user
app; account deletion and Sign-In-with-Apple/Google parity were both
already solid; and — the most consequential finding — the driver
subscription-tier purchase flow is a real, live, Paystack-only in-app
purchase on iOS with no Apple IAP, a genuine App Review rejection risk
that doesn't qualify for the same physical-goods exemption the rest of
Flash's payments correctly rely on.
**Fixed:** purchase UI hidden on iOS specifically (status/cancel
untouched everywhere); the unused deprecated location key removed;
third-party-service privacy-policy text drafted for handoff (can't be
applied directly — that site is hosted outside this repo).
**Doc:** `APPLE_APP_STORE_COMPLIANCE_AUDIT.md`, commit `9605831`.

### §2.14 — Mandatory documentation, closed out with two real fixes
**Found:** App Store "App Privacy"/Google Play "Data Safety" forms are
undocumented (never confirmed filled out); no copyleft license exposure;
encryption-export flag correctly set in both apps; no POPIA-specific
internal documentation exists (no Information Officer, no retention
policy); and — the one real code bug — Google/Apple Sign-In on both apps
bypassed the 18+ age check password registration already enforces.
**Fixed:** the OAuth age-gate bypass, closed on both apps with a real
server-side one-time-write endpoint and a client-side gate re-checked on
every app open (so it retroactively catches accounts that already slipped
through, not just future ones); the App Privacy/Data Safety console
answers drafted for handoff. POPIA and the Apple EULA correctly left as
founder/legal action — see §4 below.
**Doc:** `OAUTH_AGE_GATE_AND_APP_STORE_DATA_FORMS.md`, commit `ed29a97`.

---

## 2. Pre-launch gates — must be flipped before any public, non-pilot launch

Every item below was independently re-verified live in this session (not
carried forward from an older doc without checking) unless marked
otherwise.

1. **Paystack card payments are confirmed broken in production right now
   — the most severe item on this list.** `paystackService.js` throws
   `PAYSTACK_SECRET_KEY not configured for production` if the key is
   unset *or* still a `sk_test_...` key (both log identically, so it's
   not even knowable from app logs which state Render is actually in).
   `PaymentScreen.js` in the user app carries an explicit
   `"TEMPORARY TEST-MODE — remove before real launch"` comment that
   filters the payment-method list down to cash-only client-side,
   confirming this is a known, deliberately-worked-around live outage,
   not a hypothetical. **Fix:** set a real `sk_live_...` key on Render
   (confirm via the Render dashboard directly, not app logs), then
   revert `PaymentScreen.js`'s cash-only filter — the comment documents
   the exact steps.
2. **GitHub Actions CI is completely non-functional, unchanged since
   2026-06-11.** Live-checked this session: the most recent run (against
   current `main`) still fails in 2–6 seconds on all three jobs with
   `"your account is locked due to a billing issue."` Zero automated
   verification has run on any commit for three months, across all of
   Sections 2.1–2.14's own work. Founder-only action (GitHub billing).
3. **Masked calling is not built at all** — `TrackingScreen.js`'s call
   button dials the driver's real, unmasked phone number directly
   (`Linking.openURL('tel:' + driver.phone)`); a same-file comment
   calling it a "masked dialler" is aspirational, not accurate to the
   code. `Order.js` explicitly documents this as deferred to the
   pre-launch checklist. This is a real scope/cost decision (a calling-
   proxy service is a genuine new dependency), not something to build
   silently — needs an explicit founder decision either way before
   launch: build it, or launch pilot-style with real numbers exchanged
   and accept that as the model going forward.
4. **Google Maps API key rotation is incomplete.** New Android keys are
   live and working in both apps' production builds. **iOS builds for
   both apps are still pending**, blocked on a one-time interactive
   Apple Distribution Certificate step only the founder can run. **The
   two original, previously-leaked keys are still intentionally active**
   in Google Cloud Console, kept alive only until the new Android builds
   are confirmed working on a real device — every day they stay active
   past that confirmation is unnecessary exposure.
5. **Crash reporting is broken on both apps, in different ways.** The
   user app's production build profile disables Sentry's source-map
   upload (`SENTRY_DISABLE_AUTO_UPLOAD: "true"`, no `SENTRY_AUTH_TOKEN`
   provisioned) — every production crash report today has a minified,
   effectively unreadable stack trace. The driver app never registers
   `@sentry/react-native` as an Expo plugin at all — its crashes very
   likely aren't reaching Sentry in usable form, unconfirmed against the
   live dashboard. Launching without working crash visibility on either
   app is a real operational risk once real users hit real edge cases.
6. **Dead hardcoded Paystack test publishable key** in both apps'
   `eas.json` (`pk_test_9db77a6ebc076fa07d4b3b434bb403ad0851aea9`) — not
   referenced anywhere in source, so no functional risk today, but
   should be replaced with the real live publishable key as part of the
   same cleanup as item 1.
7. **Render dashboard settings from §2.5 were never applied** —
   migrations still run manually (idempotent, so not unsafe, but an
   easy-to-forget step), and Render's health check still isn't wired to
   the real `/health` endpoint, so a bad deploy can't be automatically
   caught before it takes traffic. Both are two-minute dashboard edits,
   not code.
8. **All production secrets' real values are unconfirmed.**
   `PRODUCTION_SECRETS_CHECKLIST.md` (2026-07-16) found no way to verify
   from application-level signals whether `CASH_OTP_SECRET`,
   `ADMIN_PASSWORD_HASH`, `ADMIN_EMAIL`, and the `SMTP_*` values are real
   production credentials or leftover placeholders — nothing since has
   re-confirmed this. Needs a direct Render-dashboard check before launch.

**Already correctly set, confirmed this session — no action needed:**
`DB_POOL_MAX=30` (both `database.js` and `.env.example`),
`DRIVER_TEST_MODE` (defaults `false`, exists exactly as documented).

---

## 3. Deferred work, by theme (consolidated from `OPEN_FOLLOWUPS.md`)

`OPEN_FOLLOWUPS.md` holds 12 numbered items (plus one un-numbered aside).
Consolidated here by theme rather than chronological order; full detail
and reasoning for each lives in the source file.

### Reliability / UX enhancements
- No wrong-direction/off-course detection for a driver mid-delivery — only
  time-based stuck-order detection exists today, nothing spatial. Proposed
  fix is an admin-visible flag, not an automatic penalty. (Overlaps with
  the GPS-spoofing finding in §5 below — a different failure mode:
  unintentional wrong-direction driving vs. deliberate fake GPS.)
- No mobile app-version/force-update gating — if a backend change ever
  breaks an older still-live app version during a store-review delay,
  nothing detects or blocks it.
- No explicit failure handling on the tracking screen's map (`MapView`
  has no `onError`) — low severity, degrades to a blank canvas rather
  than crashing; logged for awareness only.
- Sentry gaps on both apps — see pre-launch gate #5 above; listed here
  too since `OPEN_FOLLOWUPS.md` is where the two items were first found
  and scoped as a linked pair (same root cause: no `SENTRY_AUTH_TOKEN`
  provisioned for either EAS project).

### Cost-tradeoff infrastructure decisions (deliberately not built — real spend/complexity, correctly deferred to when scale actually demands them)
- Real road-routing ETA (Google Directions/Distance Matrix) instead of
  straight-line-distance-over-assumed-speed — a genuine new recurring
  third-party cost, and would need real throttling since ETA is computed
  on every location ping today.
- A second Render instance — currently `numInstances: 1` on the free
  tier, zero redundancy on crash/bad deploy. Also requires making
  `Driver.updateLocation()`'s in-memory ping counter shared (Redis or
  DB-backed) before it's safe to run more than one instance.
- A real staging environment — every change currently goes straight from
  local Docker testing to production. A `render.yaml` Blueprint
  (checking Render's config into source control) is a free interim step
  worth doing regardless of the staging decision.
- A feature-flag/kill-switch system — every deploy today is all-or-
  nothing. Worth checking whether PostHog's free tier (already planned
  for analytics) covers this before adopting a separate paid tool.

### Pre-existing test issues
- `driverCommission.test.js`'s failing test — **resolved** 2026-09-08; was
  a whitespace-formatting mismatch in a test assertion, not a real logic
  bug (found and fixed alongside the real commission-formula bug in §2.8).
- `adminCoverage.test.js`'s host-vs-Docker-network failure — only
  reproduces when run from the host machine outside the Docker network;
  passes cleanly every time it's run inside the container. Not a real
  bug, an environment artifact of local dev setup — documented, not fixed
  (there's nothing to fix; it's testing infrastructure reality, not code).

### Needs its own founder-level decision, not cleanly any of the above
- **No admin override exists for an order permanently stuck at
  `picked_up`/`in_transit`/`delivered`.** Not a missing timeout — the
  state machine has no transition out of these states except forward,
  and AdminJS's `orders` resource is fully read-only. A vanished driver
  or a customer who never confirms leaves an order stuck forever, with
  today's only resolution being an admin manually phoning someone. Real
  policy questions block this: should an admin be able to force-complete
  without the real OTP? What happens to the driver's payout? Does a
  force-cancel write off goods as a loss? — genuinely a founder decision.
- **GPS/location spoofing has no server-side plausibility check** — see
  §5 below; carried forward from the original July audit as still open,
  not a new finding.

---

## 4. Founder/legal action items — explicitly not code work

- **POPIA compliance documentation.** No Information Officer is
  registered with South Africa's Information Regulator (a real statutory
  requirement, independent of any app store); no documented data
  retention policy; no documented legal basis for processing. This is
  real, live regulatory exposure today, not a hypothetical — needs
  founder/legal attention directly, nothing here is fixable in code.
- **Apple EULA.** Apple's default Standard EULA applies automatically
  (legally sufficient, but generic — doesn't reference Flash's actual
  terms). Attaching Flash's own Terms as the custom EULA is a 5-minute
  App Store Connect action (App Information → License Agreement).
- **Submit the App Store "App Privacy" / Google Play "Data Safety"
  forms.** Both are hard submission-gate requirements on their
  respective platforms. The actual answers are drafted and grounded in
  what the code really collects — handed off as a console-answer-key
  document, not committed here (it isn't code).
- **Privacy policy website edit.** The live policy at
  `flashdelivery.co.za/privacy` doesn't name Paystack, Google Maps,
  Cloudinary, Sentry, or Resend — the specific corrected text is drafted
  and ready to hand to whoever manages the externally-hosted Netlify
  site. Also flags a real, still-unresolved inconsistency: the Privacy
  page's contact address for deletion requests doesn't match the Terms
  page's contact address — needs a founder pick, not a technical fix.
- **Masked calling — a real product decision, not just an engineering
  one** (see pre-launch gate #3): build it, or explicitly decide to
  launch without it.

---

## 5. Findings from the original (July) audit still open, never revisited in this pass

`docs/audits/PRODUCTION_READINESS_AUDIT.md` (2026-07-15) flagged a set of
Critical/High/Medium findings. Sections 2.1–2.14 never directly targeted
security-review findings — they targeted reliability/business-logic gaps.
Re-checked every item below directly against current source this session,
not carried forward on trust:

- **HIGH, unchanged — OAuth account auto-linking doesn't check the
  provider's email-verification claim, on both apps.** Confirmed
  directly in `authController.js`, across all four sign-in handlers:
  `googleSignInUser`, `appleSignInUser` (user app), and
  `googleSignInDriver`, `appleSignInDriver` (driver app) all have a
  "link to existing account by email" branch that auto-links and logs
  in as an existing user/driver purely by email match, with no check of
  `googleUser.emailVerified`/`appleUser.emailVerified` first. (An
  earlier draft of this finding named only the user-app handlers —
  corrected here after re-reading the driver-app handlers directly and
  finding the identical unchecked branch in both.) This is a real
  account-takeover vector under specific conditions (an attacker
  controlling an OAuth identity with an unverified email matching a
  victim's Flash user or driver account email) — still fully open,
  unchanged since July, and the fix needs to cover all four call sites,
  not just two.
- **HIGH, unchanged — GPS/location spoofing has no server-side
  plausibility check.** Confirmed: no speed-over-time or geofence
  re-validation exists anywhere in `Driver.js`'s location-update path.
  A spoofed position can still win order-matching priority.
- **HIGH, unchanged — store credit has no redemption path.** Confirmed:
  `store_credits` is only ever written to (issuance, in `Return.js`) —
  no controller anywhere reads it to apply credit at checkout. An
  orphaned financial feature that looks live to a user but leads nowhere.
- **Medium, unchanged — no chargeback/dispute webhook handling.**
  Confirmed: no `charge.dispute` (or equivalent) handler exists in
  `webhookController.js`.
- **Medium, unchanged — no account-level brute-force lockout,** only IP-
  based rate limiting. Confirmed: no login-attempt-tracking/lockout
  mechanism found anywhere in the codebase.
- **Medium, unchanged — account farming has no real defense.** Confirmed:
  no `UNIQUE` constraint on `users.phone`/`drivers.phone`, no CAPTCHA, no
  device fingerprinting.

None of these six were in scope for Sections 2.1–2.14 (which targeted
reliability/business-logic, not a fresh security pass) — listed here so
they're not mistaken for resolved just because they're old, and so the
score in §6 reflects them honestly.

---

## 6. Production readiness score

**66 / 100.**

This is deliberately close to the July audit's own score (6.5/10 = 65/100)
despite two months of substantial, real, independently-verified work —
and that closeness is the honest finding, not an oversight. Here's why.

**What's genuinely, measurably better since July:** order-lifecycle
reliability (stuck-order recovery across four separate failure modes,
store-side missed-order escalation), payment/refund correctness under
concurrency (two real, previously-reachable race conditions closed, both
verified via live Docker testing, not just unit mocks), commission-debt
accuracy (a real, live, wrong-since-inception formula fixed, real money
corrected), full admin visibility into every financial/dispute table, a
concrete and honest traffic-scaling analysis with the cheap fixes actually
applied, and a real App Store compliance pass that closed a genuine
rejection risk (the driver-subscription IAP exposure) before it caused
one. This is not superficial progress — every one of these was
independently re-tested this session or in its own section, live against
a real Postgres sandbox, not just asserted.

**Why the score doesn't reflect that progress more:** the score is
dominated by whether the *specific* things already flagged as most severe
are actually closed, and mostly they aren't:

- **The CI billing lock — the single thing July's own report called the
  "biggest process risk in the entire engagement" — is completely
  unchanged, verified live this session.** Every one of Sections 2.1–2.14's
  own commits, over two months of real work, landed with zero automated
  regression coverage. That's not a hypothetical risk; it's the actual
  process this audit itself ran under, and it will keep being the process
  every future change runs under until a founder resolves GitHub billing.
- **Both HIGH-severity security findings from July are still fully open**
  — re-verified directly in current source this session, not assumed.
  The OAuth account-takeover conditions and the GPS-spoofing gap present
  exactly the same risk today as they did in July.
- **A newly-confirmed, concrete, severe gap: Paystack card payments are
  broken in production right now**, not a hypothetical pre-launch item —
  the app is already shipping a client-side workaround (cash-only,
  card hidden) for a payment method that doesn't work. For a business
  whose entire model depends on taking payment, this is about as direct
  a production-readiness gap as exists, and it was confirmed live this
  session, not inferred from an old doc.
- Two months of real reliability engineering, fully offset by these three
  points staying exactly where they were (or, for Paystack, turning out
  to be worse in practice than the July report's more hedged phrasing).

**What would make this genuinely higher, with rough weight:**
- Fix the CI billing lock and get the existing test suite running
  automatically on every commit again (**+8 to +10** — this alone is the
  largest single lever, both because of its own severity and because it
  changes the trustworthiness of every future score).
- Add the missing `emailVerified` check to OAuth account auto-linking on
  both apps (**+4** — a small, well-scoped code fix for a real HIGH finding).
- Add at least a basic GPS speed-plausibility check that flags rather than
  blocks (**+3** — the cheap first step `OPEN_FOLLOWUPS.md` itself
  recommends, short of full device attestation).
- Get Paystack genuinely live, confirmed via the Render dashboard (not
  app logs), and the card-payment UI restored (**+10** — this is worth
  more than almost anything else on this list for a payments business).
- Complete the Google Maps key rotation (iOS builds, delete the two old
  leaked keys) and fix Sentry symbolication on both apps (**+4**
  combined — real, bounded, low-effort operational-safety items).
- Register a POPIA Information Officer and write a real retention policy;
  submit the App Privacy/Data Safety forms (**+5** combined — genuine
  regulatory exposure closed, not just paperwork).
- Resolve the store-credit/chargeback/account-lockout/phone-uniqueness
  Medium findings, and close the picked_up/in_transit stuck-order
  admin-override gap (**+4 to +6** combined, depending on how many are
  actually tackled — these are real but lower-severity than the items above).

The priority order for executing the above — sequenced, with the
founder/legal-entity dependency and the paused status explicitly noted —
is `POST_AUDIT_PRIORITY_ROADMAP.md`. **That roadmap is currently paused:
Vuyo does not have funding yet to act on it, and none of it should start
until he explicitly says to.**

Doing all of the above would put Flash in the high 80s to low 90s — not
100, since a genuine staging environment, a second Render instance, and
masked calling would still be deliberately-deferred, real infrastructure/
scope decisions rather than launch-blocking gaps at that point. **A score
in the 90s should require those to be closed too, not just the items
above** — this document isn't trying to define "100" as achievable soon,
only as honestly far enough away that claiming otherwise would be the
kind of overclaim this whole audit has tried not to make.
