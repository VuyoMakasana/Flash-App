# Flash — Open Follow-Ups

Real, tracked items that came up during other work and were deliberately
deferred rather than fixed on the spot. Each entry states what's actually
true today, why it was deferred, and exactly what "done" looks like — so
picking this up later doesn't require re-deriving any of it from memory.

Many of these items also appear, prioritized into an execution order, in
`POST_AUDIT_PRIORITY_ROADMAP.md` — **that roadmap is currently paused**
(Vuyo does not have funding yet to act on it; nothing there should start
until he explicitly says to), but it's the place to look for sequencing
once work on this list resumes.

---

## 1. `flash-user-app` production builds have Sentry source-map upload disabled

**Status:** Open. **Added:** 2026-09-06.

**What's true today:** `flash-user-app/eas.json`'s `production` build profile
has `SENTRY_DISABLE_AUTO_UPLOAD: "true"` set, with a `//` comment directly
above it in the file marking this temporary. Every production build made
while this is set has **no deobfuscated crash stack traces on Sentry** —
crashes still report, but with minified/obfuscated JS locations only.

**Why:** `@sentry/react-native` is registered as an Expo config plugin in
`app.config.js` with no `organization`/`project` configured, falling back to
environment variables — and no `SENTRY_AUTH_TOKEN` exists anywhere for this
project (checked both EAS project-scoped and account-scoped env vars,
2026-09-06 — neither exists). Without it, the release Gradle build's
`sentry-cli` upload step fails outright and takes the whole build down with
it (`Execution failed for task
':app:createBundleReleaseJsAndAssets_SentryUpload_...'`, confirmed via the
actual build log for build `9b0b9e1e-711d-46aa-aa87-47026a120fdd`). Disabling
auto-upload was the fastest way to get a working production build out during
the Google Maps API key rotation (F-01 follow-up), which couldn't wait on a
proper Sentry setup.

**To close this out:**
1. Generate a real Sentry auth token: sentry.io → Settings → Auth Tokens,
   `project:releases` scope at minimum.
2. Set it as an EAS env var for `flash-user-app` (`eas env:create production
   --name SENTRY_AUTH_TOKEN --value <token> --type string --visibility
   secret` — run this yourself, not through an assistant, same reasoning as
   the Maps key).
3. Also set `organization`/`project` explicitly in the `@sentry/react-native`
   plugin config in `app.config.js` rather than relying on env-var fallback.
4. Remove `SENTRY_DISABLE_AUTO_UPLOAD` and its `//` comment from
   `eas.json`'s `production` profile.
5. Run one real production build and confirm in the Sentry dashboard that
   the new release's source maps actually uploaded.

---

## 2. `flash-driver-app` has zero crash-report symbolication, silently

**Status:** Open. **Added:** 2026-09-06.

**What's true today:** `flash-driver-app/package.json` lists
`@sentry/react-native` as a dependency, but it is **never registered as an
Expo plugin** in `flash-driver-app/app.config.js` (confirmed by direct
comparison against `flash-user-app/app.config.js`, which does register it).
This means Sentry's native Android/iOS wiring never gets added to this
app's build at all — no init call reaching native crash handlers the way
the plugin would configure, and (the reason this was even noticed) no
`SentryUpload` Gradle task exists in its build either, so there was no
error to surface the gap. Crashes in the driver app are very likely not
reaching Sentry in a fully symbolicated, or possibly any, useful form
today — not independently confirmed by checking the Sentry dashboard
itself, so verify that as the first step below, not assume the worst.

**Why deferred:** Found incidentally while diagnosing item #1 above (a
build succeeded for driver-app specifically *because* this plugin wiring
is missing, which is what made the two apps' build behavior diverge).
Not part of the Google Maps key rotation this was found during — a real,
separate gap.

**To close this out:**
1. Check the Sentry dashboard first — confirm what, if anything, is
   currently being received from the driver app, so the actual starting
   point is known rather than assumed.
2. Add `'@sentry/react-native'` to `flash-driver-app/app.config.js`'s
   `plugins` array, matching `flash-user-app`'s configuration.
3. This will very likely surface the *same* Sentry-upload build failure
   documented in item #1 above, the moment it's wired in — budget for
   doing both items together, or expect driver-app's production builds to
   start failing the same way user-app's did until `SENTRY_AUTH_TOKEN` is
   set for this project too.
4. Confirm with a real test build that crash reports actually reach
   Sentry with real stack traces afterward.

---

## 3. `driverCommission.test.js` has a pre-existing failing test

**Status:** Resolved. **Added:** 2026-09-07. **Resolved:** 2026-09-08
(§2.8 commission-debt audit follow-up).

**Root cause, confirmed by reading the real query text:**
`recordCashCommission`'s wallet-deduction `UPDATE` aligns its `SET` clause
with padding spaces for readability —
`` `UPDATE driver_wallets SET wallet_balance         = wallet_balance - $1, ...` ``
— while the test's assertion used a plain
`.includes('wallet_balance = wallet_balance - $1')` with single spaces.
`.includes()` requires an exact substring match, so the extra alignment
whitespace in the real (correct) query never matched the test's
(incorrectly strict) expected string. **The deduction logic itself was
never wrong** — this was purely a test-assertion bug, confirmed by reading
the query character-for-character rather than guessing.

**Fix:** changed the assertion from `.includes('wallet_balance =
wallet_balance - $1')` to a whitespace-tolerant regex
(`/wallet_balance\s*=\s*wallet_balance\s*-\s*\$1/`). No production code
needed to change for this specific failure.

**Found while fixing a real, separate bug in the same function**
(the driver cash-commission-debt audit requested alongside §2.8: the
commission amount recorded per cash delivery was a hardcoded flat R20
regardless of order size, instead of reusing the same percentage-based
`flashCommission` formula already used for card orders. See
`docs/audits/SECTION_2.8_COMMISSION_DEBT_AUDIT.md` for that fix). Since
touching `recordCashCommission` already required rewriting this test
file's mock sequences (an added order-lookup query shifted every
`mockResolvedValueOnce` index), root-causing and fixing this pre-existing
failure at the same time was effectively free — confirmed via `npm test`
that the full suite is now green with no known failures other than the
`adminCoverage.test.js` host-vs-Docker-network artifact (only reproduces
outside the container; passes when run inside Docker, already documented
history).

---

## 4. No wrong-direction / off-course detection for a driver mid-delivery

**Status:** Open — tracked future enhancement, not a pre-launch gate.
**Added:** 2026-09-07.

**What's true today:** the production-readiness audit (§2.3, navigation
and live tracking) confirmed real *time-based* stuck-delivery detection
exists (the 45-min `driver_assigned`/`driver_arrived_store` reassignment
cron in `server.js`, plus `orders.driver_connection_flagged_at` for a
driver gone silent mid-delivery) but nothing *spatial* — no check
anywhere for a driver whose live position is moving away from the
destination rather than toward it, or who's stopped making progress
without going fully silent.

**Why deferred:** this is a real quality/fraud-adjacent improvement
(overlaps with §2.4's driver-fraud lifecycle) but not a safety or
compliance blocker for the closed pilot — the founder classified it as a
quality improvement, not a pre-launch gate, distinct from items like
`DRIVER_TEST_MODE` or Paystack going live.

**To close this out:**
1. Design a bearing/heading-based algorithm using the existing
   `driver_locations` history (persisted every 5th ping) — e.g., comparing
   the trend of `calculateDistance()` (`Driver.js`) to the dropoff over the
   last N persisted points, not a single ping, to avoid false positives
   from normal street-routing detours (a driver going "away" briefly to
   take a real road is not the same as actually heading the wrong way).
2. Decide the false-positive tolerance carefully before building anything
   — a same-day courier in an unfamiliar area legitimately backtracks;
   flagging that as suspicious too eagerly would create noise admins
   learn to ignore, defeating the point.
3. Surface it as an admin-visible flag/alert (§2.13), not an automatic
   penalty against the driver — a human should confirm before any
   consequence (matches the "admin must be able to reconstruct exactly
   what happened" bar from §2.4).

---

## 5. ETA is straight-line distance ÷ assumed speed, not real road-routing time

**Status:** Open — tracked future enhancement, not a pre-launch gate.
**Added:** 2026-09-07.

**What's true today:** `Driver.calculateDistance()`/`estimateMinutes()`
(`backend/src/models/Driver.js`) compute a haversine (straight-line)
distance between the driver's current ping and the order's dropoff, then
divide by an assumed flat 25km/h to get minutes. This is now surfaced
persistently on the customer's tracking screen (§2.3 fix, not just the
four milestone toasts) as well as feeding those toasts and the cash
reminder. It's a reasonable approximation for a compact same-day courier
context, but will be visibly wrong on routes with real detours, one-way
streets, or traffic — a driver 500m away by road can be much further by
the assumed flat speed if the direct line crosses water/a blocked route,
and vice versa.

**Why deferred:** a real fix means integrating a routing API (Google
Directions/Distance Matrix, or similar) that returns actual drive-time
estimates along real roads — a genuine recurring third-party cost and a
new external dependency, the same shape of decision as the masked-calling
one deferred from §2.2. Not a safety/compliance blocker, a quality
improvement.

**To close this out:**
1. Pick a routing provider and confirm its NMB-area (Nelson Mandela Bay)
   coverage and pricing at expected ping volume — note `driver_locations`
   only persists every 5th ping, but ETA is computed on *every* ping
   today (`Driver.updateLocation`), so a naive per-ping routing-API call
   would be far more expensive than the current in-process haversine
   math; would need throttling (e.g., only re-query the routing API every
   N seconds or M meters of movement) to be cost-viable.
2. Replace `calculateDistance`/`estimateMinutes`'s straight-line math with
   the routing API's real distance/duration for the same two call sites
   (the persistent ETA and the milestone-toast thresholds) so both stay
   consistent with each other.
3. Confirm the milestone thresholds (15/10/5/2 min, "arrived" at 150m)
   still make sense against real drive-time estimates rather than the
   straight-line ones they were tuned against.

---

## 6. GPS/location spoofing has no server-side plausibility check

**Status:** Open — tracked future enhancement, not a pre-launch gate.
**Added:** 2026-09-07 (production-readiness audit §2.4, driver
fraud/theft/order-security lifecycle). **Not a new discovery** — already
flagged as a HIGH finding in `docs/audits/PRODUCTION_READINESS_AUDIT.md`
§8.1 (2026-07-15); recorded here too so it sits alongside this audit's
other deferred cost/complexity decisions in one place, not to claim it as
newly found.

**What's true today:** `Driver.updateLocation()`
(`backend/src/models/Driver.js`) does a bare `UPDATE` of whatever
`lat`/`lng` the driver's app reports — no speed-over-time plausibility
check (e.g., rejecting/flagging a ping that implies >150-200 km/h travel
since the last one), and the Nelson Mandela Bay service-area geofence
(`geoBoundary.js`) is only checked at order-dropoff creation and when a
driver flips online, never re-validated on subsequent pings. A driver
using a location-mocking tool (or calling the location endpoint directly
with fabricated coordinates) can report a position adjacent to any
pickup point to win order-matching priority (`autoMatchService.js`
computes nearest-driver directly off this same unvalidated,
self-reported location) regardless of true physical location, and the
persistent ETA / arrival-milestone system added in this audit's §2.3
work would show equally confident (and equally wrong) numbers for a
spoofed position, since neither knows the difference between a real and
a faked ping.

**Why deferred:** a real fix (device attestation via Play Integrity API /
Apple DeviceCheck to detect a rooted/mocked-location device, or even the
simpler speed-plausibility check `PRODUCTION_READINESS_AUDIT.md` §8.1
recommends) is a genuine scope/complexity decision, not a quick patch —
same treatment as masked calling (§2.2) and real road-routing ETA (§5
above): a real engineering investment, not something to build
speculatively without the founder weighing the cost against how much
this matters at current driver volume.

**To close this out:**
1. Start with the cheap version `PRODUCTION_READINESS_AUDIT.md` §8.1
   already recommends: a speed-plausibility check between consecutive
   pings in `Driver.updateLocation()` (flag, don't necessarily block —
   a false positive blocking a real driver's legitimate ping is worse
   than a missed detection), plus re-running the geofence check
   periodically instead of only at the online-toggle moment.
2. If spoofing is ever observed as a real, material problem (not just a
   theoretical gap), consider device-attestation APIs (Play
   Integrity/DeviceCheck) — a bigger mobile-side change, only worth it
   once there's evidence of actual abuse rather than built ahead of need.
3. Whatever's built should feed the same admin-visibility principle as
   the rest of §2.4 — a flagged/suspicious ping should be reconstructable
   by an admin later (who, when, what the implausible jump was), not just
   silently rejected or silently logged to console.

---

## 7. Backend runs as a single instance on Render's free tier

**Status:** Open — deferred cost decision, not a pre-launch gate.
**Added:** 2026-09-07 (production-readiness audit §2.5, deployment
safety).

**What's true today:** the `Flash-App` Render service is confirmed
(via Render's own API) running `numInstances: 1` on `plan: free`. Two
distinct real implications: zero redundancy (any crash, hung process, or
bad deploy takes the entire backend down with no failover), and Render's
free tier spins a service down after ~15 minutes of inactivity, cold-
starting (real added latency, plausibly tens of seconds) on the next
request — a realistic pattern for a closed pilot with sporadic usage.

**Why deferred:** upgrading to a paid plan and/or running multiple
instances is a real, recurring cost decision — appropriate to make
deliberately as usage grows, not a code fix.

**To close this out:**
1. Decide the trigger point (real user complaints about cold-start
   latency, or simply "before public launch") for upgrading off the free
   tier.
2. If moving to multiple instances, note that `Driver.updateLocation()`'s
   `_pingCounters` (the "persist every 5th ping" counter,
   `backend/src/models/Driver.js`) is in-memory and per-process — it
   would need to move to something shared (Redis, or a DB-tracked
   counter) to keep working correctly across instances; today, with 1
   instance, this isn't an issue.
3. Apply the build-command/health-check fixes in
   `docs/audits/DEPLOYMENT_SAFETY_RECOMMENDATIONS.md` first regardless —
   they're correct at any instance count and cost nothing.

---

## 8. No staging environment; Render service config isn't version-controlled

**Status:** Open — deferred, not a pre-launch gate.
**Added:** 2026-09-07 (production-readiness audit §2.5).

**What's true today:** every change goes straight from local Docker-
sandbox testing to production — there's no shared staging deployment.
Separately, the Render service's own configuration (build/start commands,
health check, plan, region) exists only in Render's dashboard, not as a
version-controlled `render.yaml` Blueprint in this repo — so there's no
reproducible, reviewable record of the production service's own
configuration, and no easy way to spin up a second (staging) copy of it
from the repo alone.

**Why deferred:** a real staging environment is a recurring cost (a
second Postgres instance, a second web service) and a real workflow
change (a promote-to-production step); worth building deliberately once
the team/change velocity justifies it, not speculatively now.

**To close this out:**
1. Consider a `render.yaml` Blueprint checked into the repo, even before
   standing up a real staging service — it would at least make the
   production config reviewable/versioned, and is the natural vehicle
   for a future staging environment (a Blueprint can define both
   services, pointed at different branches).
2. When ready for staging, model its data from a sanitized copy of
   production, not a live replica — this repo already has no export/seed
   tooling for that, worth building alongside.

---

## 9. No mobile app-version / force-update gating

**Status:** Open — deferred, not a pre-launch gate.
**Added:** 2026-09-07 (production-readiness audit §2.5).

**What's true today:** nothing in the backend checks the calling app's
version, and neither app has a "please update" flow. If a backend API
change is ever breaking for an older app version still in real use
(plausible during an App Store/Play Store review delay, when both old
and new versions can be live simultaneously against the same backend),
there's no mechanism to detect or gate that — compatibility depends
entirely on backward-compatibility discipline in how backend changes are
made, not an enforced mechanism.

**Why deferred:** low urgency at current scale/release cadence (a closed
pilot with infrequent releases); building this is a real, if small,
cross-cutting change (both apps need to report their version on every
relevant request, and the backend needs a real minimum-version registry
plus a real "update required" UI state in both apps).

**To close this out:**
1. Add an app-version header (or query param) sent on every API request
   from both apps (already have `EXPO_PUBLIC_API_BASE_URL` as a precedent
   for app-level config; the app's own version is available via
   `expo-constants`).
2. Backend: a simple minimum-supported-version config (env var or a
   tiny DB table), checked in `middleware/auth.js` or a dedicated
   middleware, returning a distinct error code an old app can recognize.
3. Both apps: a real "please update" screen/blocking modal when that
   error code is received, linking to the relevant app store.

---

## 10. No feature-flag / kill-switch system

**Status:** Open — deferred, not a pre-launch gate.
**Added:** 2026-09-07 (production-readiness audit §2.5).

**What's true today:** every deploy is all-or-nothing — there's no way
to gradually roll out a risky change to a subset of users, or to
instantly disable a broken feature without a full redeploy (and, per
item #1/#7 above, a redeploy currently also means re-running the manual
migration step and briefly dropping every live socket connection).

**Why deferred:** a real third-party service or in-house system
(LaunchDarkly, GrowthBook, or even a simple DB-backed flags table) is a
deliberate infrastructure investment, not a quick patch — worth adopting
once there's a specific risky feature that would benefit from gradual
rollout, rather than built speculatively now. (Note: PostHog, already
planned for analytics per this audit's §3.4, includes basic feature
flags in its free tier — worth checking whether it covers this need
before evaluating a dedicated flags service separately.)

**To close this out:**
1. When PostHog is installed (§3.4), evaluate whether its built-in
   feature-flag support is sufficient before adopting a separate tool.
2. Start with the highest-risk category first (payment/order-state-
   machine changes) rather than trying to flag everything at once.

---

## 11. No explicit failure handling on the tracking screen's MapView

**Status:** Open — logged for awareness, not a fix candidate right now.
**Added:** 2026-09-07 (production-readiness audit §2.6, live-usage
failure scenarios).

**What's true today:** `flash-user-app/screens/TrackingScreen.js`'s
`MapView` (`react-native-maps`, `PROVIDER_GOOGLE`) has no `onError`
handler. If the Google Maps API key were ever invalid, rate-limited, or
the service unreachable, there's no explicit in-app handling for that
case.

**Why not fixed now:** `react-native-maps` degrades to a blank map
canvas rather than crashing when tiles fail to load, and nothing else on
the screen (order status, the persistent ETA added in §2.3, the driver
card, chat/call buttons) depends on the map rendering successfully — so
in practice this is a soft, low-severity gap. No evidence it's actually
degrading the real experience; not worth building a fallback UI for
speculatively.

**To close this out, if it ever becomes a real problem:** add an
`onError` handler that shows a small "map unavailable" banner in place
of the blank canvas, so the gap is at least visibly explained rather than
looking like a rendering bug.

---

## 12. No admin override for an order permanently stuck at picked_up/in_transit/delivered

**Status:** Open — a real trust/policy decision, deliberately not built.
**Added:** 2026-09-09 (production-readiness audit §2.10, stuck-order state
machine).

**What's true today:** `ALLOWED_TRANSITIONS.picked_up = ['in_transit']`
and `in_transit = ['delivered']` — neither allows `cancelled`. This isn't
a missing timeout; the order state machine itself has no path out of
either state except forward to `delivered`. If a driver genuinely vanishes
with the goods (device destroyed, quits mid-delivery), the order is
**permanently** stuck — the existing 25-minute driver-connection-lost flag
(and the 2-hour stuck-at-delivered flag, for the equivalent case where the
*customer* never confirms the OTP) just marks the order visible in the
admin panel forever, with no software path to ever close it out.
Compounding this: AdminJS's `orders` resource is deliberately fully
read-only (`edit: { isAccessible: false }`, confirmed by reading
`adminPanel.js` — no generic status editor, no "force complete"/"force
cancel" action of any kind exists anywhere in the codebase). Resolution
today is 100% outside the software — an admin has to notice the flag and
resolve it by, e.g., phoning the customer or driver directly.

**Why deferred:** building a safe admin override here isn't a pure bug
fix, it's a real trust/authorization decision — should an admin be able to
force-complete an order (releasing the driver's payout, marking the
customer as having received goods) without the real OTP that mechanism
exists specifically to require? Should force-cancelling an in-transit
order write off the goods as a loss, trigger a `driver_penalties` row, or
something else? These are business/policy calls, not something to decide
silently while auditing timeouts — matches this audit's standing rule
(the same discipline already applied to the cancellation split, the
premium subscription perk, and other founder-level calls throughout this
engagement).

**To close this out:**
1. Decide the actual policy first: what evidence (a phone call transcript?
   a photo? nothing, admin discretion?) should be required before an admin
   force-completes or force-cancels an order this way.
2. Design the admin action with a mandatory justification field and a full
   audit trail (matches this audit's existing "admin must be able to
   reconstruct exactly what happened" bar from §2.4) — never a silent
   status edit.
3. Decide what happens to the driver's payout/penalty and (for a
   force-cancel) the customer's refund in each case — these aren't
   automatic consequences of the existing state machine today, since this
   path doesn't exist yet.
4. Notify the other party (the customer, if an admin acts on a stuck
   in-transit order; the driver, if an admin acts on a stuck delivered
   order) so neither side is left silently guessing what happened to their
   order.

---

## 13. `/api/store-auth/reset-password` has no rate limiter

Surfaced while building store suspension (`STORE_SUSPENSION_RECORD.md` §7).

Every other write on the store-auth surface is throttled — `login` carries
both `storeAuthLimiter` and `storeAccountLoginLockout`, `forgot-password` is
limited, and the public onboarding endpoint allows 5/hour/IP. `reset-password`
has **none**. It is reachable unauthenticated by anyone holding a token
string, and it is the endpoint that sets a password.

**Why this is not urgent:** the token is `crypto.randomBytes(48)` — 384 bits.
Guessing one is not a practical attack, and the endpoint already refuses any
token that is used or expired, inside a transaction. So this is defence in
depth rather than a live hole.

**Why it still matters:** it is the only unthrottled write in the auth
surface, which makes it the natural place for an unbounded-request bug to hide
later, and there is no cost signal if someone starts hammering it. It is also
the one endpoint where a future weakening of token entropy would go from
harmless to serious with nothing else standing in the way.

**To close this out:**
1. Add a limiter to `POST /api/store-auth/reset-password` in
   `storeAuthRoutes.js`, keyed by IP, sized so a real person mistyping a
   pasted code several times is never blocked — the onboarding setup code is
   96 characters and gets pasted out of an email, so a few failures per person
   is normal rather than suspicious.
2. Decide whether to also key by token prefix, so one IP cannot grind many
   different tokens while staying under a per-IP ceiling.
3. Keep the rate-limited response identical to what the endpoint already
   returns for an invalid token, so the limiter itself does not become an
   oracle for "this token exists".

---

## 14. No per-account admin revocation of a live store session

Surfaced while building store suspension (`STORE_SUSPENSION_RECORD.md` §7).

`revoked_tokens` is keyed by the JWT `jti`, and the only thing that ever
writes to it is the user's own `POST /logout`. Nothing records which `jti`
values are outstanding for an account, so an admin cannot terminate one staff
member's session. Deactivating the account (`store_users.is_active = false`)
does work, because `authenticateStore` re-checks it live — but that is a
bigger hammer than "sign this person out".

Store suspension (merged) covers the whole-store case, which was the urgent
one: a suspended store's staff lose access on their very next request. This
item is the narrower remaining gap.

**Why it was deferred:** the dangerous case — cutting off an entire store — is
handled, and handled by re-reading live state rather than by tracking tokens,
which is strictly more reliable. Solving the per-account case properly means
either storing issued `jti` values per account (new table, new cleanup cron) or
adding a `sessions_valid_from` column compared against the token's `iat`.

**To close this out:**
1. Prefer the `sessions_valid_from` approach over a token registry — it reuses
   the exact pattern already proven by the `password_changed_at` check in
   `authenticateStore`, needs no cleanup job, and costs no extra query, since
   that row is already read on every request.
2. Give admins an action that stamps it, with the usual `admin_actions` audit
   entry.
3. Decide whether an Owner should be able to do this to their own staff from
   the Store Portal, or whether it stays Flash-only. That is a product call.

---

## 15. Suspending a store notifies nobody

Surfaced while building store suspension (`STORE_SUSPENSION_RECORD.md` §7).

`Store.suspend()` changes state and nothing else. The owner finds out by being
signed out mid-task and shown "This store is not currently active. Please
contact Flash support." — accurate, and deliberately non-specific, but not an
explanation, and they got no warning.

There is a second, worse silence. Suspending a store with orders still in
`pending_store_acceptance` means those orders are auto-cancelled and refunded
within ~30 minutes by the existing acceptance-timeout cron (traced in
`STORE_SUSPENSION_RECORD.md` §4 — that cron has no store filter, so it applies
here unchanged). That is the intended outcome, but neither the store nor those
customers are told it happened because of a suspension rather than the store
simply not responding.

**Why it was deferred:** the safety control had to land first, and suspension
is currently only reachable by a Flash admin who can pick up the phone.
Automated notification also depends on bounce visibility being in place —
telling an owner by email that they have been suspended is worthless if the
email silently bounces, which is exactly the blind spot that exists today
(`STORE_ONBOARDING_FRONTEND_RECORD.md` §6).

**To close this out:**
1. Do bounce visibility first. A suspension notice that silently fails to
   deliver is worse than none, because Flash would then believe the owner had
   been told.
2. Email the owner on suspension and on reactivation, using the reason already
   captured in `stores.rejection_reason` by `Store.suspend()`.
3. Decide whether affected customers get a distinct message rather than the
   generic "store didn't respond" cancellation they receive today. That is a
   customer-trust call, not purely technical.
4. Consider whether suspension should ever be warned or scheduled rather than
   immediate. For fraud, immediate is correct; for an administrative issue such
   as lapsed details, a warning window may be fairer.

---

## 16. Render auto-deploys ahead of pending migrations, with no gate

**This item was discussed in two earlier sessions and referred to by number,
but was never actually written into this file — it is being recorded properly
now.** That omission is itself the lesson: it existed only in conversation, and
it nearly caused an outage.

Migrations do **not** run on boot. `grep -nE "migrate|runMigrations"
backend/src/server.js backend/server.js` returns nothing; `npm run migrate` is
a separate manual step. But the `Flash-App` service has `autoDeploy: yes` on
`main`, so merging a PR deploys new code immediately, whether or not the schema
it depends on exists yet.

This came within one action of breaking production during the store-onboarding
work. PR #12's code hard-required `stores.status` in `Store.listActive()` and
`findPublicById()`, which back `GET /api/stores` — the public storefront the
customer app reads. Merging before applying migration v36 would have returned
`column "status" does not exist` to every customer. It was caught only because
the sequencing was checked by hand first, and v36 was applied before the merge.

**Why it was deferred:** the expand-then-migrate discipline (additive schema
first, then deploy) works when followed, and it has been followed so far. This
item is about removing the reliance on remembering.

**To close this out:**
1. Decide the mechanism. A Render pre-deploy command running
   `node src/db/migrate.js` is the smallest change, and the runner is already
   idempotent (`CREATE ... IF NOT EXISTS`, and v36's backfill is guarded by
   `WHERE status IS NULL`). Note this couples deploy success to migration
   success — which is the point, but it means a bad migration blocks the deploy
   rather than half-applying.
2. Alternatively keep migrations manual, but add a boot-time schema assertion
   that fails loudly and refuses to serve, rather than serving per-request
   500s.
3. Either way, put the expand-then-migrate rule where someone merging a PR
   will actually see it — `CLAUDE.md` or the PR template, not only an audit
   doc.
## 17. Driver bank account numbers are stored in plaintext

**Scheduled: immediately after Phase 2 wraps — not open-ended.**

`transfer_recipients.account_number` is a plain `VARCHAR(255)`, and
`driverController.js:640` inserts the raw account number straight into it. No
encryption is applied anywhere on that path.

What makes this worth a tracked item rather than a shrug: the codebase
**already has** the tool. `utils/paymentCrypto.js` implements AES-256-GCM with
a key from `PAYMENT_METHOD_ENCRYPTION_KEY` and throws in production if the key
is absent. It is used for stored card authorisation codes. It simply was not
used here.

**Why it is not urgent:** the account number alone is not sufficient to move
money out of an account, and the same value is already held by Paystack. The
realistic exposure is a database dump or an over-broad read — real, but not a
live path to theft.

**Why it should not be left:** it is a straightforward data-at-rest failure in
the one table that names where a real person's money goes, and Flash is about
to build the store equivalent. Store payouts (Phase 2a) deliberately take the
stronger approach — store only Paystack's `recipient_code` plus `bank_name`,
`account_last4` and `account_name`, never the full number, because data not
held cannot leak. That will leave two adjacent tables with different postures
until this is closed.

**To close this out:**
1. Decide between encrypting `account_number` with the existing `paymentCrypto`
   and **dropping the column entirely**, keeping only a `last4`. Dropping is
   preferable and should be checked first: search every read of
   `account_number` — the `ON CONFLICT (driver_id, account_number, bank_code)`
   clause in `driverController` is the one real dependency, and it can key on
   `recipient_code` instead. Paystack already holds the authoritative value, so
   Flash very likely does not need it at all.
2. If dropping, write the migration as expand-then-contract: add `account_last4`,
   backfill from `account_number`, deploy code that reads only `last4`, and drop
   the old column in a later migration — never in one step.
3. Whichever path, make the two tables consistent and say so in the driver
   payout docs, so a future developer does not copy the weaker pattern again.

---

## 18. `orders.store_paid` means "the customer paid by card", not "the store was paid"

Surfaced while scoping Phase 2 (`PHASE2_STORE_PAYOUTS_PLAN.md` §1.2).

The column name says the store has been paid. What it actually records is that
a **customer's card payment succeeded**. It is set `true` at exactly three
sites, all card paths: `webhookController.js:172` (matches on
`paystack_reference`), `Payment.js:83`, and `paymentReconciliationJob.js:29`
(only iterates orders that have a `paystack_reference`). A cash order never
touches any of them.

**This is a latent trap for settlement work, and the reason it is subtle is
that production data currently hides it.** Verified: 19 orders, `store_paid`
true on **zero** of them, and no `paystack_reference` anywhere — the only two
completed orders are cash. So today the column reads `false` universally and
looks like an unused flag that is free to adopt. The first card order to
complete flips it to `true`, and any settlement logic that had adopted it as
"this store has been settled" would immediately and silently conclude that the
store had already been paid.

**Why it was deferred:** renaming a column touches five files and a migration,
and Phase 2 deliberately does not reuse the field, so nothing is blocked. The
danger is entirely to a *future* developer who reads the name and believes it.

**To close this out:**
1. Prefer renaming to something honest — `card_payment_captured` or
   `customer_paid_at` (a timestamp would be strictly more useful than a
   boolean) — via expand-then-contract: add the new column, write both, migrate
   readers, drop the old one later.
2. If renaming is judged not worth the churn, add an explicit comment at the
   migration's column definition and at all three write sites. That is weaker,
   since it relies on someone reading the right line.
3. Either way, do it **before** 2c, so no settlement code is ever written next
   to a column whose name asserts the opposite of what it means.

---

## 19. `order_cancellation_store_shares` records money owed to stores and never pays it

Surfaced while scoping Phase 2 (`PHASE2_STORE_PAYOUTS_PLAN.md`).

When an order is cancelled, `computeCancellationSplit` allocates a share of item
value to the store (10% pre-arrival, 0% once the driver has reached the store),
and `orderController` writes it to `order_cancellation_store_shares`. That table
is then read in exactly one place: `Admin.getCancellations()`, for display in the
admin panel.

**Nothing ever pays it.** It is a write-only record of a real liability. No
disbursement path exists, because Store Settlement does not exist yet.

**Why it was deferred:** it is harmless while no settlement mechanism exists at
all — the money simply has not been paid to anyone, and the amounts are
recorded, so nothing is lost or unaccounted for. It becomes a genuine problem
the moment settlement starts and these shares are *not* included, because then
stores are being paid for completed orders while an acknowledged debt from
cancelled ones quietly accumulates beside it forever.

**To close this out:**
1. Decide during 2c whether cancellation shares are settled through the same
   `store_settlements` cycle as completed orders. They should be — a store's
   payout ought to be one number it can reconcile, not two mechanisms — which
   means `store_settlement_line_items` needs to represent a cancellation share
   as well as an order line, or carry a `source` discriminator.
2. Decide what happens to shares accrued **before** settlement existed. There
   may be a real backlog by then; paying it or explicitly writing it off are
   both defensible, but it should be a decision, not an accident of the cutoff
   date chosen for the first cycle.
3. Note the interaction with §3.4's netting rule: a cancellation share is a
   credit to the store, while a post-settlement return is a debit. Both land in
   the next open cycle, so the sign convention on line items needs to handle
   both without ambiguity.

---

## 20. Cash orders: nobody records that the store is owed its item value

**BLOCKER FOR PHASE 2c SCOPING.** Not a blocker for 2b, which ships
independently of it.

Found while tracing the completion path for commission stamping
(`PHASE2B_COMMISSION_RECORD.md`).

On a **card** order Flash receives the customer's money, so settling item value
to the store is Flash paying out money it holds. On a **cash** order that is not
what happens at all:

1. The driver collects `subtotal + delivery_fee` from the customer in cash.
2. `confirmCashReceived` marks the order paid and calls
   `driverCommissionService.recordCashCommission`, which records that the driver
   owes Flash the **delivery** commission — `max(10, 25% of delivery_fee)`.
3. **Nothing records the `subtotal`.** That is the store's money, and it is
   physically in the driver's pocket.

So for a completed cash order there is no record that the store is owed
anything, no record that the driver is holding it, and no mechanism by which it
reaches the store. Flash cannot settle it, because Flash never received it.

**Why this is urgent specifically for 2c:** every completed order in Flash's
production history is cash — 2 of 2 completed, 19 of 19 overall. A settlement
run built on the card assumption would either pay stores money Flash does not
have, or silently skip every order that exists.

**What 2b does about it:** stamps the commission regardless, because the
arithmetic is identical — Flash has earned its share of item value however the
customer paid. `orders.payment_method` is already on the row, so 2c can branch
without a new column. 2b deliberately takes no position on settlement.

**To close this out — a business decision first, then code:**

1. Decide the real-world cash flow. The two plausible models:
   - **Driver hands item value to the store.** Then Flash settles nothing for
     cash orders, and needs to record the hand-over so a dispute is
     reconstructable. Flash is still owed its commission, which the existing
     `driver_commission_debts` mechanism could carry.
   - **Driver owes Flash the full collected amount, Flash settles the store.**
     Then `recordCashCommission` is recording only part of what the driver owes,
     and the item value needs the same debt treatment — a much larger change to
     the driver wallet model, and a much larger float sitting with drivers.
2. Whichever is chosen, make it explicit in `FINANCIAL_DOMAIN_SPECIFICATION.md`
   — the document currently describes Store Settlement without distinguishing
   payment method, which is the gap that let this go unnoticed.
3. Only then scope 2c. Settlement cannot be designed without knowing which of
   the two above is true, because they produce completely different money flows
   for the only order type that exists in production today.

**Related:** OPEN_FOLLOWUPS #19 (`order_cancellation_store_shares` is
write-only) is the same class of problem — money owed to a store that nothing
pays. Both should be resolved in the same pass, since both land in the same
settlement cycle.
