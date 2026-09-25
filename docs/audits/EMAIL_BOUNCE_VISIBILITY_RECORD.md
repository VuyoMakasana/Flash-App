# Email Bounce Visibility — Record

Closes the blind spot recorded as §6 of `STORE_ONBOARDING_FRONTEND_RECORD.md`
and surfaced concretely during the onboarding end-to-end pass.

---

## 1. The problem, with the real incident

`sendEmail()` resolves the moment Resend **accepts** a message. A bounce
happens asynchronously afterwards. Nothing was listening, so every caller —
including the fire-and-forget `sendStoreWelcomeEmail` — logged success and
moved on.

This is not hypothetical. On **24 Sep 2026** a real store password-reset to a
real Gmail address **bounced**. Flash recorded nothing. It was found only by
going and looking in Resend's own dashboard while investigating something else.
Metrics at the time: 3 sent, 2 delivered, **1 bounced**, `bounced_transient` —
Gmail deferring a brand-new sending subdomain, not a bad address.

**Why it matters most for onboarding:** the welcome email is the *only* way an
approved owner ever receives a password. A bounce leaves an active store whose
owner cannot sign in, while the store, the account and the invite token all look
perfectly healthy in the database. Nobody at Flash has any signal at all, and
the owner's natural recovery — "Forgot password?" — sends mail down the same
path and can bounce the same way.

---

## 2. What was built

### Webhook endpoint

`POST /api/webhooks/resend`, mounted in `webhookRoutes.js` with
`express.raw({ type: 'application/json' })` — the same treatment Paystack gets,
and for the same reason: Svix signs the original bytes, so anything that
re-serialises the JSON first invalidates every signature.

Resend delegates webhook signing to **Svix**. Verification is implemented with
node's `crypto` rather than by adding the `svix` package — one more dependency
in the webhook path is not worth twenty lines, and this file already verifies
Paystack's HMAC by hand. The scheme was read from Svix's own documentation, not
assumed:

- headers `svix-id`, `svix-timestamp`, `svix-signature`
- signed content is `` `${svix-id}.${svix-timestamp}.${rawBody}` ``
- the secret is `whsec_<base64>`; the base64 portion decodes to the HMAC key
- HMAC-SHA256, base64-encoded
- the header carries space-delimited `v1,<sig>` entries, and may carry several
  during a secret rotation, so any one valid `v1` entry passes

Plus a **±300s timestamp tolerance** (Svix's own default). Without it a single
captured request would stay replayable forever.

### Durable record

**`email_events`** (migration v37) — every event received, for **every**
recipient. Deliberately general rather than store-specific: the transport is
shared by customer password resets, email verification, SOS alerts, order
escalation and admin mail, so a systemic delivery failure should be visible here
whoever it affects.

`svix_id` is `UNIQUE`, which is what makes the handler idempotent. Svix retries
on any non-2xx **and on timeouts**, so the same event legitimately arrives more
than once; `ON CONFLICT DO NOTHING` means a retry cannot double-record a bounce
or double-update an account.

### Account-level status

Four nullable columns on `store_users`: `welcome_email_status`,
`welcome_email_status_at`, `reset_email_status`, `reset_email_status_at`.
Nullable means "nothing has gone wrong that we know of", which is the correct
state for every existing row and avoids backfilling history we do not have.

Only **failures** are mirrored onto the account. A `delivered` event is recorded
in `email_events` for context but never clears a bounce — the operationally
interesting state is "this person did not get it", and a later unrelated
delivery must not erase it.

### How an event is attributed

By subject line, via `EMAIL_SUBJECTS` / `TRACKED_EMAIL_KINDS` in
`emailService.js`. Both the senders and the webhook handler read the same
constants, for the same reason `STORE_STATUS_TRANSITIONS` exists: if each spelled
the subject out separately, editing one would silently stop bounces being
attributed and **nothing would fail**. Tests assert the senders use the constants
and that no sender restates a tracked subject as a literal.

---

## 3. The admin-visible signal, and what staff should do

**Where it appears:** a new read-only **Email Events** resource in the admin
panel, newest first, listing `event_type`, `recipient`, `subject`, `reason`,
`created_at`. The raw provider payload is kept on the detail view for diagnosis.
Read-only on purpose — these are received facts about what a mail provider did,
and editing one would be falsifying a delivery record.

**What each signal means:**

| `event_type` | Meaning | Action |
|---|---|---|
| `email.delivery_delayed` | Provider deferred it; may still arrive | Usually none. Watch for repeats to the same domain — that is reputation, not a bad address |
| `email.bounced`, transient | Temporary refusal (greylisting, rate limits) | None immediately. Repeats across many recipients mean a sending-reputation problem |
| `email.bounced`, permanent | The address does not accept mail | **Act.** The recipient will never receive anything at that address |

**For a store owner specifically.** A bounced *welcome* email means an approved
owner cannot sign in and does not know why. A bounced *reset* email means the
same for someone already locked out. In both cases:

1. Confirm it in **Email Events**, filtered by the owner's address.
2. Contact them **out of band** — `stores.owner_phone` is captured at
   application time, precisely the field to use here.
3. Get a working address.

Step 4 — actually changing the address — is where this stops. See §5.

---

## 4. The reset-path question, answered

The specific concern raised: *does a bounce on the reset path leave a store
owner stuck where "forgot password" silently fails the same way, with no
recourse?*

**Before this work: yes, completely.** The owner requests a reset, gets nothing,
requests again, gets nothing. Flash has no signal, so nobody knows to help. The
owner cannot distinguish "the email bounced" from "I typed the wrong address"
from "Flash is broken". That is a permanent, silent lockout.

**After this work: the silence is fixed; the lockout is not.** The bounce now
appears in Email Events and stamps `reset_email_status = 'bounced'` on the
account, so Flash can see it and reach out by phone. But there is still **no
admin tooling to change a store user's email address or to set a password**:
`store_users` is deliberately not an AdminJS resource, so correcting a bad
address today requires hand-written SQL against production.

So the honest position is: **visibility is delivered, recourse is human and
partly manual.** That is the right order — you cannot act on what you cannot
see — but it should not be mistaken for the problem being fully solved. The
remaining piece is recorded in §5.

---

## 5. Not built, and why

- **No admin action to correct a store user's email address.** This is the
  natural next step and the thing that would turn visibility into recourse.
  Deliberately not built here: changing the address an account signs in with is
  an account-takeover primitive if it is not carefully scoped and audited, and
  it deserves its own design rather than being bolted onto a webhook PR.
- **No automatic retry or alerting.** Visibility first, automation later, per
  the brief. There is no Slack/email alert on a bounce — an admin has to look.
  A cron summarising "approved owners whose welcome email bounced and who have
  never signed in" would be a cheap, high-value follow-up.
- **No suppression handling.** Resend maintains a suppression list; repeated
  hard bounces can stop future delivery to an address entirely. Not surfaced.
- **`email_events` has no retention policy.** Other high-volume tables are
  pruned by cron (`driver_locations` at 30 days, `browsing_events` at 60). This
  one will grow unbounded. Volume is tiny today (3 emails in 30 days), so it is
  not urgent, but it should get a prune job before email volume rises.

---

## 6. Testing

23 new tests, mostly adversarial, because the endpoint **writes to the database
on an unauthenticated request**. If verification can be bypassed, anyone can
forge `bounced` against any address — including marking a competitor's owner as
undeliverable.

| Attack | Result |
|---|---|
| Unsigned request | 400, nothing written |
| Wrong signing secret | 400, nothing written |
| **Tampered body** (real event, swapped recipient) | 400, nothing written |
| Replay with an old timestamp | 400 |
| Future timestamp | 400 |
| Downgraded signature version (`v0`) | 400 |
| Wrong-length signature | 400, and does not throw (`timingSafeEqual` would) |
| Missing secret configured | 500, fails closed, nothing written |
| Non-raw body | 400 |
| Multiple signatures (secret rotation) | Accepted if any one `v1` entry is valid |

Plus: duplicate delivery ignored, delayed recorded as `delayed` not `bounced`,
`delivered` never clearing a bounce, untracked subjects logged but updating no
account, and the subject-map drift guard.

### Mutation-tested

| Mutation | Tests that failed |
|---|---|
| Signature check always passes | **4** |
| Timestamp tolerance removed | 2 |
| Missing-secret fail-closed removed | 1 |
| `ON CONFLICT` idempotency guard removed | 1 |

All reverted. Backend suite **431 → 454**, 36 suites, all passing.

---

## 7. Deployment order — this one matters

**Migration v37 must be applied to production BEFORE this is merged.**

`adminPanel.js` now calls `db.table('email_events')`, and `@adminjs/sql`'s
`DatabaseMetadata.table()` **throws** `Table does not exist` for a missing
table — confirmed by reading the adapter source. `mountAdminPanel` is caught
and not awaited, so this would not crash the server, but it **would take the
entire admin panel down** — all 26 resources — leaving only a log line.

v37 is purely additive (a new table plus new nullable columns) and the
currently-deployed code references neither, so applying it first is invisible
to production. This is exactly the hazard recorded as OPEN_FOLLOWUPS #16.

**Order:**

1. Apply v37 to production.
2. Merge and deploy.
3. Create the Resend webhook pointing at
   `https://flash-app-hplc.onrender.com/api/webhooks/resend`, subscribed to at
   minimum `email.bounced` and `email.delivery_delayed`.
4. Set `RESEND_WEBHOOK_SECRET` on the backend service to the `whsec_…` value
   Resend issues. Between steps 3 and 4 the endpoint answers 500 and Svix
   retries, so no event is lost.
5. Verify with a real send.

---

## 8. Not verified

- **Nothing has been received from Resend yet.** Signature verification is
  tested against signatures this test suite generates using the documented
  algorithm — not against a genuine Resend delivery. The algorithm was read
  from Svix's documentation rather than confirmed against a live payload, so
  the first real event is the actual proof.
- **The webhook is not configured yet** and `RESEND_WEBHOOK_SECRET` is not set
  — both are deployment steps above.
- **v37 has not been run against production.**
- **The Email Events admin resource has not been loaded by an authenticated
  admin** — same credential limitation as previous rounds.
- **The payload shape is assumed from Resend's documented examples**
  (`data.to[]`, `data.subject`, `data.email_id`, `data.bounce.message`). If the
  real shape differs, events will still be recorded — the raw payload is stored
  — but attribution to a store user could miss. The first live event will show
  this immediately, and the stored payload makes it correctable without data
  loss.
