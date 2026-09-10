# Post-Audit Priority Roadmap

**STATUS: PAUSED — Vuyo does not have funding yet to act on this. Do not
start any of it until he explicitly says to.**

This is the priority order for raising Flash's 66/100 production-readiness
score (`SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md`), sequenced by severity
and dependency, not by ease. Nothing here is new work — every item is
already described in full, with file paths and reasoning, in
`SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §2–§5 and `OPEN_FOLLOWUPS.md`.
This document only orders it into a sequence to execute once funding and
founder time are actually available.

---

## 1. Founder-only actions, highest severity — do these first, before anything else

- **Get a real Paystack live key onto Render**, confirmed via the Render
  dashboard directly (not app logs — a missing key and a leftover
  `sk_test_...` key log identically), then revert `PaymentScreen.js`'s
  cash-only filter so card payments actually work again. This is the
  single most severe open item — Flash cannot take a card payment in
  production today.
- **Unlock GitHub billing** so Actions CI runs again. Every commit since
  2026-06-11, including the entire Sections 2.1–2.15 audit, has landed
  with zero automated regression coverage. This is the "biggest process
  risk" call from both the July and this audit's own scoring.

Both are founder-only (billing/dashboard access), not code — and both
were already called out as the two highest-value, single-item score
levers in `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §6.

## 2. Small, well-scoped security fixes — do these next

- **Add the missing `emailVerified` check to all four OAuth sign-in
  handlers** (`googleSignInUser`, `appleSignInUser`, `googleSignInDriver`,
  `appleSignInDriver` in `backend/src/controllers/authController.js`) —
  confirmed still open on both apps in §5 of the final report. Closes a
  real account-takeover vector under specific conditions.
- **Add a basic GPS speed-plausibility check** on driver location
  updates — flag, don't block, matching `OPEN_FOLLOWUPS.md`'s own
  recommended first step, short of full device attestation.

## 3. Two-minute-to-moderate operational fixes

- Render dashboard: wire the real `/health` endpoint into
  `healthCheckPath`; set the build command to run migrations
  automatically (`npm install && npm run migrate`) — both already
  specified exactly in `DEPLOYMENT_SAFETY_RECOMMENDATIONS.md`, neither
  applied yet.
- **Finish the Google Maps iOS key rotation** — complete the pending iOS
  builds for both apps (blocked on a one-time interactive Apple
  Distribution Certificate step only the founder can run), confirm the
  new Android builds work on a real device, then delete the two old,
  previously-leaked Maps keys still active in Google Cloud Console.
- **Fix Sentry symbolication on both apps** — provision a real
  `SENTRY_AUTH_TOKEN` and remove `flash-user-app`'s
  `SENTRY_DISABLE_AUTO_UPLOAD` flag; register `@sentry/react-native` as
  an Expo plugin in `flash-driver-app/app.config.js` (currently missing
  entirely, unlike the user app).

## 4. Founder/legal — real regulatory and platform exposure, not code

- Register a POPIA Information Officer with South Africa's Information
  Regulator.
- Write a real data-retention policy and document Flash's legal basis
  for processing.
- Submit the App Store "App Privacy" and Google Play "Data Safety"
  forms — the actual answers are already drafted (handed off separately
  from `APPLE_APP_STORE_COMPLIANCE_AUDIT.md`'s companion work), just
  need submitting through App Store Connect / Play Console.
- Attach Flash's own Terms as the custom Apple EULA in App Store Connect
  (App Information → License Agreement), replacing Apple's generic
  default.

**Dependency worth flagging, not resolving now:** at least the POPIA
Information Officer registration, and possibly other items in this
group, may require Flash to be a registered legal entity first — which
it currently isn't; Vuyo is deliberately delaying incorporation until
funding is in place. Worth explicitly checking each of these four
items' actual legal prerequisites when this section is picked back up,
rather than assuming they're all executable pre-incorporation.

## 5. Remaining Medium findings and one policy decision

- Store credit has no redemption path — an orphaned financial feature
  that looks live to a user but leads nowhere.
- No chargeback/dispute webhook handling (`webhookController.js`).
- No account-level brute-force lockout, only IP-based rate limiting.
- No phone-number uniqueness constraint (`users.phone`/`drivers.phone`)
  — part of account-farming defense.
- **Policy decision, not a pure bug fix:** whether/how an admin can
  override an order permanently stuck at `picked_up`/`in_transit`/
  `delivered` — real questions about force-completing without OTP,
  driver payout handling, and whether a force-cancel writes off goods as
  a loss need a founder answer before this is built, per
  `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §3.

---

Cross-referenced from `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` §6
("what would make this genuinely higher") and `OPEN_FOLLOWUPS.md`.
