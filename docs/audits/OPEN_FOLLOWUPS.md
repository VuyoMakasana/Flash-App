# Flash — Open Follow-Ups

Real, tracked items that came up during other work and were deliberately
deferred rather than fixed on the spot. Each entry states what's actually
true today, why it was deferred, and exactly what "done" looks like — so
picking this up later doesn't require re-deriving any of it from memory.

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

**Status:** Open. **Added:** 2026-09-07.

**What's true today:** `tests/unit/driverCommission.test.js` — `recordCashCommission
› auto-deducts from wallet when balance >= R20` — fails with
`expect(updateCall).toBeDefined()` receiving `undefined`: the test asserts
`commissionService.recordCashCommission()` issues a query containing
`wallet_balance = wallet_balance - $1`, and no mocked call matches that
string. `driverCommissionService.js` itself has not been touched since
`768bbbb` ("feat: add driver cash commission service (R20 per delivery)")
— confirmed via `git diff` against this commit that neither the service
nor the test changed as part of the production-readiness audit's account-
deletion work (§2.1) or the `main` merge done alongside it. This is a
pre-existing mock-assertion mismatch (either the real query text drifted
from what the test expects, or a mock-response ordering issue), unrelated
to and not introduced by this audit.

**Why deferred:** Found only because this audit ran the full test suite
directly (`npm test`) rather than relying on CI, which normally does this
on every push to `main` — this branch (and its unmerged predecessor
branches) had accumulated commits without a full local test run in
between. Root-causing a mock/assertion mismatch in an unrelated service
is out of scope for the account-deletion section that surfaced it; fixing
it blind (e.g. loosening the assertion) without confirming which side —
the real query or the test's expectation — is actually wrong would risk
masking a real commission-deduction bug instead of a stale test.

**To close this out:**
1. Read `commissionService.recordCashCommission()`'s actual wallet-deduction
   query and compare it literally against the test's expected substring
   (`wallet_balance = wallet_balance - $1`) — confirm whether the code or
   the test drifted.
2. Check the other two tests in the same file (`blocks driver when debt >=
   R200 threshold`, `blocks driver when unpaid_cash_deliveries >= 10`) —
   both pass today, so compare their mock call sequences against the
   failing test's to spot what's different (likely a missing/misordered
   `mockResolvedValueOnce` in the failing test's setup, given the other two
   short-circuit before reaching the deduction query at all).
3. Fix whichever side is actually wrong, then confirm `npm test` is fully
   green (this was the last remaining known failure once
   `premium_subscription_payments` was added to `adminCoverage.js`,
   §2.1/§2.14).
