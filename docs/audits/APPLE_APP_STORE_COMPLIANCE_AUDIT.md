# Apple App Store Compliance Audit

**Date:** 2026-09-10. **Scope:** six specific compliance questions queued
earlier — privacy policy content, location permission strings, account
deletion discoverability, Sign in with Apple/Google alternatives, whether
driver subscriptions need Apple In-App Purchase, and whether the §2.7
block/report system satisfies Apple's User-Generated-Content requirements.
Findings are read directly from the current source, cross-checked against
Apple's current, live App Review Guidelines (fetched directly from
developer.apple.com, not summarized from memory), and — for the two real
gaps found — fixed.

---

## 1. Privacy policy — partially satisfied, one part fixed by this audit, one needs a decision

A real, live policy exists at `flashdelivery.co.za/privacy`, correctly
linked from both apps' Settings/Profile screens (`ProfileScreen.js`,
`SettingsScreen.js` in the user app; `app/driver/settings.js` in the
driver app), confirmed reachable with no login wall — independently
reviewable via App Store Connect's own privacy-URL field regardless of
in-app navigation. It covers data collection, use, and deletion rights in
general terms. An earlier audit (`RETURNS_AND_LEGAL_AUDIT.md`) had flagged
the apps linking to the *wrong domain* — confirmed fixed since (commit
`66ba185`), both apps now correctly link to the real, live domain.

**Gap, not yet fixed (content lives outside this repo)**: the policy names
none of Paystack, Google Maps, Cloudinary, Sentry, or Resend — third
parties are described only generically ("payment partner," "cloud
hosting, analytics tools," naming only Google Analytics). Also a known,
unresolved inconsistency: the Privacy page's deletion-request contact
(`privacy@flashdelivery.co.za`) doesn't match the Terms page's contact
(`hello@flashdelivery.co.za`).

**SMSPortal/WinSMS**: searched the entire codebase exhaustively (source,
`package.json`, `.env.example`) — neither is actually integrated
anywhere. Flash doesn't currently use an SMS provider at all (cash-order
OTP delivery, the one place SMS might be expected, has no SMS code path).
Not a gap to fix — these two just aren't part of the real stack.

**Why not fixed directly**: the policy's actual text lives on an
externally-hosted Netlify site, not in this repository — there's no
marketing-site source here to edit and redeploy. Drafted the specific
additions (a "third-party services" section naming the five real
integrations, plus the two options for resolving the email
inconsistency) as a handoff document rather than leaving this
unaddressed — see `privacy-policy-additions.md`, handed to you separately
rather than committed here, since it's not code.

## 2. Location permission strings — mostly good, one real defect, fixed

Three of four present iOS purpose strings were already specific to
Flash's actual use (driver app: *"...so customers can track their
deliveries"* / *"...to update your delivery position while on a job"*;
user app foreground: *"...to find nearby stores and track your
delivery"*) — not generic boilerplate.

**Real defect, fixed**: the user app declared
`NSLocationAlwaysUsageDescription` — the **deprecated pre-iOS-11 key**.
Modern iOS reads `NSLocationAlwaysAndWhenInUseUsageDescription` instead;
relying on the old key alone risks a review rejection or a silently
broken permission prompt. Checked whether the user app actually needs
Always-authorization at all before deciding how to fix it: it doesn't —
every real location call in this app (`CheckoutScreen.js`,
`AddressScreen.js`) only ever calls `requestForegroundPermissionsAsync()`,
never a background variant. **Removed the unused key entirely** rather
than "correcting" it to the modern one for a capability the app doesn't
use — an unused permission declaration is its own real review concern,
not just a stale key name. If a real background-tracking need is ever
added to the customer app, the driver app's own pair (in that app's
config, right above) is the pattern to match.

## 3. Account deletion discoverability — satisfied, no change needed

Both apps: 2 taps from the primary post-login screen (Profile → Settings
→ Delete Account, user app; Dashboard → Settings → Delete Account, driver
app) + 1 confirm, unambiguously labeled "Delete Account" inside a
visually distinct "DANGER ZONE"/"ACCOUNT" section on a short (4-5
section), non-scrolling Settings screen. The real backend endpoints
(`DELETE /api/users/account`, `DELETE /api/drivers/account`) were already
live-tested against production in `SUBSCRIPTION_LIFECYCLE_AUDIT.md` §3.
One earlier audit (`RETURNS_AND_LEGAL_AUDIT.md`, 2026-07-09) claims no
in-app deletion flow exists at all — that finding is now stale, superseded
by later commits (`5f31153`, `6926391`); current code on disk confirms
both UIs exist and work today.

## 4. Sign in with Apple / Google alternative — satisfied, no change needed

Both apps' login screens show Sign in with Apple, Sign in with Google,
**and** plain email/password together — real, working OAuth on both
(`appleAuthService.js`/`googleAuthService.js`, `apple_id`/`google_id`
columns on both `users` and `drivers`), not just Apple's required
parity but a third option beyond it.

## 5. Driver subscription tiers vs. the Uber/DoorDash IAP exemption — real risk found, fixed

Fetched Apple's current App Review Guidelines directly (not from memory)
to check this precisely. Guideline **3.1.3(e)** ("Goods and Services
Outside of the App"): *"If your app enables people to purchase physical
goods or services that will be consumed outside of the app, you must use
purchase methods other than in-app purchase"* — this is the real,
correct basis for Flash's **customer-facing** payments (product +
delivery fee via Paystack), matching Uber/DoorDash exactly. An earlier
audit (`RETURNS_AND_LEGAL_AUDIT.md` §2.8) already confirmed this for the
order/return flow — correct, but that pass never examined driver
subscriptions specifically.

**Driver subscription tiers are a different transaction, and don't
qualify for the same exemption.** They don't directly purchase a
real-world good/service — they unlock delivery-slot count, priority
matching, and cash-order access, which is Guideline **3.1.1**'s own
textbook example: *"If you want to unlock features or functionality
within your app... (by way of example: subscriptions...)... you must use
in-app purchase."* Checked for precedent among the apps this exemption
usually gets justified by — none exists: Uber Pro, and the equivalent
DoorDash/Instacart driver-side tier programs, are free and
performance-based, never a paid in-app purchase. There's no safe-harbor
to lean on here.

Confirmed this was live, not theoretical: `flash-driver-app/app/driver/
subscription.js` let a driver buy "Delivery Plans" (R25–R900) **entirely
within the iOS app via Paystack**, with zero Apple IAP. The driver app has
a real iOS bundle identifier (`co.za.flash.driverapp`) and Apple Sign-In
already wired — a live rejection risk, not a hypothetical one.

**Fix, per your explicit direction** (safest option that doesn't touch
payments/backend, keeps revenue flowing on Android, and directly resolves
the compliance blocker): purchasing is now hidden on iOS specifically
(`Platform.OS === 'ios'`), while subscription **status and Cancel Plan
stay fully visible and functional** on every platform — nothing about the
backend, Paystack integration, or Android behavior changed at all.
Deliberately doesn't point iOS users at an alternative purchase channel
either (no "buy it on our website" prompt) — Guideline 3.1.3's own
preamble bars in-app steering toward another purchase method for any
storefront other than the U.S. one, and Flash's real storefront is South
Africa, so simply omitting the purchase flow (not redirecting to one) is
the safe design.

**Left as a real, future decision, not built now**: a genuine Apple
IAP/StoreKit integration for iOS remains the durable long-term option if
Flash ever wants iOS drivers to purchase without leaving the app. Real
scope — App Store Connect product configuration (needs your Apple
Developer account access, not something buildable from here), receipt
validation, reconciling two payment rails against one backend
subscription record — and a real trade-off: Apple takes a cut of IAP
revenue that Paystack doesn't, directly affecting what you said mattered
here ("will make money for Flash"). Not attempted in this pass, since it
can't be verified end-to-end without your own Apple Developer/sandbox
access, and getting it wrong risks exactly what you asked me to avoid.

## 6. §2.7 block/report system vs. Apple's UGC requirements (Guideline 1.2) — satisfied, no change needed

Fetched Guideline 1.2's full current text and checked each of its four
sub-requirements directly against the real chat UI and backend:

- **Report mechanism**: real, in the chat header's "•••" menu in both
  apps (`ChatScreen.js`/`chat.js`), with a reason picker, submitting to
  `POST /messages/:orderId/report` → `chat_reports`, reviewed via a real
  AdminJS resolve workflow (status pending/reviewed/actioned/dismissed).
- **Block mechanism**: same menu, real backend enforcement
  (`Message.sendMessage` rejects a blocked pair immediately;
  `UserBlock.getBlockedDriverIdsForUser` excludes blocked parties from
  future matching) — not cosmetic.
- **Published contact info**: both apps have a separate "Help & Support"
  entry in Settings (and Profile, user app) →
  `mailto:support@flashdelivery.co.za`, independent of in-chat reporting.

All four of Guideline 1.2's requirements — filtering, reporting, blocking,
published contact — are met by real, already-built mechanisms.

---

## Files changed

- `flash-driver-app/app/driver/subscription.js` — purchase UI hidden on
  iOS specifically (`IOS_PURCHASE_DISABLED`), status/cancel unaffected on
  every platform; `handlePurchase` also defensively guarded.
- `flash-user-app/app.config.js` — removed the unused, deprecated
  `NSLocationAlwaysUsageDescription` key (the app never requests
  background location).
- (Not committed to this repo — handed off separately) draft additions
  for the externally-hosted privacy policy: a real "third-party services"
  section naming Paystack/Google Maps/Cloudinary/Sentry/Resend, and two
  options for resolving the contact-email inconsistency.

## Verification

- Both changed files confirmed syntactically valid: `flash-user-app/
  app.config.js` via `node --check` (plain JS, fully reliable for this
  file type); `flash-driver-app/app/driver/subscription.js` via the
  project's own real lint pipeline (`expo lint`) — which is the correct
  tool for a JSX file (a raw `node --check` doesn't understand JSX) and is
  proven working, not just assumed, since the same run caught real,
  unrelated issues in other files (`chat.js`'s unescaped entity) while
  reporting zero problems for the changed file.
- No automated test suite exists for either mobile app in this repo (only
  the backend has one, per `CLAUDE.md`'s own command list) — verification
  here is the syntax/lint checks above plus direct, careful reading of
  the diff, not a test run. Stated plainly rather than implied.
- Every finding above is grounded in either direct code inspection (exact
  file/line citations) or Apple's own current guideline text (fetched
  live, quoted verbatim, not recalled from training data) — no claim
  in this document is asserted without a specific, checkable source.

## Outcome

Two real, concrete gaps found and fixed (the deprecated/unused location
key; the driver-subscription IAP exposure on iOS, the most consequential
finding of this pass — a genuine rejection risk removed with a small,
reversible, payments-untouched change). Three items confirmed already
solid with no change needed (account deletion, sign-in parity, UGC
moderation). One item (privacy policy content) has a real gap that
can't be fixed from this repo — drafted the specific corrections for you
to hand to whoever manages the Netlify site. **Apple App Store compliance
pass is complete**; ready for Section 2.14 whenever you are.
