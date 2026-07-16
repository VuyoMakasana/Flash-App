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

This is a real, standalone build of the actual current app (from `main`) —
not a dev-client shell, not dependent on anything running on anyone's
computer. Install once, open it like any other app, forever.

1. Download the APK on your Android phone:
   - **Flash (user app)**: https://expo.dev/artifacts/eas/v70CtR77mk6Dt3f-tCHnwCvdFKT5mbYe1vyFZExNmfg.apk
   - **Flash Driver**: https://expo.dev/artifacts/eas/0CGfkA8cBjkedrejluK-dPp1I7kJO34xHI551Aqwk3I.apk
2. Android will warn about "installing from unknown sources" the first time
   — this is normal for an app not yet published on the Play Store, not a
   sign anything is wrong. Tap through and allow it.
3. Open the app. That's it — it works exactly like the real app will once
   published, talking to the live backend already.

**These links don't expire and don't need anyone's computer running** — they're
served directly from Expo's own infrastructure. If the project owner pushes
new fixes to `main` later, ask them to rebuild (`npx eas-cli build --profile
preview --platform android`, from `flash-user-app/` or `flash-driver-app/`)
and share a fresh link — the ones above are a snapshot of `main` as of
2026-07-16, not auto-updating.

## 3. Expo Go — iOS, or Android without installing an APK

Expo Go's public App Store/Play Store release is currently stuck on an older
SDK version than this app's real one (SDK 56) — Expo's own team has given no
timeline for updating it (confirmed directly against Expo's changelog).
That's a real limitation of Expo Go itself, not a bug in this project, and
it's why this path runs off a dedicated branch, `expo-go-testing`, kept
intentionally on the older, Expo-Go-compatible SDK rather than `main`.

**Open Expo Go** (install it free from the App Store or Play Store first),
then open one of these links on your phone (tap the link directly if you're
reading this on your phone, or scan the QR code on the linked page if you're
on desktop):

- **Flash (user app), Android**: https://expo.dev/accounts/vuyomakasana/projects/flash-user-app/updates/40fecd0a-2b4c-476e-abad-d4af5e7a9e2f
- **Flash (user app), iOS**: https://expo.dev/accounts/vuyomakasana/projects/flash-user-app/updates/37a1b464-59fd-4723-81e1-35121d8ecefc
- **Flash Driver, Android or iOS**: https://expo.dev/accounts/vuyomakasana/projects/flash-driver-app/updates/daf41305-8c4e-45a7-af6d-add68db1d513

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
- **"Cannot read property 'getGlobalHandler' of undefined" or similar crash on
  launch**: this was a real bug, already fixed on `main` — make sure you're
  on the latest `main` and ran `npm install` after pulling.
- **Google Sign-In crashes immediately in Expo Go**: expected under Expo Go
  (it needs a real native build). It works normally in the real APK (section 2).
- **Still stuck**: don't guess or work around it silently — describe exactly
  what you ran and what happened, and ask the project owner.
