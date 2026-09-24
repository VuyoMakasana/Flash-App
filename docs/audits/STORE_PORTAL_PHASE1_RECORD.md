# Store Portal — Phase 1 Record

**Status:** parts 1 and 2 complete and deployed. Part 3 (self-service onboarding)
**blocked** — see §3.
**Deployed:** `a7bb227` → deploy `dep-daqi8o8473hc738tv3u0`, live 13:24:44 UTC
2026-09-24.

---

## 1. Order attribution — fixed

### What was wrong

Attribution came from `orderController.resolveDefaultStoreId()`:
`SELECT id FROM stores WHERE is_active = true LIMIT 1`. Correct only while
exactly one store exists. With two, **every order would be attributed to
whichever store sorted first**, and once store payouts exist that misroutes real
money. It also wrongly attributed external/partner-only orders — which no Flash
store owns — to the default store.

### What changed

Attribution is now derived per order inside `Order.create`, from the **same
`FOR UPDATE`-locked `flash_inventory` reads the order is already built from**.
No extra query, no second lookup that could disagree with the first, and no race
against a product being reassigned mid-checkout.

| Basket | Attribution |
|---|---|
| No Flash inventory items (external/partner only) | `null` — owned by no store |
| Exactly one store's products | that store |
| Products from two or more stores | **rejected**, HTTP 400 |

`Order.create` **no longer accepts `store_id` from its caller at all**. No path —
client-supplied or controller-guessed — can attribute an order to a store that
does not own the goods in it.

### Why mixed baskets are rejected rather than split

Cart splitting is out of scope per the directive. The only alternative to
rejecting is to pick one store and silently misattribute the rest of the
basket's value — exactly the money-misrouting this change removes. Rejecting is
a **no-op against today's data** (all 20 production `order_items` resolve to the
single store) and leaves real splitting open as future work.

### Why the old fallback was removed, not kept

`resolveDefaultStoreId()` existed to stop a store lookup failure breaking
checkout. That failure mode no longer exists: attribution now comes from a read
that must already succeed for the order to exist at all. If it fails, the order
fails — exactly as it did before this change. There is no longer a separate
thing to guard.

### Verification

Five new tests in `tests/unit/orderStoreAttribution.test.js` call the **real**
`Order.create` against a mocked pg client and assert on the `store_id` actually
bound into the real `INSERT` — deliberately not a re-implementation of the logic
in the test, which would pass even if the production code were deleted.

Cases covered: single-store basket; **two-store basket rejected and no order row
written**; external-only basket → `null`; mixed Flash + external single store;
and a caller-supplied `store_id` failing to override the derived value.

**Mutation-checked.** Hardcoding the wrong store id in the production code makes
**4 of the 5 fail**; restoring passes all 5. The suite has teeth.

Full unit suite: **247/247** across 23 suites (was 242).

Production health gate after deploy: `/health`, `/admin-panel/login`,
`/api/inventory`, `/api/stores` all 200.

---

## 2. Store password-reset email — fixed

The email instructed recipients to *"Submit it with a POST request to
/api/store-auth/reset-password as { "token": …, "newPassword": … }"*. It was
written before the portal had a reset page. No store owner can act on that.

Both the text and HTML parts now link to the portal's real
`/reset-password` page (which asks for the pasted code), with a button and a
visible URL. Zero remaining "POST request" instructions.

The portal URL comes from `STORE_PORTAL_URL`, defaulted to
`https://flash-store-portal.onrender.com` so no new configuration was required.
It is deliberately **not** `APP_URL` — that points at the public app domain, not
the portal. Override the env var when the portal moves to its own subdomain.

---

## 3. Live SMTP test — **production email is broken**

The reset flow was triggered for real against production
(`POST /api/store-auth/forgot-password`, `makasanaivyson@gmail.com`).

**The API returned `{"success":true}` and a valid token was written** — 96 chars,
1-hour expiry, unused. By every signal available to the user, it worked.

**No email was sent.** The server log records:

```
[Store Auth] sendStorePasswordResetEmail error: Message failed: 550 You can only
send testing emails to your own email address (makasanavuyo206@gmail.com). To
send emails to other recipients, please verify a domain at resend.com/domains,
and change the `from` address to an email using this domain.
```

This is precisely the silent-failure mode flagged in the Phase 0 audit (§9.2),
now confirmed live rather than theoretical.

### What this actually means

1. **The mail provider is Resend**, reached over SMTP via nodemailer — the code's
   generic `SMTP_*` configuration masks which provider is behind it.
2. **Resend is in unverified-domain / test mode.** It will deliver *only* to
   `makasanavuyo206@gmail.com` (the account owner's address). Every other
   recipient is rejected with 550.
3. **`EMAIL_FROM` is `noreply@flashdelivery.co.za`** — a domain not verified in
   Resend, which is the reason for the rejection.

### Blast radius — far wider than the store portal

Every transactional email in the platform goes through the same
`sendEmail()`/transport:

- user password reset, email verification
- admin password reset
- SOS alerts, order escalation, missed-order alerts
- marketing lead notifications
- store welcome / store password reset

**All of these are currently non-functional for every recipient except one
address.** A search of the last 30 days of logs finds exactly **one**
`Message failed` entry — this test. No other transactional email has even been
*attempted* in that window, so the breakage is total but latent: the first real
user to request a password reset would have hit it silently.

### Required to fix (account actions — not code)

1. Verify `flashdelivery.co.za` at `resend.com/domains` (DNS records), **or**
   change `EMAIL_FROM` to an address on an already-verified domain.
2. Confirm the Resend API key in use is a production key, not a test key.

Both are external-account/env changes requiring the founder — deliberately not
done unilaterally.

### Secondary issue worth fixing in code

The send is fire-and-forget: `sendStorePasswordResetEmail(...).catch(log)` runs
*after* the response is already returned, so a hard 550 rejection cannot affect
what the user sees. That is defensible for latency, but it means a totally dead
mail path is indistinguishable from success at the UI. Once delivery works, this
should be revisited — at minimum surfacing failures to Sentry rather than to a
log line alone.

---

## 4. Part 3 (self-service onboarding) — blocked, not started

Self-service onboarding depends on email at its core: the signup verification
step, the invite-token mechanism, and the welcome email
(`sendStoreWelcomeEmail`) are all email-delivered. Building and "verifying" that
flow on a mail path that silently discards every message would produce a feature
that appears to work in testing and fails for every real applicant.

**Recommendation:** fix delivery (§3), re-run the reset test to confirm an email
actually arrives, and then build onboarding on a substrate that is known to work.

No onboarding code has been written.

---

## 5. State after Phase 1 parts 1–2

- `main` @ `a7bb227`, live.
- One unused reset token exists in production for the owner account
  (`89962215-…`, expires 14:26 UTC). Harmless — it expires on its own and does
  **not** change the password. The account password is unchanged and the owner's
  existing sessions are unaffected, since `password_changed_at` was never
  written.
- `Store.getDefaultStoreId()` is now unused by any caller. Left in place rather
  than deleted — it is a reasonable primitive, and removing it is unrelated
  cleanup.
