# iOS release: from Apple sign-in to TestFlight internal testers

**Who this is for:** the founder, doing the first iOS builds of both apps. It also covers updates afterwards.

**Why TestFlight:** the App Store's Expo Go is now SDK 58, and both apps are on SDK 54, so they can't run in Expo Go on an iPhone any more. Both apps go to iPhones as real builds through TestFlight.

**What PR E (#104) already set up, so the first build should work first time:**
- **`eas.json`, both apps:**
  - the `production` profile has channel `production`, and `preview` has channel `preview`;
  - every profile points at `https://api.flashdelivery.co.za`;
  - the unused `pk_test` key is gone;
  - build numbers count up by themselves (`appVersionSource: remote`, `autoIncrement`).
- **Icons:** your two 1024×1024 icons, opaque, iOS only (`assets/icon-ios-1024.png` in each app).
- **Privacy manifest:** built from the libraries' own `PrivacyInfo.xcprivacy` files (`ios.privacyManifests`).
- **Permissions:**
  - **user app:** location while using only, no "Always";
  - **driver app:** a background-location text that says what the app actually does (location while online, stops when offline).
- **Hidden on iOS:** Google sign-in, in both apps (Apple and email stay), and Flash Premium.
- **Maps:** on iOS the customer's tracking map uses Apple Maps, so it needs no Google key.
- **Engine:** the driver app's Expo Go engine workaround is removed; both apps use Hermes, the standard engine.
- **Encryption:** `ITSAppUsesNonExemptEncryption: false` is set, so App Store Connect doesn't ask the export-compliance question for each build.

**Not needed for internal TestFlight:** Apple's review. Internal testers can install a build as soon as App Store Connect finishes processing it. External testers, and the App Store itself, need review; the App Store review items are a later step (PROJECT_STATE.md).

---

## 0. Before you start (once)
1. **Apple Developer Program membership is active again.** Check on developer.apple.com → Account; it should show the membership with an expiry date in the future.
2. **Your Team ID** is on that same Membership page (10 characters).
3. **The Expo account:** you can sign in to expo.dev as the owner of the `vuyomakasana` organization (both projects live there).
4. **The backend is deployed** with everything the build needs (#102 / #103 for Sunday's fixes). Render shows the commit.
5. On your Windows computer, in PowerShell, from the repo, on an up-to-date `main`:
   ```powershell
   git checkout main
   git pull
   npx eas-cli --version     # downloads the EAS CLI the first time; any recent version is fine
   npx eas-cli login         # your Expo account
   ```

## 1. Put your Apple details in `eas.json` (both apps)
- In `flash-user-app/eas.json` and `flash-driver-app/eas.json`, under `submit.production.ios`, replace `TODO_FOUNDER_APPLE_ID_EMAIL` with your Apple ID email and `TODO_FOUNDER_APPLE_TEAM_ID` with your Team ID. Neither is a secret.
- There is no `ascAppId` on purpose: step 4 finds or creates the App Store Connect app from the bundle id.
- The quickest way is to send me both values and I'll open a one-line PR, so `main` stays the source of truth.

## 2. App Store Connect: the two app records
- On the App Store, an app's **name must be unique across the whole store**. "Flash" and "Flash Driver" are very likely already taken. Choose store names now, for example "Flash Delivery SA" and "Flash Driver SA". The name under the icon on the phone stays "Flash" / "Flash Driver"; the store name is separate.
- The bundle ids are fixed: **`co.za.flash.userapp`** (customer app) and **`co.za.flash.driverapp`** (driver app).
- Step 4's submit may create the record for you. If it says it can't, create it yourself:
  - App Store Connect → **Apps** → **+** → **New App**;
  - platform **iOS**, your store name, primary language **English (U.K.)** (or your choice);
  - the bundle id from the list (it appears there after step 3's first build has registered it);
  - SKU: anything, e.g. `flash-user-ios`.

## 3. The first build (one app at a time; start with the driver app)
From the app's folder:
```powershell
cd flash-driver-app
npx eas-cli build --platform ios --profile production
```
What happens, and what to answer:
1. **"Do you want to log in to your Apple account?"** → **Yes**. Then enter your Apple ID, password and the 2-factor code.
2. **The App ID:** EAS registers `co.za.flash.driverapp` and turns on the capabilities the config asks for: **Sign in with Apple**, and **Push Notifications** (from `expo-notifications`).
3. **Distribution certificate and provisioning profile:** say **Yes** to letting EAS generate and store them.
4. **Push notifications key:** if it asks whether to set up push notifications, say **Yes** and let it **generate a new Apple Push Notifications service key**. Without it, iPhones get no push notifications.
5. The build runs on Expo's servers (usually 15–30 minutes). You can close the window; it continues, and the link it printed shows progress.

Then do the same for the customer app:
```powershell
cd ..\flash-user-app
npx eas-cli build --platform ios --profile production
```
It reuses the certificate. It asks for a new provisioning profile for `co.za.flash.userapp` and the same push key choice.

**If a build fails:** send me the link to the build page. The logs are there, and nothing on your side needs undoing.

## 4. Send each build to TestFlight
From the app's folder, after its build finished:
```powershell
npx eas-cli submit --platform ios --latest
```
- It uses the `submit.production.ios` values from step 1. Log in to Apple again if it asks.
- If it offers to create the App Store Connect app, accept and give the store name from step 2.
- **App Store Connect → your app → TestFlight:** the build appears with status **Processing**, then **Ready to Submit** / testable. This usually takes 5–30 minutes. Apple emails you when it's done.
- I couldn't confirm from here exactly which prompts `eas submit` shows for a brand-new app; if they differ, the App Store Connect app can always be created by hand (step 2).

## 5. Internal testers
- **Who can be one:** only people in your App Store Connect team, up to 100. Add each person under App Store Connect → **Users and Access** → **+**, with a role (Developer or Marketing is enough). They accept the invitation email.
- **Then:** your app → **TestFlight** → **Internal Testing** → **+** to create a group (e.g. "Flash team") → add the testers → add the build.
- **On each tester's iPhone:** install **TestFlight** from the App Store, open the invitation email, and tap **Install**. No Apple review is needed for internal testers.
- **First check on a device**, for each app:
  - **Driver app:** sign in with Apple, and there's no Google button. There's no "Buy Plan" anywhere. Inside Gqeberha, Go online works; allow location "Always" when asked.
  - **Customer app:** sign in with Apple. The products load and are real, not demo items. The payment screen shows Card only. Profile shows no "Flash Premium". Location asks "While Using" only.

## 6. After the first build: JS-only fixes ship as updates
A fix that only changes JavaScript (no new native module, no `app.config.js` permission change) reaches TestFlight users without a new build:
```powershell
cd flash-driver-app          # or flash-user-app
$env:EXPO_PUBLIC_API_BASE_URL = "https://api.flashdelivery.co.za"   # REQUIRED, or the update points at localhost (FI-118)
npx eas-cli update --channel production --platform ios --message "what changed"
Remove-Item Env:EXPO_PUBLIC_API_BASE_URL
```
- Publish from an up-to-date `main`, after the backend change it needs is deployed.
- **How it reaches phones:** the app downloads the update on launch and uses it **the next time it's opened**, so close and reopen the app twice to be sure.
- **When a new build is needed instead:** a new native module, a permission or other `app.config.js` change, or an SDK change. For these, raise `version` in `app.config.js` (e.g. 1.0.0 → 1.0.1), because updates are tied to the version (`runtimeVersion: appVersion`). Then repeat steps 3–5.

## 7. The day the TestFlight builds install: Sunday's real-money test
Formerly "Sunday 29 November" (L-16 in `LAUNCH_INFRA_CHECKLIST.md`). It now runs on the first day both TestFlight builds are installed on the testers' iPhones (steps 3–5). The money rules are unchanged: Flash Closet only, card only, cash off.
1. **Wake the server:** open `https://api.flashdelivery.co.za/health` until it answers `{"status":"ok"}` (free plan cold start, L-12).
2. **Switch `cash_orders` off:** admin panel → Operations → Feature switches → `cash_orders` → **Switch off**, with a reason. Check that `https://api.flashdelivery.co.za/api/status/features` shows `"cash_orders": {"enabled": false, …}`.
3. **One Flash Closet card order, delivered to completion:**
   - keep the store portal open and **refresh it** to see the order (it has no live updates yet, FI-040);
   - accept and mark it ready within 15 minutes, or it auto-cancels;
   - the driver goes online, accepts, takes both photos, and completes with the customer's code.
4. **One Apple Pay order:** pay with Apple Pay on Paystack's page in Safari.
5. **One cancellation, refunded:** cancel the Apple Pay order **before the store accepts**.
   - The order shows **refunded** once Paystack confirms (FI-126).
   - An hour later, `payment_refunds` still has exactly one row for it.
6. **The return page:** after paying, Paystack's page returns to **"You can go back to Flash now"**.
7. **Don't tap Pay again** on an order you've already paid. If it happens, the second payment is refunded automatically and you get an admin email (FI-122).
8. **Paystack dashboard, webhook event history:** each `charge.success` and `refund.processed` for these orders shows as delivered (HTTP 200). A 503 means the server's Paystack key is missing or is a test key (FI-121).
9. **Pay the test driver's earnings manually.** They stay in the wallet; driver payouts aren't built.

**Not in the test:** partner stores, cash, store payouts, driver payouts.
