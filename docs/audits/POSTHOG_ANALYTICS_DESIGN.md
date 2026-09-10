# PostHog Analytics — Design (not yet implemented)

**Date:** 2026-09-10. **Status:** design only — no tracking code has been
written, and none should be until this is reviewed. This follows the same
audit→explain→design→implement→test→document process as every other
section, stopping after "design" per the explicit instruction to report
back before writing anything.

**The one thing blocking real implementation:** a real PostHog account
and API key. Nothing here can start sending real events until that
exists — this is a founder action, not something buildable or fakeable
from here (a placeholder/test key would either silently fail or send
real events to nobody's account). Once the account exists, wiring in the
official `posthog-react-native` SDK against the event taxonomy below is
a small, mechanical implementation step.

---

## 1. What this is for

Product visibility Flash currently doesn't have: which screens people
actually use, where they drop off between opening the app and placing an
order, whether drivers who go online actually get matched, which payment
method people pick when both are available again (once the Paystack
pre-launch gate is closed). None of this requires PII-level tracking —
event counts and funnel shape are the goal, not individual behavior
profiling.

## 2. Event taxonomy

Every event uses `distinct_id` = the real `users.id`/`drivers.id` already
in Postgres (so behavior can be joined back to a real account for support/
debugging), never an email or phone number in an event property. No event
below carries card numbers, passwords, tokens, or full delivery addresses
— matching the same data-minimization posture already established for
Sentry (`_layout.js`'s existing scrub pattern in the driver app is the
right model to reuse for PostHog's own `before_send`/property allowlist).

### flash-user-app (customer)

| Event | When | Key properties |
|---|---|---|
| `user_signed_up` | Registration completes (any method) | `signup_method` (password/google/apple) |
| `user_logged_in` | Successful login | `login_method` |
| `screen_viewed` | Home, Store, Product, Cart, Checkout, Payment, Tracking, Profile, Orders — these 9 only, not every screen | `screen_name` |
| `payment_method_selected` | At checkout, when card/cash is chosen | `method` (card/cash) |
| `order_placed` | Checkout completes, order created | `order_value`, `item_count`, `store_id`, `delivery_type` (immediate/scheduled) — **not** item names/sizes |
| `order_cancelled` | Customer-initiated cancellation | `stage_at_cancellation` (matches `orders.status` at cancel time) |
| `order_completed` | Order reaches `completed` | `order_value`, `time_to_deliver_minutes` |

### flash-driver-app (driver)

| Event | When | Key properties |
|---|---|---|
| `driver_signed_up` | Registration submitted | `signup_method` |
| `driver_approved` | Status reaches `approved` | — |
| `driver_online_toggled` | Online/offline switch | `state` (online/offline) |
| `screen_viewed` | Dashboard, Earnings, Profile, Subscription — these 4 only | `screen_name` |
| `order_accepted` / `order_rejected` | Driver responds to a match | `order_id` |
| `pickup_confirmed` / `dropoff_confirmed` | Photo-verified pickup/dropoff | `order_id` |
| `order_completed_by_driver` | Driver-side completion | `order_id`, `earnings` |

## 3. What's deliberately NOT tracked

- **No PostHog autocapture and no session replay.** Autocapture (PostHog's
  "track every click/tap automatically") would blow past the explicit,
  reviewable event list above and make it much harder to state precisely
  what's collected for the App Privacy/Data Safety forms (§5 below).
  Session replay has its own separate free allowance (5,000 recordings/
  month) but records real screen content — a real PII/consent question
  Flash hasn't needed to answer yet, so it's out of scope for this design,
  not silently included.
- **No raw item names, sizes, addresses, or phone numbers** in any event
  property — order value and counts are enough for funnel/product
  analysis; anything more detailed is already in Postgres and reachable
  via `distinct_id` if a specific case needs it.
- **No client IP capture beyond PostHog's own default geolocation use.**
  Worth an explicit decision at implementation time (PostHog supports
  disabling IP collection per-event via `$ip: null`) — flagged here as a
  configuration choice to make deliberately, not decided in this design.

## 4. Free-tier fit, checked against real numbers

Confirmed directly against PostHog's own pricing page (fetched this
session, not assumed): the free tier includes **1,000,000 events/month**,
**1,000,000 feature-flag requests/month**, and **5,000 session
recordings/month**, each resetting monthly, with **1-year data
retention**. Crucially: **PostHog does not auto-charge past the free
tier** — going over silently stops data ingestion, *unless* a payment
method is added and a billing limit is explicitly set, in which case it
bills for the configured limit. **Recommendation for account setup:** if
a card is ever added to the PostHog account for any reason, set an
explicit billing limit at or just below the free 1M-event allotment
immediately — this makes going over a data-loss event (acceptable at
this scale) rather than a surprise charge.

**Volume estimate, current and near-term:** per `SECTION_2.11_TRAFFIC_
SCALING_AUDIT.md`, Flash is at roughly 7 drivers/19 orders today, with an
explicitly analyzed near-term scaling target of ~50 drivers and a few
hundred orders/day. At that near-term ceiling (300 orders/day), the
taxonomy above produces roughly 10–15 events per order lifecycle
(screen views through checkout, payment method, placed, completed) plus
driver online/offline toggles and dashboard screen views — a generous
estimate lands around 5,000–10,000 events/day, i.e. **150,000–300,000
events/month**. That's comfortably under the 1M free-tier ceiling, with
roughly 3–6x headroom before this needs to become a cost decision at all
— and even then, PostHog's own behavior (stop ingesting, don't
auto-charge) means crossing it is never a surprise bill, only a
"upgrade or lose data past this point" decision made deliberately later.

## 5. Impact on the App Privacy / Data Safety forms — must be updated before submission

The App Privacy/Data Safety answers already drafted (companion to
`APPLE_APP_STORE_COMPLIANCE_AUDIT.md`, handed off separately as
`app-privacy-data-safety-draft.md`) were written **before** any analytics
SDK existed in either app — they do not currently account for PostHog at
all. **Once this is actually implemented**, both that draft and the
privacy-policy "third-party services" text drafted for
`docs/audits/OAUTH_AGE_GATE_AND_APP_STORE_DATA_FORMS.md`'s companion work
need a real update, not just a mental note:

- A new "**App activity / analytics**" row needs adding to both the Apple
  App Privacy and Google Play Data Safety answers — collected, tied to
  the account's `distinct_id` (which the forms' own language would
  classify as "linked to identity," same as the other identity-linked
  rows already drafted), purpose "App Functionality" / "Analytics," not
  used for advertising or cross-app tracking (matching every other row
  already drafted).
- **PostHog** needs adding by name to the privacy policy's "third-party
  services we use" section, alongside Paystack/Google Maps/Cloudinary/
  Sentry/Resend, with the same one-sentence-per-service treatment already
  drafted for those five.

**Both updates are now made** — see §7 below.

## 6. Next steps, once unblocked

1. Vuyo creates the PostHog account and provides a real project API key
   (and sets the billing-limit safeguard from §4 if a card is ever added).
   **Still the one thing blocking real events — everything else is done.**
2. ~~Implement: `posthog-react-native` in both apps, a thin wrapper service
   matching the existing `services/api.js` pattern, wired to the event
   taxonomy in §2 exactly — no autocapture, no session replay, per §3.~~ Done.
3. ~~Update the App Privacy/Data Safety draft and the privacy-policy
   third-party-services text per §5, before either is actually submitted.~~ Done.
4. ~~Test and document, same as every other section.~~ Done — §7.

## 7. Implementation

Steps 2–4 above are complete. What actually got built, and its limits:

### What was built

`posthog-react-native` (plus its Expo peer deps — `expo-file-system`,
`expo-application`, `expo-device`, `expo-localization`) installed in both
apps. A thin `services/analytics.js` in each, mirroring `services/api.js`'s
existing shape exactly: a plain module exporting named functions, one per
event in §2's table — no generic `track(eventName, props)` escape hatch,
so the full set of events Flash ever sends is visible by reading that one
file per app. The PostHog client is created via direct instantiation
(`new PostHog(...)`), never `<PostHogProvider>` — confirmed directly
against the installed package's own type definitions
(`posthog-rn.d.ts`, `PostHogProvider.d.ts`) that autocapture (screen/touch
capture) is wired entirely through the Provider's React-tree integration;
a bare instantiated client has no autocapture mechanism to disable in the
first place, which is a stronger guarantee than "capture is off." App
lifecycle events (`captureAppLifecycleEvents`) and session replay
(`enableSessionReplay`) are both explicitly set `false` regardless.

Wired into the exact call sites the taxonomy implies: `_postLogin`/
`register`/`login`/`loginWithApple`/`loginWithGoogle` in both apps'
context providers (identify + signup events; user app also fires
`user_logged_in`, matching its own table — the driver table never defined
a login event, so the driver app intentionally sends nothing on login, not
an oversight); `useFocusEffect` on the 9 user-app screens and 4 driver-app
screens named in §2; `placeOrder`/`CancelOrderScreen.js`/`PaymentScreen.js`/
`TrackingScreen.js` for the user app's order events; `setOnline`/
`handleAcceptOrder`/`handleCapturePhoto`/`handleStatusUpdate` in the driver
app's dashboard for driver events. `driver_approved` and `order_completed`
(both apps) use a `useRef` guard rather than derived render state or a
`setState` updater's own callback, so each fires at most once per relevant
transition — not on every re-render or profile refresh, and never inside
an impure state-updater function (React may invoke those more than once).

### Two honest gaps between the approved taxonomy and real app behavior, found during implementation

- **`order_rejected` has no real call site.** The driver app has no
  decline/reject action anywhere — a driver either taps Accept or the
  match times out. The function exists in `analytics.js` (matches the
  taxonomy, ready for a future real decline button) but nothing calls it
  today. Flagging this rather than inventing a call site that doesn't
  correspond to real behavior.
- **`order_value`/`time_to_deliver_minutes` aren't always populated** on
  `order_completed` (user app) and `earnings` on `order_completed_by_driver`
  (driver app). The live call sites that detect these transitions (a
  socket event, and the driver's own status-update action) don't carry
  the full order record — fetching one purely to enrich an analytics
  event would be a new network call, out of scope for "nothing more than
  the taxonomy." Each event still fires with `order_id` and whatever's
  cheaply available (the one user-app call site that does have the full
  order already — the socket-fallback poll — does pass `order_value`
  through). Documented inline in both `analytics.js` files.

Also not in the original design-doc table but added on review: `driver_approved`
was already scoped in §2, but its call site (`_layout.js`'s router guard)
needed a session-scoped ref guard the design doc didn't spell out, since
`driver` is refreshed from a real profile fetch on every cold start — the
guard prevents refiring on every app open for an already-approved driver.

### Verification

- **Syntax**: every changed/new file in both apps parses cleanly. User
  app (no lint script — confirmed in `CLAUDE.md`) verified via the
  JSX-aware `@babel/parser` AST check already established as trustworthy
  earlier in this engagement (proven against a deliberately broken
  snippet before trusting a clean result). Driver app verified via the
  project's real `expo lint` — **zero new errors or warnings** introduced
  by any of these changes; the 5 problems the run reports are all
  pre-existing and unrelated (`chat.js`, `bank.js`, `notifications.js`,
  and two dependency-array warnings already present before this work,
  confirmed by reading each one directly rather than assuming).
- **Real event delivery**: at the time this section was first written,
  both apps' `EXPO_PUBLIC_POSTHOG_API_KEY` were unset by design and every
  function call was a safe no-op. **That gap is now closed — see §8.**
- **Privacy/compliance updates**: `app-privacy-data-safety-draft.md` and
  `privacy-policy-additions.md` (both in the scratchpad handoff location,
  not committed — neither is code) updated to add PostHog by name,
  matching §5's plan. Found one additional real gap while updating the
  Data Safety draft, not previously flagged anywhere: account deletion
  today purges Flash's own database but does not separately delete a
  user's/driver's past events from PostHog's own copy — added as an
  explicit open question in that draft for whoever submits the form to
  resolve, rather than silently leaving it unaddressed.

### Outcome

The design is fully implemented and wired, with zero regressions to
either app's existing lint/syntax cleanliness. At the time of writing,
the one thing standing between this and real data flowing was §6 item 1
— resolved the same day; see §8.

## 8. Real key added, real delivery confirmed (2026-09-10, same day)

Vuyo created the PostHog project and provided a real project API key.

### What was configured

`EXPO_PUBLIC_POSTHOG_API_KEY` and `EXPO_PUBLIC_POSTHOG_HOST` added as real
values to both apps' local `.env` (gitignored, confirmed via `git
check-ignore` — never committed; `.env.example` in both apps still shows
only a placeholder). Also added as EAS environment variables for both the
`production` and `preview` build profiles, on both projects — **plaintext
visibility, not secret**: EAS itself rejects `secret` visibility for an
`EXPO_PUBLIC_`-prefixed variable (confirmed live — the CLI's own error
explains why: these variables compile directly into the client bundle
regardless of EAS visibility setting, so "secret" would misrepresent how
protected the value actually is; PostHog's project token is a write-only
key meant to be public-safe anyway, the same posture already documented
for `EXPO_PUBLIC_SENTRY_DSN`). Confirmed present, correct, and consistent
across both environments and both projects via a direct `eas env:list`
read-back afterward — not just trusting the "Created" confirmation message.

### Real end-to-end delivery — what was actually verified, and the boundary of what wasn't

`posthog-react-native` is a React-Native-only package — confirmed
directly (attempting `require()` on it in plain Node fails immediately on
syntax the package expects a bundler to transform first), and this
project's Expo SDK 54 setup has no standalone `babel-preset-expo`/
`metro-react-native-babel-preset` package to compile it through outside
Metro either (checked; not present in `node_modules`). There is also no
browser- or device-interaction tool available in this environment to
literally launch a simulator/Expo-web session and tap through a real
screen. Given those two real constraints, full literal "ran the app and
watched it happen" verification wasn't possible — stated plainly rather
than glossed over.

What was actually done instead: sent two real HTTP requests directly to
PostHog's own documented public single-event Capture API
(`POST https://us.i.posthog.com/i/v0/e/` — the same stable endpoint
family `posthog-react-native`'s own core (`@posthog/core`) sends to
internally, confirmed by reading its actual compiled source, not
assumed), using the real project key and matching the exact event
name/property shape the real app code sends for two taxonomy events:
`screen_viewed` (`screen_name: "Home"`) and `user_logged_in`
(`login_method: "password"`). Both requests returned `HTTP 200
{"status":"Ok"}` — PostHog's own ingestion server accepted both events
under the real key. Both were sent with `distinct_id:
"verification-claude-2026-09-10"` and an explicit `verification: true`
property plus a plain-language note, specifically so they're identifiable
and easy to filter out or delete from real analytics data, not mistaken
for genuine user behavior.

**What this proves**: the real key and host are valid and live; PostHog's
ingestion pipeline accepts them; the exact event shape this app's code
sends will succeed. **What this does not prove**: that a real device
running the actual compiled app produces byte-identical requests (the
SDK adds its own metadata — `$lib`, `$lib_version`, and similar — that
this test didn't attempt to replicate exactly), or that the events are
now visibly queryable in the PostHog dashboard's UI — confirming that
last step needs either Vuyo's own dashboard login or a separate
*read-scoped* personal API key (different in kind from the write-only
project token already added — not requested here, since it wasn't
needed for the app itself to work and asking for one would have been
outside this task's explicit scope).

**Recommended next step for Vuyo, optional**: open the PostHog project's
Activity/Events view and filter for `distinct_id =
verification-claude-2026-09-10` to see both events land — the final,
visual confirmation this session's own tools couldn't perform. Both are
clearly labeled test/verification events and safe to delete.

### Outcome

`services/analytics.js`'s code-level comments in both apps now reflect
reality (no longer say "no real value yet"). Real events are confirmed
accepted by PostHog under the real project key, end to end, at the
network/ingestion level — the one gap the previous version of this
section left open is closed, within the honest limits described above.
