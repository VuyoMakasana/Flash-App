# Testing Flash on your own phone (Android or iOS)

This is the guide for a collaborator setting up this repo for the first time and
running the two mobile apps (`flash-user-app`, `flash-driver-app`) on a real
device. Follow it top to bottom. If something here doesn't match what you see,
stop and ask rather than guessing — see "If something goes wrong" at the bottom.

## The short version

- The backend is already deployed and live at `https://flash-app-hplc.onrender.com`
  — you do **not** need to run it locally just to test the mobile apps.
- **Android — real app, no Expo Go needed**: download and install a real APK
  directly (links below). Nothing else to start, no dev server, no tunnel.
  This is the recommended path for Android.
- **iOS, or Android via Expo Go instead**: open a link in the real Expo Go app
  (from the App Store / Play Store). Also durable — no dev server needed,
  works on any network. The one real limitation: Expo Go's own public release
  is stuck on an older SDK than this app's real one, so this path runs off a
  dedicated, intentionally-older branch (`expo-go-testing`) rather than `main`
  — explained below.
- Both paths were live-tested this session: real signup/registration was
  confirmed working end-to-end against the live backend (see the SMTP note
  under "If something goes wrong" — a real incident was found and fixed
  tonight), and both download links below were confirmed to actually serve a
  real file, not just "should work."

## 1. One-time setup

You need [Node.js](https://nodejs.org) (LTS) and `git` installed.

```bash
git clone <repo-url>
cd "Flash App"

cd flash-user-app && npm install && cd ..
cd flash-driver-app && npm install && cd ..
```

Then, in **both** `flash-user-app/` and `flash-driver-app/`, copy the env
template and fill it in:

```bash
cp .env.example .env
```

Ask the project owner for the real values (Sentry DSN, Google Sign-In client
IDs). Leave `EXPO_PUBLIC_API_BASE_URL` as-is — it already points at the live
backend. **Never commit your `.env` file** — it's gitignored on purpose.

You only need this step if you plan to run a local dev server yourself. If
you're just installing the APK or opening the Expo Go link below, you can
skip straight to section 2 or 3 — no local setup required at all.

## 2. Android — real installable app (recommended, no Expo Go needed)

This is a real, standalone build — not a dev-client shell, not dependent on
anything running on anyone's computer. Install once, open it like any other
app, forever.

1. Download the APK on your Android phone:
   - **Flash Driver** (built 2026-07-20 from `multi-tester-readiness`,
     commit `39a0745` — includes tonight's ErrorBoundary and tap-to-call
     work; verified by unzipping the actual APK and confirming both
     features' real code is compiled into the bundle, not just a
     commit-hash label): https://expo.dev/artifacts/eas/TsAQcgZBS8G9yp3ljHJXD156LVutm-XsWMoGI651Ymg.apk
   - **Flash (user app)**: https://expo.dev/artifacts/eas/v70CtR77mk6Dt3f-tCHnwCvdFKT5mbYe1vyFZExNmfg.apk
     — **still a snapshot of `main` as of 2026-07-16, NOT
     `multi-tester-readiness`.** A rebuild was attempted 2026-07-20 and
     failed (Sentry source-map upload had no org configured — fixed in
     `eas.json`, committed), then the retry hit a hard wall: this EAS
     account's free-tier Android build quota is fully used for this
     billing period (15/15, confirmed via `eas account:usage` — resets
     2026-08-01). A new user-app APK cannot be built until either the
     quota resets or the EAS plan is upgraded — this is a real account
     limit, not something fixable in code. Android testers can use the
     Expo Go link in section 3 for the user app in the meantime.
2. Android will warn about "installing from unknown sources" the first time
   — this is normal for an app not yet published on the Play Store, not a
   sign anything is wrong. Tap through and allow it.
3. Open the app. That's it — it works exactly like the real app will once
   published, talking to the live backend already.

**These links don't expire and don't need anyone's computer running** — they're
served directly from Expo's own infrastructure. To rebuild either app later
(`npx eas-cli build --profile preview --platform android`, from
`flash-user-app/` or `flash-driver-app/`), check remaining quota first with
`npx eas-cli account:usage vuyomakasana`.

## 3. Expo Go — iOS, or Android without installing an APK

Expo Go's public App Store/Play Store release is currently stuck on an older
SDK version than this app's real one (SDK 56) — Expo's own team has given no
timeline for updating it (confirmed directly against Expo's changelog).
That's a real limitation of Expo Go itself, not a bug in this project, and
it's why this path runs off a dedicated branch, `expo-go-testing`, kept
intentionally on the older, Expo-Go-compatible SDK rather than `main`.

**You need an Expo account invited as a Viewer first — this is not
optional.** Confirmed live tonight: a tester signed into a *different*
Expo account (or no account) gets a real `403 "... is not viewable in
Expo Go: the signed-in Expo account does not have access to the account
that owns this project"` — the link being reachable by a plain HTTP
request (e.g. `curl`) does **not** mean Expo Go can actually open it; that
was learned the hard way. Ask the project owner to invite your Expo
account email as a **Viewer** under the `vuyomakasana` organization on
expo.dev (Organization settings → Members → Invite), then sign into
*that* account in the Expo Go app before opening any link below. **This
requirement doesn't exist for the Android APK in section 2** — that's a
real standalone install with no Expo account involved at all; it only
applies to this Expo Go path.

**Install Expo Go first** (free, from the App Store or Play Store). Then:

1. Open the Expo Go app and sign in with the Expo account the project
   owner invited (top-left profile icon → Sign In).
2. Look for "Enter URL manually" (usually under a "..." or "+" option on the
   home screen) — this is the reliable way in, guaranteed to work regardless
   of how your phone handles the link below.
3. Paste one of these links (these are the real manifest links Expo Go reads
   directly — confirmed publicly reachable at the network level; actually
   opening them in Expo Go additionally requires the Viewer access above):

   - **Flash (user app), Android**: `https://u.expo.dev/update/019f706c-a4d4-7a4d-b335-28fc517b92b5`
   - **Flash (user app), iOS**: `https://u.expo.dev/update/019f7077-4c4d-7468-8fcf-e27fb4ff21f4`
   - **Flash Driver, Android**: `https://u.expo.dev/update/019f7076-9f00-7bc0-88fb-b660eaf0ddae`
   - **Flash Driver, iOS**: `https://u.expo.dev/update/019f7077-0bb4-7dca-bc7d-4f94395a36d0`

   (Updated 2026-07-17 — synced `main`'s latest fixes into `expo-go-testing`
   and republished, including the driver app's new order-chat screen. All
   four links re-verified live: HTTP 200, no login wall. Previous links
   above are now stale — they served the pre-chat build. If a link above
   ever 404s or hangs, it means a newer publish superseded it; check with
   the project owner for the current one rather than assuming it's broken.)

You don't need Expo Go at any particular version — install whatever the App
Store/Play Store currently gives you. Its current public release is SDK 54,
which is exactly what these links were published for, so it matches
automatically with no extra steps.

Each of those pages has an "Open in Expo Go" button / QR code. **This does
not depend on anyone's computer, dev server, or tunnel being open** — the JS
bundle is published to Expo's own servers (this is what "EAS Update" means),
and Expo Go fetches it directly, on whatever network you're on.

**If you're a developer wanting to update this branch yourself** (not just
open the link):
```bash
git checkout expo-go-testing
git merge main   # bring in main's latest real fixes
cd flash-user-app  # or flash-driver-app
npx eas-cli update --branch expo-go-testing --message "your message" --platform android
npx eas-cli update --branch expo-go-testing --message "your message" --platform ios
```
(Two separate `--platform` calls, not `--platform all` — the user app's web
export fails on `react-native-maps`, which isn't web-compatible; this app was
never meant to run on web anyway.) `expo-go-testing` is a **persistent**
branch, not a throwaway — it's meant to be periodically re-synced with
`main` like this, not recreated from scratch each time.

### Also live: `multi-tester-readiness` branch (newer work, Expo Go only)

A second EAS Update branch, `multi-tester-readiness`, carries work newer than
`expo-go-testing` above — mandatory post-delivery ratings, real tap-to-call,
a saved-address coordinate fix, and an emoji cleanup pass. It's published
from the `multi-tester-readiness` git branch's current HEAD (also on SDK 54,
inherited from `expo-go-testing`, so it's Expo-Go-compatible the same way).

Same distribution model as the links above — Expo Go via "Enter URL
manually," nothing else to install or run:

- **Flash (user app), Android**: `https://u.expo.dev/update/019f819b-03e1-7fab-bdee-e67b1eef8542`
- **Flash (user app), iOS**: `https://u.expo.dev/update/019f819f-0248-7071-aff1-3d4fa9cf7a5f`
- **Flash Driver, Android**: `https://u.expo.dev/update/019f7b6e-c9d5-7718-84a4-78776e39f574`
- **Flash Driver, iOS**: `https://u.expo.dev/update/019f7b6e-c9d5-77cf-ae19-daa42eb02564`

(User-app links republished 2026-07-20, from commit `20864d1` — cash-only
checkout for this testing period, see below. Driver-app links republished
2026-07-19, from commit `2c9d268`. Same staleness caveat as above: if a
link 404s or hangs, a newer publish superseded it — check with the
project owner rather than assuming it's broken.)

**Test-mode signup, both apps, read before testing:**
- **User app**: every new signup uses their own real email/password and
  can place a real order immediately — checkout only shows "Pay on
  Delivery" right now (Card is hidden, not just de-prioritized, because
  real card payments are confirmed not configured in production tonight
  — see `docs/audits/PRODUCTION_SECRETS_CHECKLIST.md`). No real money is
  ever involved.
- **Driver app**: this only takes effect once the project owner sets
  `DRIVER_TEST_MODE=true` on Render and that's actually deployed — ask
  before assuming it's live. When it is: every new driver signup starts
  pre-approved with placeholder documents and a real 30-day subscription
  already active, so a tester can go online and receive orders
  immediately, no document upload or plan purchase needed. This only
  ever applies at the moment of signup — logging into an existing test
  account later just shows its real, persisted state, it never re-runs.
- **Push notifications do not work in Expo Go** (Android: not at all;
  iOS: degraded) — this is a real Expo Go platform limitation, not a
  Flash bug, and won't be "fixed" for Expo Go testing. In-app/socket-driven
  updates (chat, order status, live tracking) are not push-dependent and
  should work normally regardless of platform.

**Driver app, status as of 2026-07-20 — read before testing:** the
driver app was stuck on a blank/gray screen in Expo Go through
2026-07-19. Two real, separate things were found and fixed since:

1. A local dev-tooling bug (Metro's file watcher trying and failing to
   connect to Watchman, which isn't installed on the founder's machine)
   was crashing the *local dev tunnel* used to debug this — unrelated to
   what's actually published to testers, but it blocked getting any real
   diagnostic signal for a while. Fixed in `flash-driver-app/metro.config.js`.
2. With that fixed, live debugging via the tunnel showed the app
   actually reaching the dashboard and responding to a real "Go Online"
   tap — it hit an expected, non-fatal Expo-Go-only limitation
   (`NSLocation*UsageDescription` / background location isn't fully
   supported for Expo Go on a real iOS device), not a hang.

Net: real progress, not yet a from-scratch confirmed "fully working"
sign-off — if you hit a blank/gray screen again on either link above,
report it plainly rather than assuming it's the same already-explained
issue, since the underlying local-tooling problem is now fixed and a
fresh report would be new information.

**Important — these are Expo-Go-only, exactly like the `expo-go-testing`
links above, and are NOT wired to the section 2 APK builds in any way.**
Installing the section 2 APK and opening it will **not** pick up anything
published to this branch. Neither app's `eas.json` declares an EAS Update
`channel` on any build profile, so no installed standalone build currently
auto-tracks *any* update branch by channel — the only way to reach either
Expo Go branch today is the manual "Enter URL manually" flow described
above. Wiring real channel-based auto-updates (declaring a `channel` in
`eas.json`'s `preview` profile, then a fresh APK build to actually pick it
up) is real, separate work. **Flagged here as a known future item — not
built, not started.**

**The one thing with no free solution today**: a real, installable iOS
`.ipa` a tester could install without Expo Go at all (the iOS equivalent of
section 2's Android APK). That requires an Apple Developer Program account
($99/year) — unchanged, still the project owner's call, not something this
guide works around.

## 4. Rules — please read before touching anything

This keeps you safe from accidentally breaking something, and keeps the
project owner from having to clean up after a mistake. None of this is about
trust — it's just how this project is run.

- **Work on your own branch for any code changes.** Never commit or push
  directly to `main`.
  ```bash
  git checkout -b your-name/what-youre-doing
  ```
  Open a pull request when ready; don't merge your own PRs into `main`.
- **`expo-go-testing` is the one exception to "don't push to a shared
  branch"** — it's meant to be kept in sync with `main` over time (see
  section 3). Still don't force-push it, and don't merge it back into `main`
  (it's intentionally on an older SDK).
- **Never run database migrations or scripts against the production backend.**
  The live backend (`flash-app-hplc.onrender.com`) is real production data —
  real (test-mode) payments, real user accounts. If you need to test something
  destructive or run migrations, ask the project owner about spinning up a
  local backend + Postgres via Docker (`docker compose up -d --build` in
  `backend/`) instead of pointing at production.
- **Never run `eas build --profile production` or `eas submit`.** Those ship
  to real users / app stores. Stick to `preview` (section 2) or plain
  `eas update` (section 3).
- **Never commit `.env` files, API keys, or anything from `eas.json`'s
  `submit` section.** If you're not sure whether something is a secret, ask
  first rather than committing it.
- **Don't force-push, don't rewrite git history.**
- **If a background-location or push-notification test requires a real native
  permission prompt** (Android background location, notification permission),
  that's expected — approve it to test the real flow, same as a real user would.

## If something goes wrong

- **Registration or password reset seems to hang**: this was a real, live
  incident found and fixed on 2026-07-16 — both were hanging indefinitely due
  to a misconfigured/slow SMTP connection with no timeout. Fixed and verified
  live (registration now responds in ~6 seconds). If you see this again on
  current `main`, it's a new issue, not the same one — report it, don't
  assume it's already known.
- **Verification email never arrives, even though registration itself
  succeeds fast**: as of 2026-07-17, this is a known, live, **unresolved**
  gap — not fixed, don't assume otherwise. Registration returns
  `emailVerificationSent: true` regardless of whether an email actually
  sent, because `emailService.js` silently no-ops in a "DEV MODE" fallback
  whenever `SMTP_HOST`/`SMTP_USER` aren't set in production — no error, no
  warning, nothing visible outside Render's raw logs. Confirmed live by
  running real registrations against production and checking Resend's own
  send log directly: zero new sends appeared. If you hit this, it's the
  same known issue — report it to the project owner, they know it needs a
  Render-side fix (or a different SMTP relay's own delivery log, if it's
  no longer Resend).
- **"Cannot read property 'getGlobalHandler' of undefined" or similar crash on
  launch**: this was a real bug, already fixed on `main` — make sure you're
  on the latest `main` and ran `npm install` after pulling.
- **Google Sign-In crashes immediately in Expo Go**: expected under Expo Go
  (it needs a real native build). It works normally in the real APK (section 2).
- **Still stuck**: don't guess or work around it silently — describe exactly
  what you ran and what happened, and ask the project owner.
