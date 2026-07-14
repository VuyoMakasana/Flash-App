# Testing Flash on your own phone (Android or iOS)

This is the guide for a collaborator setting up this repo for the first time and
running the two mobile apps (`flash-user-app`, `flash-driver-app`) on a real
device. Follow it top to bottom. If something here doesn't match what you see,
stop and ask rather than guessing — see "If something goes wrong" at the bottom.

## The short version

- The backend is already deployed and live at `https://flash-app-hplc.onrender.com`
  — you do **not** need to run it locally just to test the mobile apps.
- **Android**: install the pre-built app directly on your phone (no Expo Go
  needed, no SDK version issues). This is the recommended path.
- **iOS**: for now, requires a temporary workaround (below) because of an Expo
  Go version mismatch that isn't this project's fault — see "iOS testing" section.

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

## 2. Android testing (recommended path)

Android does not need a paid developer account. There are two ways to get the
app onto your phone:

### Option A — install the existing build (fastest, no EAS account needed)

A real "development client" APK has already been built for each app via EAS.
Ask the project owner for the latest download link (`eas build:list` shows
build history; each finished build has an `Application Archive URL` that's a
direct `.apk` download), or for them to trigger a fresh build so it includes
the latest code (see Option B).

1. Download the `.apk` to your Android phone (email it to yourself, or use a
   file-sharing link — Android will prompt to allow "install from unknown
   sources" the first time).
2. Install it. You'll see a real "Flash Driver" / "Flash" app icon — this is
   **not** Expo Go, it's a real custom build of this app.
3. Open the app once — it'll show a "Development servers" screen if it can't
   find a bundler yet. Leave it, go to step 3 below (starting the bundler),
   then come back and it'll connect automatically, or tap to enter the URL
   manually.

### Option B — build it yourself (if you have EAS access)

If the project owner adds you to the EAS project (`eas login`, they invite you
via the Expo dashboard), you can trigger your own build:

```bash
cd flash-user-app   # or flash-driver-app
npx eas-cli build --profile development --platform android
```

This takes 10-25 minutes (runs on Expo's servers, not your machine). When it
finishes, download and install the `.apk` link it gives you.

### Starting the bundler (do this every time you test)

Once the dev-client app is installed, you don't need to reinstall it again —
just start the JS bundler and connect to it:

- **Same WiFi as your computer, no client isolation**: `npm start`, then
  either scan the QR code with the dev-client app or it connects automatically.
- **Different network, or WiFi with client isolation (phone can't reach your
  computer directly)** — use the tunnel script instead:
  ```bash
  npm run tunnel
  ```
  First time only: get a free ngrok account at https://dashboard.ngrok.com/signup,
  copy your authtoken, and set it before running:
  ```bash
  # Windows PowerShell
  $env:NGROK_AUTHTOKEN="your_token_here"
  npm run tunnel
  ```
  It prints a URL — enter it manually in the dev-client app if it doesn't
  connect automatically. Stop with Ctrl+C.

## 3. iOS testing (temporary workaround required)

Expo Go's public App Store release is currently stuck on an older SDK version
(SDK 54) than this app actually uses (SDK 56) — Expo's own team has not given
a timeline for updating it. That means plain Expo Go will not load this app on
iOS today. There are two real options:

**Option A (recommended, permanent fix): get an Apple Developer Program
account** ($99/year, enrolled by the project owner) — this unlocks a real iOS
EAS development-client build, exactly like the Android path above, with no
workarounds needed. Ask the project owner about this if iOS testing becomes a
regular need.

**Option B (temporary, for a one-off test today): downgrade to SDK 54 on a
throwaway branch.** Do this on a new branch, never on `main`:

```bash
git checkout -b my-ios-test-branch
cd flash-user-app   # or flash-driver-app
npx expo install expo@54 --fix
npm run tunnel
```

Scan the QR / enter the URL in the real Expo Go app from the App Store. When
you're done testing, throw the branch away — **do not commit or push it**:

```bash
git checkout main
git branch -D my-ios-test-branch
```

This is a real, if inconvenient, limitation of Expo Go itself, not a bug in
this project.

## 4. Rules — please read before touching anything

This keeps you safe from accidentally breaking something, and keeps the
project owner from having to clean up after a mistake. None of this is about
trust — it's just how this project is run.

- **Work on your own branch.** Never commit or push directly to `main`.
  ```bash
  git checkout -b your-name/what-youre-doing
  ```
  Open a pull request when ready; don't merge your own PRs into `main`.
- **Never run database migrations or scripts against the production backend.**
  The live backend (`flash-app-hplc.onrender.com`) is real production data —
  real (test-mode) payments, real user accounts. If you need to test something
  destructive or run migrations, ask the project owner about spinning up a
  local backend + Postgres via Docker (`docker compose up -d --build` in
  `backend/`) instead of pointing at production.
- **Never run `eas build --profile production` or `eas submit`.** Those ship
  to real users / app stores. Stick to the `development` profile.
- **Never commit `.env` files, API keys, or anything from `eas.json`'s
  `submit` section.** If you're not sure whether something is a secret, ask
  first rather than committing it.
- **Don't force-push, don't rewrite git history, don't delete branches other
  than throwaway ones you created yourself** (like the iOS test branch above).
- **If a background-location or push-notification test requires a real native
  permission prompt** (Android background location, notification permission),
  that's expected — approve it to test the real flow, same as a real user would.

## If something goes wrong

- **"Cannot read property 'getGlobalHandler' of undefined" or similar crash on
  launch**: this was a real bug, already fixed on `main` — make sure you're
  on the latest `main` and ran `npm install` after pulling.
- **Tunnel gives `ERR_NGROK_121` or similar**: make sure you're using
  `npm run tunnel` (this project's own script), not `npx expo start --tunnel`
  — the built-in Expo tunnel flag uses an outdated ngrok agent that ngrok's
  servers now reject.
- **App loads the manifest but then fails to load the actual JS bundle /
  assets**: same tunnel issue as above — use `npm run tunnel`, which fixes a
  bundle-URL bug in the default flow.
- **Google Sign-In crashes immediately in Expo Go**: expected under Expo Go
  (it needs a real native build). It works normally in a real dev-client build
  (Android Option A/B above) or a real device build.
- **Still stuck**: don't guess or work around it silently — describe exactly
  what you ran and what happened, and ask the project owner.
