# Section 2.14 close-out: OAuth age-gate fix + App Store data-form draft

**Date:** 2026-09-10. **Scope:** the two action items from Section 2.14's
findings — (1) close the real bug found there (Google/Apple Sign In bypass
the 18+ age gate password registration already enforces), and (2) draft the
App Store "App Privacy" / Google Play "Data Safety" console answers, the
one Section 2.14 gap that's a real submission blocker. Audited, designed,
implemented, tested (unit + a live end-to-end run against the Docker
sandbox's real Postgres), and documented, matching this whole engagement's
standard process.

---

## Netlify-link cleanup (checked, nothing to do)

Before this section's own two action items: the founder separately asked
to sweep both apps for hardcoded `flash-website.netlify.app` legal/support
links. Searched both apps' full source (and `.env`/config files) for
"netlify" — zero matches in code. Git history confirmed why: this exact
swap (to `flashdelivery.co.za`, split correctly by page, plus the personal-
Gmail-to-`support@flashdelivery.co.za` fix) already landed in commit
`565ccdf` and its merge-conflict carry-forward `102d295`, both already
ancestors of this branch's HEAD. Re-verified every Privacy/Terms/Help link
in both apps points at the correct page. No code changed for this part.

## 1. OAuth age-gate bypass — fixed

### The bug

`dateOfBirthValidator` (`authRoutes.js`) rejects registration outright for
anyone under 18, but it's only wired into `/user/register` and
`/driver/register`. Google and Apple Sign In (`googleSignInUser`,
`googleSignInDriver`, `appleSignInUser`, `appleSignInDriver` in
`authController.js`) create a new row with no `date_of_birth` at all,
skipping the check entirely. Both live legal pages already claim an 18+
minimum, and the app processes real payments — an unenforced age gate on
2 of 4 signup paths, on both apps, was a genuine compliance and liability
gap, not cosmetic.

### The fix

Mirrors a pattern this exact codebase already established for an
analogous problem — `terms_accepted`: a real backend field + endpoint,
gated client-side by the app's own navigator so an affected account can't
reach the rest of the app until it's resolved, re-checked against live
profile data on every app open (not just at the moment of signup, so it
also retroactively catches any account that slipped through before this
fix, not only future ones).

**Backend** (`authRoutes.js`, `authController.js`, `User.js`, `Driver.js`):
two new authenticated routes, `POST /auth/user/date-of-birth` and
`POST /auth/driver/date-of-birth`, reusing the exact same
`dateOfBirthValidator` instance the two register routes already use — not
a re-implementation, so a date submitted here is held to the identical
18+ standard. `User.setDateOfBirth`/`Driver.setDateOfBirth` write with
`WHERE id = $2 AND date_of_birth IS NULL`, making this genuinely one-time:
a double-submit (e.g. a duplicate tap) is idempotent rather than silently
letting a second, unvalidated date overwrite the first.

**Both apps**: a new gate screen (`DateOfBirthGateScreen.js` in the user
app, `app/auth/date-of-birth.js` in the driver app) — same day/month/
year input and client-side pre-check already used on the password
registration screens, mirrored rather than reinvented. Rendered instead of
the authenticated app whenever `user.date_of_birth`/`driver.date_of_birth`
is falsy: `App.js`'s navigator gains a `needsDateOfBirth` check ahead of
its existing `needsTerms` check (a password-registered account always has
a real DOB from registration, so this only ever fires for a social-sign-in
account); the driver app's router-based auth guard (`_layout.js`) gains
the equivalent `needsDob` branch, checked ahead of the terms redirect.
Both apps already re-fetch the live profile on every cold start with a
stored session (`FlashContext.js`'s "refresh profile on token change"
effect; `DriverContext.js`'s hydrate function's `driverApi.driver.
getProfile()` call) — so an account that reached this bypass before the
fix gets caught the next time that person opens the app, not only on their
next fresh OAuth sign-in.

### Files changed

- `backend/src/routes/authRoutes.js` — two new routes, reusing the
  existing `dateOfBirthValidator`.
- `backend/src/controllers/authController.js` — `setDateOfBirthUser`,
  `setDateOfBirthDriver`.
- `backend/src/models/User.js`, `backend/src/models/Driver.js` —
  `setDateOfBirth`, with the one-time `WHERE ... IS NULL` guard.
- `backend/tests/unit/auth.test.js` — 6 new tests: invalid date, under-18
  rejection (both roles), the one-time guard's exact SQL shape, and the
  idempotent-double-submit path.
- `flash-user-app/screens/DateOfBirthGateScreen.js` (new),
  `flash-user-app/App.js`, `flash-user-app/context/FlashContext.js`,
  `flash-user-app/services/api.js`.
- `flash-driver-app/app/auth/date-of-birth.js` (new),
  `flash-driver-app/app/_layout.js`,
  `flash-driver-app/context/DriverContext.js`,
  `flash-driver-app/services/api.js`.

### Verification

- **Unit**: 6 new tests, all passing — invalid-date rejection, under-18
  rejection (user and driver), the one-time guard's real SQL asserted
  directly (`WHERE id = $2 AND date_of_birth IS NULL`), the idempotent
  double-submit path, and that `password_hash` never leaks into the
  response.
- **Full backend suite, live against the Docker sandbox's real Postgres**
  (not the mocked-pool unit run): 288/289 passing. The one failure
  (`productionStateMachine.test.js`'s cancellation-split assertion) is
  confirmed pre-existing and unrelated — reproduced identically after
  `git stash`-ing every file this section touched and rerunning against
  the untouched baseline, then restored. Worth a founder-visible flag on
  its own (a real assertion mismatch on the 10/5/85 refund split, not
  something introduced here) but out of scope for this section to fix.
- **Live, end-to-end, against the running Docker backend**: registered a
  real test user via the live `/auth/user/register` endpoint, nulled its
  `date_of_birth` directly in Postgres to simulate an OAuth-created
  account, then confirmed live: (1) both new routes return 401 "No token
  provided" unauthenticated — proving they're really wired into the
  running server, not just present in source; (2) an under-18 submission
  is rejected with the same validator message registration uses; (3) a
  valid submission returns 200 and the DOB is genuinely persisted,
  confirmed by a direct `SELECT` against Postgres. Test data cleaned up
  afterward.
- **Both apps' frontend changes**: driver app verified via the project's
  real `expo lint` — zero problems on every file this section touched (an
  unescaped-apostrophe error the first run caught in the new
  `date-of-birth.js` screen was fixed and reconfirmed clean; the one
  remaining warning on `_layout.js`'s new effect dependency matches the
  same pre-existing style already accepted for `driver?.status`/
  `driver?.terms_accepted` in that same array). The user app has no lint
  script (confirmed in `CLAUDE.md`) — verified instead with a real,
  JSX-aware AST parse (`@babel/parser`) on every changed file, proven
  trustworthy first by confirming it correctly fails on a deliberately
  broken snippet before trusting a clean result on the real files. No
  Expo/simulator build was run for either app — stated plainly, not
  implied otherwise.

## 2. App Store "App Privacy" / Google Play "Data Safety" — drafted, handed off

These are console forms in App Store Connect / Google Play Console, not
files in this repo, so they can't be submitted directly from here. Drafted
the actual answers, grounded in what the code really collects (confirmed
by source, not assumed): location (foreground both apps, background driver
app only), name/email/phone, photos, Sentry crash diagnostics, in-app
chat, and a note that neither app collects payment card data directly
(both redirect to Paystack's own hosted checkout page) — with suggested
purpose classifications for each platform's form and an explicit list of
what wasn't checked (per-SDK telemetry inside Google Maps/Cloudinary
themselves) so whoever submits this knows what still needs a second look.
Handed off as `app-privacy-data-safety-draft.md` (not committed — it's a
console-form answer key, not code), the same handoff pattern already used
for the privacy-policy-text additions in the prior Apple compliance pass.

## Outcome

The real bug Section 2.14 found — OAuth sign-in bypassing the 18+ age
gate on both apps — is fixed, tested at both the unit and live-Docker-
integration level, and designed to retroactively catch any account that
already slipped through, not just prevent new ones. The App Privacy/Data
Safety gap is drafted and hasn't been left as just a checklist item. POPIA
(Information Officer registration, retention policy, legal-basis
documentation) and the Apple EULA remain founder/legal action items
outside code, as scoped. **Section 2.14 is fully closed.**
