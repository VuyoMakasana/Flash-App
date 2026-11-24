# Admin MFA (TOTP): design and lost-phone runbook

**Status:** design for review (PR 2, #91). The schema is v45, **applied to production on 2026-11-24 at 01:35 SAST** (`PROD_MIGRATIONS.md` §9). **The code is PR 3**, moved to the week after the 2026-11-29 real-money test (founder, 2026-11-24), and is built only once this design is approved. Until PR 3 merges, **nothing in the running code uses any of this**.

**Founder decisions (2026-11-23):**
- TOTP for every admin;
- **mandatory immediately** (the founder enrols right after the PR 3 deploy);
- enrolment through a page in the admin panel;
- Node `crypto` only, no new dependencies;
- MFA comes before L0.5b.

## 1. What is stored (v45)
| Where | Column | Meaning |
|---|---|---|
| `admins` | `totp_secret_enc` text | The TOTP secret, encrypted (§2.3). The database never sees it in plain text. |
| `admins` | `totp_enrolled_at` timestamptz | When enrolment was confirmed with a working code. |
| `admins` | `totp_last_step` bigint | The last 30-second time step accepted (§2.2). |
| `admin_mfa_recovery_codes` | `id`, `admin_id` → `admins` (cascade), `code_hash`, `created_at`, `used_at` | One row per recovery code, stored as a sha256 hash; `used_at` is set on use. |

**Constraints:**
- `admins_totp_check`: the secret and the enrolment time are set together or not at all; a last step exists only once enrolled, and is ≥ 0; the secret has the `v<n>:iv:tag:ct` format.
- On `admin_mfa_recovery_codes`: a hex-sha256 CHECK, and `UNIQUE (admin_id, code_hash)`.
- RLS is on for both tables, with nothing granted to `anon`/`authenticated`.

An admin with all three columns NULL is **not enrolled**.

## 2. Mechanics (Node `crypto` only)
### 2.1 TOTP (RFC 6238)
- HMAC-SHA-1, **6 digits**, **30-second steps**, T0 = 0, dynamic truncation (RFC 4226 §5.3).
- **The secret:** 20 random bytes (`crypto.randomBytes`, 160 bits, as RFC 4226 recommends), shown to the authenticator app as RFC 4648 base32.
- **Accepted:** the current step `s` and **±1 step** (`s−1`, `s`, `s+1`), allowing about 30 s of clock drift either way.
  - All three candidates are always computed and compared with `crypto.timingSafeEqual`, with no early exit.
  - Input must be exactly 6 digits after removing spaces.
- **Tests:** the RFC 6238 Appendix B SHA-1 vectors, plus window edges and a skewed clock.

### 2.2 No code works twice
A matched step `m` is accepted only if `m > totp_last_step`, with one atomic statement:
`UPDATE admins SET totp_last_step = $m WHERE id = $id AND (totp_last_step IS NULL OR totp_last_step < $m) RETURNING 1`.
No row means the code was already used (or an older one was), so it's refused and counts as a failure. Two requests racing with the same code: exactly one wins. The v45 rehearsal proves this statement.

### 2.3 The secret at rest: AES-256-GCM
- **Key:** `ADMIN_TOTP_ENCRYPTION_KEY`, exactly 64 hex characters (32 bytes). Anything else is refused. It's separate from every other secret, so a leak of `ADMIN_JWT_SECRET`, `ADMIN_SESSION_SECRET` or the database doesn't reveal TOTP secrets.
- **For each encryption:** a 12-byte random IV, a 16-byte tag, and AAD = `flash-admin-totp:v1:<admin id>`. The ciphertext is bound to its admin row, so a secret copied onto another admin's row won't decrypt.
- **Stored as** `v1:<iv>:<tag>:<ciphertext>` (base64url). The `v1` is the key version, so a future second key needs no schema change.
- A decryption failure is treated as "can't verify": the login is refused and logged. It never falls back to letting the admin in.

### 2.4 Recovery codes
- **10 codes per admin, shown once.** Each code is 80 random bits, written as 16 Crockford-base32 characters, `XXXX-XXXX-XXXX-XXXX`.
- **Input is normalized:** upper case; spaces and hyphens removed; `O`→`0` and `I`/`L`→`1`.
- **Stored as** `sha256(normalized)` in hex. 80 random bits can't be reversed from the hash, so a slow hash isn't needed, and the lookup is a direct index hit.
- **Each code works once**, through one atomic statement:
  `UPDATE admin_mfa_recovery_codes SET used_at = now() WHERE admin_id = $id AND code_hash = $h AND used_at IS NULL RETURNING id`.
- **Regenerating** replaces all 10 in one transaction. Old codes stop working.
- When 3 or fewer remain, every page shows a banner: "Make new recovery codes."

## 3. Admin panel (AdminJS) flow
1. **Password:** the existing login page and `verifyAdminCredentials` (lockout, role, dummy hash), as today. The session id is regenerated, as today. The session now records `mfa: 'enrol'` or `mfa: 'verify'`, and **not verified**.
2. **The gate.** A session middleware is mounted on the admin-panel router **in front of** AdminJS's router: the same options, and one shared `MemoryStore`.
   - `express-session` 1.19.0 skips itself when `req.session` already exists (checked in its source), so AdminJS's own session middleware then reuses it. AdminJS 6.1.1 only checks that `session.adminUser` exists.
   - Until `session.adminUser.mfaVerified === true`, the only paths reachable are `/admin-panel/mfa/*`, `/admin-panel/logout` and static assets.
   - Every other page redirects (302) to `/admin-panel/mfa`, and `/admin-panel/api/*` answers `403` JSON.
   - A half-finished login expires 10 minutes after the password step, and the session is then destroyed.
3. **The enrolment page** (not enrolled; the only page available until it's finished):
   - **Setting up the app:** a new secret is generated and kept **only in the server-side session** for 10 minutes. The page shows the setup key, grouped for typing, plus an `otpauth://totp/Flash%20Admin:<email>?secret=…&issuer=Flash%20Admin` link, which opens the authenticator app when tapped on the iPhone. **There's no QR code:** drawing one needs a new dependency (see §9).
   - **Confirming:** the admin types the 6-digit code from the app. One transaction then:
     - writes the encrypted secret, `totp_enrolled_at = now()` and `totp_last_step` = the matched step, `WHERE totp_enrolled_at IS NULL`, so a double submit or a race can't enrol twice;
     - inserts the 10 code hashes;
     - writes `admin_actions` `admin_mfa_enrolled`.
   - **The recovery codes:** shown once. The admin ticks "I have saved these codes" to continue. The session is then marked verified and **regenerated**, and the dashboard opens.
4. **The code page** (enrolled): a 6-digit code, or "Use a recovery code".
   - **On success:** verified, session regenerated, and the lockout counter reset.
   - **A recovery code** also writes `admin_actions` `admin_mfa_recovery_used`, with the number of codes left.
5. **The security page** (verified sessions only):
   - **"Set up a new authenticator"** needs the current password and a current code or a recovery code. It writes a new secret and 10 new codes in one transaction (`admin_mfa_reenrolled`). This is the lost-phone path when the codes are still available (runbook A).
   - **"Make new recovery codes"** needs a current code (`admin_mfa_codes_regenerated`).
6. **Protection on every MFA form:**
   - a per-session CSRF token, on top of the `SameSite=Strict` cookie;
   - the existing `adminLimiter` (5 per 15 min per IP) on the MFA POSTs.

## 4. `/api/admin/login` flow (no admin token before the second factor)
1. **`POST /api/admin/login {email, password}`:** the same checks as today.
   - **Not enrolled:** `403 {error: "Set up two-step verification in the admin panel first.", code: "MFA_ENROLMENT_REQUIRED"}`.
   - **Enrolled:** `200 {mfaRequired: true, challenge, expiresIn: 300}`. **No token.**
   - **This is a deliberate response change.** Nothing in this repo calls this endpoint: the apps and the store portal were checked.
2. **The challenge** is a JWT, signed with a key **derived** from `ADMIN_JWT_SECRET`: HKDF-SHA256 with `info = "flash-admin-mfa-challenge-v1"`.
   - Because the key is different, the admin auth middleware (raw `ADMIN_JWT_SECRET`) can never accept a challenge as an admin token.
   - Claims: `sub` = admin id, `typ: "admin_mfa"`, `jti`, `exp` = 5 minutes.
   - It's single-use: its `jti` is remembered in memory until it expires (one backend instance, like every limiter today).
3. **`POST /api/admin/login/mfa {challenge, code}` or `{challenge, recoveryCode}`:**
   - **An expired or invalid challenge** gets `401 {code: "MFA_CHALLENGE_EXPIRED"}` and doesn't count toward the lockout (it isn't a guess).
   - **Otherwise:** the lockout is checked first, then the code.
   - **On success:** the admin token, as today (8 h, `jti`), plus `amr: ["pwd","otp"]` (or `["pwd","recovery"]`).
4. **Admin tokens without `amr` are refused** by the admin auth middleware. Every admin API token issued before the PR 3 deploy stops working at once, which is what "mandatory immediately" requires.

## 5. The lockout (the existing per-account counter, `adminLoginLockout`)
- **What counts as a failure, on both logins:** a wrong password, **a wrong TOTP code, a reused code, a wrong recovery code**. All of them share the one counter (5 in 15 min).
- **Change:** a correct password **no longer resets the counter**. Only a complete login (the password plus the second factor) resets it. Otherwise someone who has the password could reset the counter with each password entry and guess codes forever.
- **When locked:** `429` on the API and the existing "try again in 15 minutes" message in the panel.
- **The honest numbers:** at 5 guesses per 15 minutes and 3 accepted codes in 10⁶, someone holding the password has about a 0.14% chance per day. So **a lockout reached at the code step (the password was right) emails that admin**: "Your admin password was used with wrong codes. Change it now." This uses the existing email service, with one email per lockout window.

## 6. Logging and audit
- **Never logged:** secrets, codes, challenges or tokens.
- **Logged:** event names, with the admin id.
- **Written to `admin_actions`:**
  - `admin_mfa_enrolled`, `admin_mfa_reenrolled`, `admin_mfa_codes_regenerated`;
  - `admin_mfa_recovery_used` (with the number of codes left);
  - `admin_mfa_reset` (runbook C).

## 7. Failing closed, and `ADMIN_TOTP_ENCRYPTION_KEY`
- **In production, with the key missing or invalid:** the admin panel refuses to mount (as with `ADMIN_SESSION_SECRET`), and `/api/admin/login` answers `503`. **No admin can ever log in without MFA**, and there's no "MFA off" switch.
- **When to add it:** in Render, **before merging PR 3**. It's harmless before then, because nothing reads it until PR 3. PR 3 restates this.
- **Never change it casually:** changing it makes every stored secret undecryptable, so every admin must then be reset (runbook C) and re-enrol. **Rotating it = runbook C for every admin.** `SECRETS_INVENTORY.md` carries the row.

## 8. Lost phone: the runbook
Recovery is **always a reviewed, committed procedure: never an ad-hoc SQL edit.**

**Where to keep the recovery codes:** the PR 3 enrolment guide covers it. In short: in the password manager, in a separate entry from the admin password, **and** a printed copy somewhere safe at home. Never in email, chat, the repo or photos.

### A. Phone lost, recovery codes available (in the panel, no database access)
1. Log in with the password, then choose **"Use a recovery code"**.
2. Go to **Security → "Set up a new authenticator"**: the current password plus another recovery code. Enrol the new phone, then **save the 10 new codes**. All the old codes stop working.
3. If the phone was **stolen**, also change the admin password. Every step is in `admin_actions`.

### B. Phone and codes lost, and another enrolled admin exists
- Not built in PR 3, because there's one admin today. It will come when a second admin is added: a "Reset two-step verification" action on another admin, with confirmation, a typed reason and an `admin_actions` row. Nobody can reset their own MFA this way.
- **Until then, use C.**

### C. Phone and codes lost, and no other admin (database credential required)
This uses **committed, reviewed files added in PR 3**:
- `scripts/prod-migrations/R-ResetAdminMfa.ps1`, with its `reset_admin_mfa.sh`;
- `backend/src/db/ops/admin_mfa_reset.sql`, whose sha256 is checked before it runs, like a migration.

They're never edited at the time of use.

1. **Prepare:**
   - `git checkout main` and `git pull` (the script refuses otherwise, like step D);
   - Docker Desktop running;
   - the Supabase **Session pooler** connection string, from the password manager.

   If the database password is lost too: reset it in the Supabase dashboard (behind your Supabase login and its own 2FA), then update `DATABASE_URL` in Render first (`SECRETS_INVENTORY.md`).
2. **Back up first:** `B-Backup.ps1 -Migration mfa-reset`.
3. **Run** `R-ResetAdminMfa.ps1 -Email <your admin email>`.
   - It asks for the connection string with `Read-Host -AsSecureString`, and never prints it.
   - **It shows (read-only):** the matching admin's name, email, enrolment time and how many codes are left.
   - **You type** the email again, plus a reason.
   - **Then, in one transaction:**
     - it refuses unless **exactly one** admin matches the email exactly;
     - it sets the three TOTP columns to NULL and deletes that admin's recovery codes;
     - it writes `admin_actions` (`admin_mfa_reset`, `{method: "runbook", reason}`);
     - it prints the before and after states.
4. **Log in at `/admin-panel` straight away.** Enrolment is forced. Save the new codes.
5. **Record it** in `docs/WORKLOG.md`. If the phone was stolen, change the admin password too.

**Why C is safe:**
- it needs the production database credential, which is a stronger factor than the phone;
- it backs up first, runs fixed reviewed SQL, affects exactly one row, and is audited;
- it never weakens MFA for anyone else.

## 9. Decisions and limits
- **No QR code** at enrolment: the setup key and the `otpauth://` link work in every authenticator app. A QR code needs a new dependency (for example `qrcode`). **Founder: say so if you want one.** It would be a separate dependency request.
- **Sessions, the challenge `jti` list and the lockout live in memory** (decision A5; one Render instance). A restart logs everyone out and clears the lockouts, the same as today.
- **Later, not now:** WebAuthn or passkeys.

## 10. What PR 3 tests (one test per path, at least)
- **Enrolment:** a pending secret; a correct code enrols, and a double submit doesn't enrol twice; the codes are stored hashed and shown once.
- **The gate:** an unverified session can only reach the MFA pages; its API calls get 403.
- **The code step:**
  - a correct code;
  - a wrong code (counts as a failure);
  - **a reused code** (refused, and counts);
  - a ±1 step edge, and outside the window.
- **Recovery codes:** one works once; a second use fails; a wrong one counts.
- **The lockout:** 5 failures across the password and code steps lock the account; a correct password alone doesn't reset it; the lockout email is sent.
- **The API challenge:** it expires after 5 minutes (`MFA_CHALLENGE_EXPIRED`, not counted); it's single-use; it can't be used as an admin token; tokens without `amr` are refused.
- **Encryption:** a round trip; a wrong key, the wrong admin id (AAD) and a damaged ciphertext all fail closed; an invalid key format refuses to start.
- **RFC 6238** test vectors.
