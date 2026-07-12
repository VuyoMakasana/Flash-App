# Flash — Access & Insider-Threat Security Audit

**Date:** 2026-07-11
**Scope:** Sentry error monitoring (all 3 surfaces), Cloudinary document storage, the return-alert email path, and a narrower-lens access-control audit: not "can an anonymous attacker break in" (covered by `FLASH_AUDIT_REPORT.md`, 2026-07-08) but "what could someone I've deliberately given access to — a contractor, a co-founder, anyone with a login or a permission — actually do with that access, and is it scoped to only what they need."
**Method:** Same standard as the rest of this engagement. Every claim below is either (a) a live test with real, captured output, or (b) an explicit "not verified" statement with the reason. Nothing is estimated or assumed. Full command transcripts exist in this session; specific proof points (status codes, JSON responses, API results) are quoted inline.

---

## 0. One honest note before anything else

You asked for these apps to be "unhackable." I want to say plainly: no real system is unhackable, and a report that claimed otherwise would be dishonest — the kind of dishonesty that would undo the credibility this whole engagement has built by being precise instead of reassuring.

What's actually achievable, and what this audit aimed for, is narrower and more useful: every currently-known attack surface either closed or knowingly accepted; every credential and secret properly scoped and rotatable; a real, specific answer to "what could someone I trust do with the access I've given them"; and an honest list of what's left over at the end. That standard is met below. "Unhackable" is not a standard any system meets, and I'm not going to tell you this one does.

---

## Addendum (2026-07-11, same day) — §2.3, §2.4, and §2.6's file-type gap have since been fixed and verified live

After this report was written, you asked me to fix three of the items listed below as open residual risk: the permanent-URL exposure (§2.3), the broken deletion path (§2.4), and the spoofable file-type check (§2.6). All three are now fixed and live-verified against the local dev stack; full detail in the chat record, summarized here:

- **§2.3 fixed:** `driver_documents` gained `public_id`/`resource_type` columns (additive, nullable schema change — approved before running); `file_url` is no longer stored or returned. `Admin.getDriverById` now generates a fresh signed URL per document on request via the (also-fixed — see below) `getSignedUrl()`. Proven live: a URL generated with an 8-second expiry returned `200 image/png` immediately and `401 "Stale request — expires_at ... has passed"` 10 seconds later.
- **Correction to this report's own §2.4:** I stated PDFs "get resource_type: 'raw'" — that was wrong. Verified live this session: a real, valid PDF uploaded through `resource_type: 'auto'` is classified `image` by Cloudinary (Cloudinary treats PDFs as page-renderable images), not `raw`. Only genuinely non-image/non-PDF content (e.g., the spoofed plain-text file from §2.6) falls back to `raw`. This didn't change the fix — `resource_type` is now stored per-document from Cloudinary's actual response rather than assumed — but the original claim was inaccurate and is corrected here rather than quietly edited away.
- **§2.4 fixed:** `getSignedUrl()` had its own separate, previously-uncaught bug (never called before, so never hit): it omitted `resource_type` and `type` and passed the literal string `'auto'` as a Cloudinary `format`, none of which are valid for this app's authenticated, mixed-resource-type documents. Fixed alongside `deleteFile()`, which now takes and passes through the correct `resource_type` per document instead of assuming Cloudinary's `'image'` default. Proven live: deleted a real uploaded document via the fixed `deleteFile()`, confirmed `{"result":"ok"}`, then independently confirmed via Cloudinary's Admin API (`404 Resource not found`) — not just the CDN URL, which is known to lag.
- **§2.6 fixed:** added real content-based (magic-byte) validation in `driverController.uploadDocument`, checked against the file's actual leading bytes after multer has the full buffer (this can't run inside `fileFilter` — multer calls that before the body is read). Proven live: re-ran the exact plain-text-declared-as-`image/png` exploit that succeeded earlier in this audit — now rejected with `400 "File content does not match an allowed type (PDF, JPG, or PNG)."` A real PNG and a real PDF both still upload successfully (regression-checked).
- Ran the full backend test suite after these changes: 126/127 passing. The one failure (`driverCommission.test.js`, unrelated to anything touched here) was confirmed pre-existing by stashing this session's changes and re-running against the unmodified code — identical failure, so not a regression from this work.
- All four test driver accounts created during this audit (including the two used to verify these fixes) have been deleted from the local dev database.

Everything else in this report — what's still open, what depends on you, the framing in §6 — stands unchanged.

---

## Addendum 2 (2026-07-11, same day) — the backend's Sentry DSN was misrouted into the mobile project; fixed and confirmed via the Sentry dashboard directly

You checked the Sentry dashboard yourself (§1.3 asked you to) and found the backend's errors — including today's `beforeSend` redaction test — were landing in the **react-native** project instead of **node**. You were right, and this was a real, separate bug from anything already listed in §1: `backend/.env`'s `SENTRY_DSN` held the react-native project's DSN, not node's. Both mobile apps' `EXPO_PUBLIC_SENTRY_DSN` were checked against Sentry's actual DSNs (via the `find_dsns` tool, not assumed) and are correctly pointed at react-native — no fix needed there.

Root cause, as best I can reconstruct it: earlier in this session (§1, before this addendum) I found and removed a duplicate `SENTRY_DSN` line in `backend/.env`, keeping "the" surviving value without checking it was the right project's DSN. I can't be certain whether the deleted line was the correct one — I didn't preserve its content — but either way this passed my own verification at the time because I only confirmed *a* real DSN was present and *a* Sentry event was captured, never *which project* it landed in. I didn't have dashboard access at that point to catch it; this session gained direct Sentry MCP access, which is what made this catchable at all.

**Fixed:** `backend/.env`'s `SENTRY_DSN` corrected to the real node-project DSN (confirmed via Sentry's `find_dsns` tool, not guessed). Backend container recreated. Re-ran the same test-error method as §1.3 (temporary authenticated route, hit once, removed), then — this time — confirmed directly via Sentry's own search tools which project it landed in: `flash-3h/node`, issue `NODE-3`, 1 event, and confirmed zero matching events in `react-native`. This is a stronger proof standard than §1.3 could reach on its own (that section could only confirm `Sentry.flush()` succeeded, not which project received it) — resolving the gap §1.3 explicitly flagged as founder-only-verifiable. The test issue has been marked resolved in Sentry; the test route and test driver account have been removed.

This changes §1.3's status: the "confirming the issue actually appears in your dashboard" item is now done, by you, and it caught a real bug in the process.

---

## 1. Sentry error monitoring

### 1.1 Configuration — real DSNs, all three surfaces

All three surfaces (`backend/.env`, `flash-user-app/.env`, `flash-driver-app/.env`) point at the same real Sentry project (`o4511185350557696`, project ID `4511192980062208`) — not a placeholder. One observation, not a finding: all three surfaces share **one** Sentry project rather than separate projects per surface. This isn't wrong, but it means backend and mobile errors interleave in a single dashboard/issue stream — worth knowing when triaging, not worth fixing.

### 1.2 Two Critical gaps found and fixed (with your explicit approval each time)

Both of these meant Sentry had **never actually captured a real error** anywhere in this app before this session, despite `Sentry.init()` being present in all three files:

- **Mobile: Sentry never initialized.** Both apps' code checked `process.env.EXPO_PUBLIC_SENTRY_DSN`; both `.env` files only defined `SENTRY_DSN` (no `EXPO_PUBLIC_` prefix, which Expo requires to embed a var into the actual client bundle — anything without that prefix is `undefined` at runtime). Proven by exporting a production web bundle (`npx expo export --platform web --output-dir <dir>`) and grepping it for the literal DSN string: zero matches. You approved fixing this now. Fixed by renaming the var in both `.env` files; re-verified via the same bundle-export-and-grep technique after a forced cache clear (`rm -rf node_modules/.cache .expo` — a stale Metro cache masked the fix on the first re-check) — one match in each app's exported bundle, confirming the DSN is now genuinely embedded.
- **Backend: no request error ever reached Sentry.** `errorHandler.js` (the middleware every controller's `catch` block forwards to) never called `Sentry.captureException` — Sentry only ever saw out-of-band `unhandledRejection`s (cron jobs etc.), never a real HTTP request error, which is the overwhelming majority of real production errors in this codebase. You approved wiring this in. Fixed by adding `Sentry.captureException(err, { extra: { url, method, headers } })` to `errorHandler.js`, right alongside the existing pino log line.

### 1.3 Backend capture — proven live, then cleaned up

Added a temporary route, hit it once with a real authenticated bearer token, confirmed capture, then removed the route:
```js
app.get('/api/__sentry_test', authenticate, (req, res) => {
  throw new Error('Deliberate Sentry test error — access-security audit, safe to ignore/delete');
});
```
`Sentry.captureException()` returned an event ID synchronously, and `Sentry.flush(2000)` — which resolves `true` only once the event is actually confirmed delivered to Sentry's servers — resolved `true`. This is the strongest proof available to me: the Sentry DSN is a write-only ingest credential, not a read/query credential, so I cannot pull the resulting issue's dashboard URL or ID back out to quote here — **confirming the issue actually appears in your dashboard is something only you can do**, by opening the project and looking for an error titled "Deliberate Sentry test error." The test route itself has been removed from `server.js` — current `server.js` has no test route present.

### 1.4 Mobile capture — not verified, and cannot be from here

This is the one item in this section I could not complete, and I want to be specific about why rather than paper over it: `@sentry/react-native` cannot be loaded outside an actual React Native/Metro runtime. I confirmed this directly — `require('@sentry/react-native')` in plain Node throws `Cannot find module '.../dist/js/integrations/exports'`. There is no device or simulator available in this environment. **I could not verify this**, and no environment change on my end would fix that — it requires a real device or simulator running the actual built app, which lines up with the on-device testing pass you already planned to do yourself. When you're on-device, triggering any real error (not a raw uncaught crash — use whatever in-app error-reporting call path the app already has, e.g. a caught exception passed to `Sentry.captureException`) and checking the dashboard for it is the remaining piece of this item.

### 1.5 `beforeSend` redaction — fixed, and I caught a real bug in my own first fix

All three surfaces had a `beforeSend` gap (flagged Medium in the original audit) — fixed with a recursive scrub function stripping token/password/authorization/cookie/secret-like keys. When I tested my own first version in isolation with a nested payload (e.g. `contexts.session.cookie`), it survived — the original scrub only checked the top level of whatever object was passed in, not the full object graph. Fixed to recurse with a `WeakSet` cycle guard, on all three: `backend/src/server.js`, `flash-user-app/App.js`, `flash-driver-app/app/_layout.js`.

**Proof, same standard as C-1 in the original audit:** ran a token-bearing request against the rebuilt backend container with both a top-level and a nested fake token/cookie in the payload passed to `beforeSend`. Both were stripped before `Sentry.flush()` confirmed delivery — verified inside the running container, not just read from the source.

### 1.6 Source maps — not configured, real gap

Confirmed by reading `app.config.js` in both mobile apps: neither has the `@sentry/react-native/expo` plugin in its `plugins` array. This means any error captured from a production mobile build will show a minified, effectively unreadable stack trace in Sentry — you'll see the error happened, but not where. This wasn't part of the pre-approved fix scope (it's a build-config change, not a one-line wiring fix), so I did not touch it. **Recommended next step, not done:** add the Sentry Expo plugin and configure source-map upload as part of the build pipeline.

### 1.7 Sentry's own project settings (PII/retention) — not verified, founder-only

The DSN grants write-only ingest access; it does not grant read access to your Sentry org/project settings (data retention window, PII scrubbing defaults, who else has dashboard access). **I could not verify this** — it requires either a separate Sentry Auth Token (not present anywhere in this environment) or you checking the dashboard directly under Project Settings → Security & Privacy. Worth a look specifically for: default data retention period, and whether "Enhanced Privacy" / server-side PII stripping is enabled as a second layer behind the `beforeSend` hook I just fixed.

---

## 2. Cloudinary document storage

### 2.1 Naming resolved

`backend/src/services/s3Service.js` is genuinely Cloudinary, not AWS S3 — the filename is a legacy artifact from when AWS was originally planned (per the file's own top comment: AWS was dropped because it "require[s] a paid account setup and billing info"). Confirmed by reading the implementation: it imports and configures the `cloudinary` SDK, not `aws-sdk`. No code change made — this was a naming-clarity question, not a bug, and renaming a file that's referenced elsewhere wasn't in scope without your sign-off.

### 2.2 Live upload — real document, real URL

Uploaded a real test document as an authenticated driver. Actual stored `file_url`:
```
https://res.cloudinary.com/degozhjhz/image/authenticated/s--...--/v.../flash-documents/<public_id>
```

### 2.3 Access control — tested directly, and here's the real finding

Fetching that URL with **zero credentials** does not return the raw file directly — Cloudinary's `type: 'authenticated'` delivery genuinely enforces signature validation; a request missing or with a wrong signature component returns `401`. That part works as intended.

But the URL Cloudinary auto-returns on an authenticated upload (`result.secure_url`, which is what `uploadFile()` stores as `file_url`) is a **permanently valid, non-expiring signed URL** — fundamentally different from a real short-lived signed URL. The correct mechanism for "private, time-limited access" already exists in this same file — `getSignedUrl()`, using `cloudinary.utils.private_download_url()` with a 5-minute expiry — **but it is dead code, never called anywhere in the codebase.** `Driver.uploadDocument` stores the permanent URL directly; `Admin.getDriverById` does `SELECT *` on `driver_documents` and returns that same permanent URL raw to any admin-authenticated caller.

**Real-world impact:** once a driver's KYC document URL is generated, it stays valid forever — for anyone who ever obtains it (a database read, a log line, an admin API response, browser history on a shared machine). This is a genuine gap between the code's evident intent ("Documents are private — use authenticated URLs," per the code's own comment) and what it actually does. This is the same class of issue as the original audit's access-control findings, specific to this new subsystem.

**Not fixed — flagging for your decision, per the investigate-and-report rule for this session.** The fix is straightforward (route document access through `getSignedUrl()` instead of storing/returning the permanent URL) but touches how documents are served to the admin page, so I didn't bundle it in silently.

### 2.4 Deletion — broken as written, confirmed genuinely broken, then confirmed it can work

`deleteFile()` calls `cloudinary.uploader.destroy(publicId)` with no `type` or `resource_type` option. Cloudinary's `destroy()` defaults to `type: 'upload'` and `resource_type: 'image'` when neither is given — since every document in this app is stored as `type: 'authenticated'`, and non-image documents (PDFs — the majority of real KYC uploads) get `resource_type: 'raw'`, the as-written call silently fails to find the asset (`{"result":"not found"}`) for **any** real document in this app. It is dead code, never called from anywhere in the codebase, so there is currently **no working deletion path at all** — worth flagging for POPIA relevance if a driver or user ever requests document deletion.

Confirmed by manually calling `destroy()` with the correct explicit options for two different real test uploads (one image-typed, one that Cloudinary classified as raw) — both succeeded (`{"result":"ok"}`), and I independently confirmed genuine deletion via Cloudinary's Admin API (not just the CDN delivery URL, which kept returning `200` for a period after deletion due to edge caching — the Admin API's `404 Resource not found` is the authoritative signal). Both test artifacts created during this audit have been deleted and confirmed gone.

**Not fixed.** The correct fix needs `deleteFile()` to accept and pass through both `type` and `resource_type` (and the caller needs to know/store the real `resource_type` per document, which isn't currently tracked) — a slightly larger change than a one-liner, flagging rather than doing silently.

### 2.5 Account-level settings — checked directly via the Admin API, no additional exposure found

- **Upload presets:** none configured (`{"presets":[]}`) — no unsigned-upload preset exists that could let a client upload directly to Cloudinary bypassing backend auth entirely.
- **Upload mappings:** none configured (`{"total_entries":0}`) — no folder is auto-mapped to public delivery.
- **Cross-path exposure:** confirmed the authenticated test document is **not** also reachable via the plain public `/image/upload/...` path (`404`) — no accidental dual-exposure.
- **`type: 'authenticated'` is hardcoded**, not per-call configurable, in `uploadFile()` — there's no code path that accidentally uploads a document as public.

So the exposure in §2.3 is specifically the permanent-URL issue, not any account-level public-delivery misconfiguration.

### 2.6 Size and file-type enforcement — one real, one confirmed bypassable

- **Size limit (10MB): genuinely server-enforced.** Uploaded an 11MB file as an authenticated test driver — rejected with `400 {"error":"File too large","message":"Maximum file size is 10MB"}` before anything reached Cloudinary. Multer aborts the stream itself; this is real.
- **File type: client-trusted, confirmed bypassable — live exploit reproduced.** `multer`'s `fileFilter` checks `file.mimetype`, which is the client-declared `Content-Type` header, not real file content. Uploaded a plain-text file (`"This is plain text, not a PNG at all."`) with a spoofed `Content-Type: image/png` and filename `spoofed.png` — **accepted**, stored, and returned as a valid `drivers_license` document (`200`, real `document.id` and `file_url` returned). This directly reconfirms the pre-existing Medium finding from the original audit report; it was not previously proven with a live exploit, and now is. Notably, Cloudinary's own internal `resource_type: 'auto'` inference correctly detected the real content wasn't an image (it stored it under `/raw/` rather than `/image/`) — but this is Cloudinary's own storage categorization, not a control this application checks or relies on. A real malicious upload declared as an image would be accepted by this app's own gate regardless.

Test artifact from this exploit (Cloudinary public_id `flash-documents/y62kaet5hmnsv0n1s69e`) has been deleted and confirmed gone (§2.4).

---

## 3. Email — return-awaiting-review alert

### 3.1 What I verified — real send, through the real code path

Called `sendReturnAwaitingReviewEmail()` directly inside the running backend container (not a re-implementation — the exact production function), with a real test payload. Result: Resend's SMTP relay (`smtp.resend.com`) returned `250` acceptance with a real message ID (`<56699b43-...@resend.dev>`), addressed to `makasanavuyo206@gmail.com` (your configured `ADMIN_EMAIL`).

### 3.2 What I could not verify, and why

This environment only has SMTP credentials (`SMTP_USER`/`SMTP_PASS`) — there is no separate Resend REST API key anywhere in the environment. A `250` SMTP response confirms Resend's relay **accepted** the message; it does not confirm it reached your inbox, wasn't classified as spam, or wasn't delayed. **I could not verify actual delivery** — checking Resend's own dashboard/API for this message ID's final delivery status, and checking your actual inbox, both require you specifically.

### 3.3 Please check, specifically (founder-only — I have no way to verify these)

- Whether the email actually landed in your **primary inbox**, not Spam or Promotions.
- Whether `makasanavuyo206@gmail.com` is your **primary** Google account on your phone, or a secondary one — secondary-account notifications are commonly muted by default even when the primary account's notifications are on.
- Phone OS-level notification permissions for the Gmail app specifically (not just "notifications enabled globally").
- Gmail's own per-account sync interval, if set to a battery-saving/long interval — a return sitting "awaiting review" for hours because a notification arrived late but silently is a real operational risk given there's no other channel that surfaces this today.

### 3.4 Recommendation, not built

A belt-and-suspenders channel independent of email/Gmail — e.g., an Expo push notification to a phone you control, or a second, different-provider email address — for this one specific alert (return awaiting final review) would remove single-point-of-failure risk on a channel you can't fully verify from here. I have not built this; flagging it as worth a decision, not doing it silently.

---

## 4. Access-control / insider-threat audit

### 4.1 Secrets hygiene

**`.gitignore` — verified genuinely excluding all three real `.env` files**, via `git check-ignore -v` against each real path (not assumed):
```
backend/.env         → backend/.gitignore:2:.env
flash-user-app/.env  → .gitignore:6:flash-user-app/.env
flash-driver-app/.env → .gitignore:7:flash-driver-app/.env
```
Only `.env.example` files (placeholders, no real values) are tracked in git, confirmed via `git ls-files | grep -iE "\.env|secret|credential|\.pem$|\.key$"` — no stray keystores, certs, or credential files tracked either.

**Fresh secret scan — clean.** Ran TruffleHog (full verified+unverified scan, entire git history, not just the CI's diff-against-main) fresh this session, after this engagement's secret rotations (JWT_SECRET, admin password hash, Resend key): `verified_secrets: 0, unverified_secrets: 0` across 5,442 chunks / 7.4MB of history. Nothing from this engagement's rotated secrets has leaked into git history.

**Secrets inventory** — every secret this app depends on, and who/what currently has access to its real value. Values are deliberately not reproduced here.

| Secret | Purpose | Where it lives | Who/what has access |
|---|---|---|---|
| `JWT_SECRET` | Signs all user/driver/admin auth tokens | `backend/.env` (local), Render env vars (production) | Anyone with this machine's `backend/.env`, or Render dashboard access at Admin/Developer role (see §4.2) |
| `PAYMENT_METHOD_ENCRYPTION_KEY` | Encrypts stored Paystack authorization codes | Same as above | Same as above — **see §4.2.1, the compounding risk** |
| `DATABASE_URL` | Full Postgres connection string (Supabase), embedded password | Same as above | Same as above, **and** anyone with Supabase project dashboard access |
| `PAYSTACK_SECRET_KEY` | Server-side payment API calls | Same as above | Same as above, and anyone with Paystack dashboard access |
| `ADMIN_PASSWORD_HASH` / `ADMIN_EMAIL` | The single admin login credential (see §4.2.2) | Same as above | Same as above, and anyone who is told the plaintext password out-of-band |
| `CLOUDINARY_API_SECRET` | Document storage API auth | Same as above | Same as above, and anyone with Cloudinary dashboard access |
| `SMTP_PASS` (Resend) | Sends transactional/alert emails | Same as above | Same as above, and anyone with Resend dashboard access |
| `SENTRY_DSN` | Error ingest endpoint (write-only, not itself a read credential) | Same as above, **and embedded in the mobile app bundles** (client-visible by design — this is normal for a DSN) | Same as above, and technically anyone who decompiles the mobile app — this is expected/low-risk for a DSN specifically |
| `GOOGLE_MAPS_API_KEY` | Maps SDK | Same as above, **and embedded in mobile app bundles** | Same as above; already flagged in the original audit that this should be restricted by package name/bundle ID/SHA-1 in Google Cloud Console — **not re-verified this session**, worth confirming that restriction is actually in place, since an unrestricted Maps key is usable by anyone who decompiles the APK |
| Google/Apple OAuth client IDs | Sign-in flows | `backend/.env` and mobile app config | Not truly secret by design (client IDs are meant to be public-ish); low risk |

Repo/GitHub access is **not** in this table because it grants access to none of the above — confirmed in §4.2.

### 4.2 Insider-access risk

**Repo-only access: confirmed, precisely, to extract nothing.** Someone with only a clone of this repository (no `.env` files, no hosting/DB/dashboard access) cannot extract any real secret, any real user data, or any payment credential — the repo contains only `.env.example` placeholder files (confirmed in §4.1), no real data is committed, and the fresh TruffleHog scan found nothing. This is a genuinely clean boundary.

**Hosting/deployment platform access: this is where real exposure lives.** Render (your confirmed host, per `APP_URL=https://flash-app-hplc.onrender.com`) sets production environment variables through its own dashboard, not through a `render.yaml` in the repo (I checked — none exists), so this exposure exists only on Render's side, invisible from the repo. I investigated Render's actual permission model rather than assuming:

| Render role | Sees env vars? | Can deploy? |
|---|---|---|
| Admin | Yes, full | Yes |
| Developer | Yes, for any environment not marked "Protected" | Yes |
| **Contributor** | **No — explicitly cannot view billing info, connection strings, or environment variables** | Yes, can trigger deploys |
| Viewer | No | No |
| Billing | No | No |

**Render does offer a deploy-only-equivalent scoped role — "Contributor."** It's not a perfect match (it also can't create/modify most resources, which may be more restrictive than you want for a contractor who needs to push config changes), but it directly answers your question: yes, a collaborator role exists that grants deploy ability without env-var visibility. Whether your current Flash service on Render has anyone set to Admin/Developer vs. Contributor, and whether the production environment is marked "Protected" (which restricts secret visibility to Admins even for Developer-role members, per Render's docs) — **I could not verify this**, it requires you to check the Render dashboard's team/member settings directly, since I have no Render account access in this environment.

#### 4.2.1 — The compounding risk, called out on its own regardless of severity elsewhere

You specifically asked me to check whether any single realistic access grant combines `PAYMENT_METHOD_ENCRYPTION_KEY` visibility with production database read access — because together, those two let someone decrypt every customer's stored Paystack authorization code (`payment_methods.authorization_code`, in the `payment_methods` table, decrypted via `backend/src/utils/paymentCrypto.js`).

**Confirmed: yes, this combination exists today, in one place.** Both `PAYMENT_METHOD_ENCRYPTION_KEY` and `DATABASE_URL` (a full Postgres connection string with the password embedded) sit in the exact same `backend/.env` file locally, and — since there's no `render.yaml` splitting them — almost certainly the same single environment-variable group on Render in production. This means **anyone with Render Admin or Developer role access to this service sees both secrets simultaneously**, in one dashboard, and could connect directly to the production Supabase database and decrypt every saved card's authorization code, using nothing but publicly available tools (`psql` + the app's own decryption function). This is the single highest-value credential combination in the entire app, and today it is not separated by any technical control — only by "nobody with that access would do that."

**Proposed split — not implemented, your call:**
1. **Immediate, low-effort:** for anyone who doesn't specifically need to read/rotate secrets, use Render's Contributor role instead of Developer/Admin, and mark the production environment "Protected" in Render. This alone breaks the combination for most realistic access grants (e.g., a contractor who only needs to deploy).
2. **Medium-effort, real technical separation:** create a restricted Postgres role in Supabase (`GRANT SELECT` scoped to exclude the `payment_methods` table, or exclude the `authorization_code`/`auth_fingerprint` columns specifically) for anyone who's given "DB read access for debugging" — so DB access alone, even combined with the encryption key, can't reach the encrypted codes.
3. **Longer-term, most robust:** isolate payment-method decryption into a narrow, separately-credentialed path (its own minimal DB role scoped only to `payment_methods`, holding only `PAYMENT_METHOD_ENCRYPTION_KEY`) so that no single broad "backend admin" credential set has both by default — anyone needing full backend access wouldn't automatically also get decrypt capability.

I'd recommend starting with #1 (it's a permissions-page change, not a code change) and treating #2/#3 as a deliberate follow-up if you ever add a second person with real production access.

#### 4.2.2 — Single shared admin credential (confirmed, not fixed, flagging plainly)

Confirmed by reading `adminController.js`: "There is no admins table — a single, config-driven admin identity (`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`) is the only one this system supports" (the code's own comment). There is no per-person admin login today. If you ever bring on a second person who needs admin access (a co-founder, an ops hire), the only options today are (a) share this one password with them, which means you can't tell who did what and can't revoke their access individually, or (b) build real per-admin accounts, which is a genuine feature addition, not a quick fix. **This is a real limitation to be aware of, not something to fix unprompted** — flagging per your instruction, since it only matters the moment a second admin is actually needed.

### 4.3 IDOR / ownership / admin-page exposure — fresh live tests

**Can a driver token reach any admin-page endpoint at all?** This was the specific gap you asked me to close that hadn't been explicitly tested. Registered a fresh driver account, got a genuinely unexpired token, and hit every admin and admin-gated returns endpoint:
```
GET  /api/admin/drivers                          -> 403 {"error":"Access forbidden. Required role: admin"}
GET  /api/admin/orders                           -> 403 {"error":"Access forbidden. Required role: admin"}
GET  /api/admin/stats                             -> 403 {"error":"Access forbidden. Required role: admin"}
GET  /api/admin/drivers/:driverId                 -> 403 {"error":"Access forbidden. Required role: admin"}
PUT  /api/admin/drivers/:driverId/status          -> 403 {"error":"Access forbidden. Required role: admin"}
GET  /api/returns/admin/pending                   -> 403 {"error":"Access forbidden. Required role: admin"}
POST /api/returns/:returnId/approve               -> 403 {"error":"Access forbidden. Required role: admin"}
POST /api/returns/:returnId/reject                -> 403 {"error":"Access forbidden. Required role: admin"}
POST /api/returns/:returnId/finalize-refund       -> 403 {"error":"Access forbidden. Required role: admin"}
```
No gap found — every admin and admin-returns route is gated by `requireRole('admin')`, confirmed live, not just read from the route file.

**Return ownership (consolidating what was proven during the returns build):** `returnController.requestReturn` passes the authenticated `req.userId` into `Return.requestReturn`, which raises `"Not your order"` on a mismatch — this is a model-layer check, not just a route-layer one, and was already proven live during the returns feature build earlier in this engagement.

**Admin page exposure beyond the login gate:**
- **Directory listing:** none. `public/admin/` contains exactly two files (`index.html`, `admin.js`); requesting a nonexistent path returns a clean `404 {"error":"Not found",...}`, not an Express/`serve-index`-style directory listing.
- **Path traversal:** blocked. `/admin/../../.env` and its URL-encoded form (`/admin/..%2f..%2f.env`) both return `404`.
- **Verbose error leakage:** none, confirmed live. Sent a malformed-JSON request to `/api/admin/login` to force a genuine parse error — response was the generic, production-mode message (`{"error":"Server error","message":"Internal server error"}`), not a stack trace. `errorHandler.js`'s `NODE_ENV === "production"` branch is doing its job.

**Session handling — same rigor as everywhere else, one real difference:** Read `adminController.js` directly. Admin login uses the exact same JWT infrastructure as user/driver auth — same `JWT_SECRET`, same `jti`-per-token + `revoked_tokens` table for logout-triggered revocation (checked on every authenticated request by the same `authenticate` middleware), same `adminLimiter` rate-limit on the login route (5 attempts/15 min) as flagged already-fixed in the original audit. It is not a quieter side door. The one real, worth-knowing difference: admin tokens are issued with an **8-hour** expiry and no refresh-token rotation, versus 15 minutes for user/driver access tokens. A leaked admin bearer token is valid for a much longer window than a leaked user/driver token, mitigated only by you explicitly logging out (which revokes it early) — there's no automatic short-lived-token-plus-refresh model on the admin side the way there is elsewhere.

### 4.4 Dependency audit — re-run fresh, compared against the original snapshot

Re-ran `npm audit` across all three apps this session. Same High-severity findings as the original audit (2026-07-08), same affected version ranges — **nothing new, and none of the previously-identified High findings have been patched upstream** in the intervening time:

| App | High-severity packages |
|---|---|
| `backend/` | `basic-ftp`, `form-data`, `nodemailer`, `systeminformation`, `undici`, `ws` |
| `flash-user-app/` | `engine.io-client`, `ws` |
| `flash-driver-app/` | `engine.io-client`, `ws` |

All have fixes available upstream (`fixAvailable: true` in the audit output). The original report's recommendation stands unchanged: `npm audit fix` (non-breaking) covers the low-risk subset across all three apps; `nodemailer`, `basic-ftp`, `form-data`, `systeminformation` need `--force` (breaking-change major-version bumps) and deserve a dedicated, tested upgrade pass rather than being bundled into a fix round. I have not run either — this is a report, not a fix, per this session's scope.

---

## 5. Cleanup

Two test artifacts remain from this session and need a decision:
- Two test driver accounts created for live IDOR/upload testing (`sizetest_...@example.com`, `idortest_...@example.com`, plus the earlier `sectest_...@example.com`) — real rows in the production-connected database. I have not deleted these, per the standing rule against deleting data without being explicitly asked. They're harmless (no real personal data, never approved, no orders), but they're yours to remove or leave.
- All Cloudinary test documents created during this session have already been deleted and independently confirmed gone via the Admin API (§2.4, §2.6).

---

## 6. Closing — what's actually true right now

**Genuinely hardened this session, verified live, not just read:**
- Sentry now actually captures backend request errors (previously it captured nothing from real requests) and mobile Sentry now actually initializes (previously it was silently dead on both apps) — both proven, not assumed.
- All three `beforeSend` redaction hooks correctly strip sensitive keys recursively, including nested ones my own first version missed — proven with live token-bearing test data.
- Cloudinary signature validation on authenticated documents is real (`401` without a valid signature); size-limit enforcement is real (server-side, not client-trusted); no account-level public-delivery misconfiguration exists.
- The repo-only access boundary is genuinely clean — confirmed via a fresh full-history secret scan, not assumed from the original scan.
- Every admin and admin-returns endpoint is confirmed unreachable by a driver-role token, live, with a fresh token.
- The return-alert email genuinely sends through the real production code path and is genuinely accepted by Resend's relay.

**Accepted or open residual risk — real, not fixed, your call on priority:**
- Driver KYC document URLs are permanently valid, not short-lived, despite the code's evident intent (§2.3) — the fix exists in the codebase already but is unused.
- `deleteFile()` is broken for every real document type in this app — no working document-deletion path currently exists (§2.4).
- File-type validation is client-trusted and confirmed bypassable with a live exploit (§2.6) — this was already known as Medium; it's now proven, not just suspected.
- No source maps on mobile Sentry — errors will be readable-but-unreadable (you'll know something broke, not where) until the Expo plugin is added (§1.6).
- `PAYMENT_METHOD_ENCRYPTION_KEY` and full DB read access currently travel together in any Render Admin/Developer-role grant — the single highest-value credential combination in the app, not yet technically separated (§4.2.1).
- Single shared admin credential, no per-person accounts (§4.2.2).
- Same six/two dependency High findings as the original audit, still unpatched (§4.4).

**Depends entirely on you, not on anything further I can do in code:**
- Confirming the Sentry test event actually appears in your dashboard (§1.3), and completing the mobile Sentry trigger-and-confirm on a real device (§1.4) — this lines up with the on-device testing pass you already planned.
- Sentry's own org-level PII/retention settings (§1.7) — dashboard access only you have.
- Whether the test return-alert email actually reached your inbox, and the phone/Gmail-side checks in §3.3 — I sent it and confirmed SMTP accepted it; I cannot see your inbox.
- Whether your Render team's actual role assignments and "Protected environment" setting are already set safely, or need changing (§4.2) — I found that the option exists; whether it's in use is a dashboard check only you can do.
- Whether a second admin will ever be needed, and if so, whether shared-credential risk is acceptable in the meantime (§4.2.2) — a policy decision, not a technical one.

That's the honest state of it: several real gaps closed and proven this session, a few concrete ones left open and named specifically rather than glossed over, and a short, explicit list of what only you can check from here.

---

## 7. Sentry MCP tooling credential

You asked for the same scrutiny applied to this session's own Sentry MCP connection that's been applied to every other credential in this engagement — not a pass just because it's tooling rather than app code. Here's what I found, real answers per question, with explicit "not verified" where that's the honest answer.

### 7.1 Where does the credential actually live?

**Not in this repository, and not in any file I have access to inspect the raw value of.** This is a **claude.ai account-level connector** ("claude.ai Sentry"), not a locally-configured MCP server with an API key in a project file. I checked directly rather than assuming:

- **No project-level MCP config exists.** Searched this repo for `.mcp.json` or any similar file — none found.
- **No Sentry token in the global Claude Code config either.** I inspected `~/.claude.json` and `~/.claude/.credentials.json` (key names only, no values printed) and found:
  - `~/.claude/.credentials.json` holds one credential: `claudeAiOauth` — an access/refresh token pair scoped to `user:file_upload, user:inference, user:mcp_servers, user:profile, user:sessions:claude_code`. This is the **Claude Code CLI's own session credential** for talking to claude.ai on your behalf (expires same-day, auto-refreshes) — it is not Sentry-specific. `user:mcp_servers` is the scope that lets this session *invoke* connectors like Sentry; it does not itself contain a Sentry token.
  - `~/.claude.json`'s only Sentry-related entry anywhere is `claudeAiMcpEverConnected: ["claude.ai Gmail", "claude.ai Supabase", "claude.ai Sentry"]` — a bookkeeping list of which connectors have ever been authorized, no token value.
- **Conclusion: the actual Sentry OAuth token is held entirely server-side by Anthropic**, established when the Sentry connector was authorized through claude.ai's own connector settings (claude.ai → Settings → Connectors), never transmitted to or stored on this machine. There is nothing in this repo or this machine's local config for `.gitignore` to fail to cover — the `git check-ignore -v` check I'd otherwise run doesn't apply because there's no local file holding it. This is a structurally different (and, for this specific risk — accidental repo commit — safer) storage model than every other credential in §4.1's table.
- **To rotate or revoke it, the founder's path is claude.ai's own connector settings, not any file on this machine** — disconnect/reconnect "Sentry" as a connector there.
- **Scope of reuse: this is an account-wide grant, not project-scoped.** Confirmed via `~/.claude.json`'s `projects` key, which lists multiple, unrelated local projects under this same account (including a "school website" project alongside Flash App). Because the connector is authorized at the claude.ai account level, once connected it's available to *every* Claude Code session and every claude.ai conversation under this account — not scoped to the Flash App repo or engagement specifically. This matters for blast radius: if this account's claude.ai session were ever compromised, Sentry access would be exposed regardless of which project the attacker was working in.

### 7.2 What can it actually do?

I don't have a way to read the raw OAuth token's scope string directly (no local file holds it, and Sentry's own token-management UI isn't something I can browse — no browser tool available in this environment). What I *can* and did verify: the actual set of Sentry operations exposed as callable MCP tools, checked via repeated, differently-worded catalog searches (`search_sentry_tools`) rather than inferring from only the tools I happened to already use. Results:

**Confirmed available** (real tool names, not inferred): `search_issues`, `get_issue_details`, `get_sentry_resource`, `update_issue` (resolve/reopen/ignore/assign), `add_issue_note`, `analyze_issue_with_seer`, `search_events`, `find_dsns`, **`create_dsn`, `update_dsn`**, `find_projects`, **`create_project`, `update_project`** (including renaming a project's slug), `find_teams`, **`create_team`, `add_team_to_project`, `remove_team_from_project`**, `find_alert_rules`, `get_alert_rule`, `find_monitors`, `find_releases`, `find_dashboards`, `get_dashboard_details`, `get_profile`, `whoami`.

**Explicitly checked for and NOT found**, across multiple targeted searches ("organization members," "billing subscription," "create API token," "invite member," "delete project"): no tool to read or modify organization/team *membership* (who belongs to the org), no billing/subscription access, no project deletion, no API token creation or revocation, no source-map/release-artifact download tool, and — directly tested via `find_organizations()` — **no access to any organization other than `flash-3h`** (the call returns exactly one org).

**This is a real finding, not a clean pass:** the scope is broader than what this engagement actually needed (issue read/search/resolve). It can also **create and modify Sentry projects, teams, and DSNs** — `add_team_to_project`/`remove_team_from_project` change access grants, `create_dsn`/`update_dsn` can mint new ingest endpoints or deactivate existing ones, and `update_project` can rename a project's slug (which would break every app currently configured with that slug in its URLs/config). None of that was needed for anything done in this session, including the DSN-routing fix — `find_dsns` (read-only) was sufficient. This is the same shape of problem already flagged for Render in §4.2: a connection scoped for troubleshooting that can also reshape the environment it's troubleshooting.

**One honest limit on this finding:** I'm reporting what's exposed through this MCP tool *catalog*, verified by direct, repeated query rather than assumption. I cannot fully rule out that the underlying OAuth grant is scoped even more broadly than what's surfaced as callable tools — that would require inspecting the raw token via Sentry's own account settings (Settings → Auth Tokens / Integrations), which only the founder can do.

### 7.3 How was it created, and who else could see it?

- **Exact creation timestamp: not verified, and I cannot determine it from this environment.** No local file records when the Sentry connector was authorized (consistent with §7.1 — the grant lives server-side). The best evidence available is indirect: the Sentry MCP tools only became available partway through *this session* (they appeared as newly-available deferred tools right as this DSN-routing question came up) — consistent with the connector having been authorized recently, specifically to support this engagement, rather than being a long-standing token from unrelated earlier work. That's an inference from tool-availability timing, not a verified fact — flagging the distinction explicitly rather than presenting it as confirmed.
- **Confirmed distinct from `SENTRY_DSN`** — checked directly, not assumed. A DSN (e.g., the `node` project's `https://e4daeb99...@...ingest.us.sentry.io/4511185360912384`, §4.1/Addendum 2) is a write-only, project-scoped ingest identifier that ships inside application code (safe to embed client-side by design — that's why it's fine in a mobile app bundle). The credential authenticating these MCP calls is an account-level OAuth grant with read/write management access across the whole `flash-3h` org (§7.2). They're issued through entirely different mechanisms (DSNs auto-generate per-project on creation; this OAuth grant came from an explicit connector-authorization flow on claude.ai), and at no point did any DSN value get passed to or used by any Sentry MCP tool call in this session. Not the same credential, not interchangeable, and confirmed by checking rather than by the two both being "Sentry-related."
- **Sentry account identity confirmed via `whoami`:** authenticated as `makasanavuyo206@gmail.com` (Sentry User ID `4415872`) — this is the same email as `ADMIN_EMAIL` in `backend/.env` (the Flash app's own admin login), and a *different* email from the claude.ai account driving this Claude Code session (`makasanaivyson@gmail.com`, per local config). That's expected and not itself a finding — it just confirms whose Sentry account this actually is.

### 7.4 Recommendation

**Storage: no action needed.** The credential isn't in this repo, isn't in a local file, and isn't exposed to anything this engagement's repo-access or hosting-access analysis (§4.2) already covers. This is a clean result on that specific axis, reported plainly rather than manufactured into a finding.

**Scope: worth narrowing, not urgent.** The connector can do real, state-changing things beyond what any troubleshooting session in this engagement has needed — create/rename projects, create/delete team-project access grants, create/deactivate DSNs. Recommend: after this engagement, disconnect the Sentry connector from claude.ai's connector settings (Settings → Connectors) if it isn't going to be in regular use, and reconnect only when actively needed. If claude.ai's connector settings ever offer a narrower, read-only or issue-management-only grant for Sentry specifically, that would be the better standing configuration — I did not find evidence such a narrower option exists today, but didn't have a way to confirm its absence either (that's a claude.ai product question, not something inspectable from here).

**Not worth rotating urgently** — nothing here suggests the credential has leaked or been misused; the gap is "broader standing access than necessary," the same category as the Render Developer-vs-Contributor finding in §4.2, not evidence of compromise.

### 7.5 Secrets inventory addition

This is a real, distinct credential worth tracking, added to §4.1's table:

| Secret | Purpose | Where it lives | Who/what has access |
|---|---|---|---|
| Sentry MCP OAuth grant ("claude.ai Sentry" connector) | Lets this Claude Code session query/manage the `flash-3h` Sentry org via MCP tools | Held server-side by Anthropic (claude.ai account infrastructure) — not in this repo, not in any local file on this machine | Anyone with access to the `makasanaivyson@gmail.com` claude.ai account session (account-wide grant, not scoped to this repo/project); revocable only via claude.ai's own connector settings, not via any action on this machine or in this repo |

---

## 8. Real on-device testing found a Critical bug that the entire prior audit, every unit test, and every bundle export check missed

This section exists because of what happened tonight, not because it fits neatly under access/insider-threat scope — it's important enough on its own to record here rather than leave buried in commit history.

### 8.1 What happened

Getting `flash-user-app` running on a real iPhone over a restrictive network (fibertime, client-isolated) took several real, unrelated fixes this session: a misconfigured Expo Go/ngrok tunnel setup, an ngrok agent version rejected by ngrok's own servers, a bundle URL leaking Metro's local port through the tunnel, and — because Expo Go's public App Store release is currently two SDK versions behind this app's real SDK 56 — a temporary SDK 54 downgrade on a throwaway branch (`sdk54-testing`, never merged, never pushed) just to get *anything* rendering on the phone at all.

Once the app actually loaded on the device — the first time either mobile app has ever run outside a bundler or export check, by the founder's own account — it crashed immediately with a real, reproducible error: `Cannot read property 'getGlobalHandler' of undefined`, inside a `useEffect` in the app's root component.

### 8.2 The bug, and why nothing before tonight could have caught it

Both `flash-user-app/App.js` and `flash-driver-app/app/_layout.js` had:
```js
import { ..., ErrorUtils } from 'react-native';
```
`ErrorUtils` has never been a named export of the `react-native` package, on any version — it's a global (`global.ErrorUtils`), established by React Native's own core before any user module even loads. Confirmed directly against the installed source in both apps, and independently against the published `react-native` package for both 0.81 (this app's temporarily-downgraded test version) and 0.85 (the app's real, shipping SDK 56 version) — zero occurrences of `ErrorUtils` as an export in either. This was never an SDK-54-downgrade artifact; it was already sitting on `main`, in both apps, before tonight.

The import silently resolved to `undefined`. The code that used it — a `useEffect` handling session-expiry recovery — ran on every real mount of the app's root component and crashed immediately.

**Why this survived the original pre-launch audit, every unit test, and every `expo export`/bundle check performed throughout this whole engagement**: all of them build, parse, or statically analyze the code. None of them execute an actual React component render pass — and this bug only manifests when a real renderer actually mounts the component and runs its `useEffect`. A backend unit test doesn't touch this file at all; a mobile bundle export confirms the JS is syntactically valid and all imports *resolve to something* (even `undefined` bundles cleanly — a broken destructure isn't a bundling error, it's a runtime error); nothing short of an actual render pass — a real device, a simulator, or a React Native-aware test renderer — was ever going to catch this. This engagement had none of those available until tonight's on-device pass.

### 8.3 Fixed on `main` directly, real proof, not "it compiles"

Fixed in both apps (`ccfbc7c`): read `global.ErrorUtils` directly instead of destructuring a nonexistent export, guarded defensively (skip if genuinely unavailable) even though it's provably always present in this runtime — confirmed by reading React Native's own `ErrorUtils.js` source, which literally reads `export default global.ErrorUtils` with a comment stating the global is established before any user module loads. No behavior change beyond no longer crashing.

Verified past "does it compile," matching the standard already used throughout this session: started each app's real dev server, fetched the actual JS bundle a device would load (not the static export, which compiles to Hermes bytecode and can't be inspected as text), and grepped the real compiled output. `global.ErrorUtils` present (11 occurrences in each app — React Native's own internals plus this fix); zero trace of the old broken destructured pattern. `flash-driver-app` lint clean (0 errors, same 4 pre-existing warnings, unrelated lines). This fix is on `main`, committed and pushed directly — it did not wait for the returns-flow work or the on-device testing branch, since a bug that crashes the app on every real launch has nothing to do with returns specifically.

### 8.4 The actual point

This bug would have shipped. It passed the original full pre-launch audit. It passed every unit test in the backend suite (irrelevant file, but worth naming — "tests passed" said nothing about this). It passed every mobile bundle export check performed this entire engagement, including several run *this very session*, on *this exact file*, before tonight's device test. It would have crashed the app for every single real user, on the very first launch, in production — and nothing in this project's current verification pipeline would have caught it before a user did.

**This is a strong, concrete argument for treating real on-device testing (or at minimum, a real React Native test renderer capable of executing actual component mounts — Jest with the `react-native` preset, Detox, or equivalent) as a required pre-launch gate, not an optional final step.** Static analysis, unit tests, and bundle export checks are necessary and were genuinely valuable throughout this engagement — they caught real, serious findings — but this specific class of bug (a broken import that's syntactically valid and only fails when actually executed inside a component lifecycle) is structurally invisible to all three. Only execution catches execution bugs.
