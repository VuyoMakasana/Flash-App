# Flash — Subscription Lifecycle, Account Deletion & Saved-Card Interaction Audit

Investigation only, per this audit's own instructions — nothing built or fixed in this pass. Every claim below is either a direct code citation or a live test result against the real production backend (`flash-app-hplc.onrender.com`) and its real Supabase database, using real throwaway accounts, cleaned up after each test.

---

## §1 — Driver subscription lifecycle

**How active/expired state is actually determined**: `subscriptionService.checkDriverSubscriptionAllowed` (`backend/src/services/subscriptionService.js:12-35`) runs:

```sql
SELECT * FROM driver_subscriptions
WHERE driver_id=$1 AND status='active' AND expires_at>NOW()
ORDER BY created_at DESC LIMIT 1
```

This is a **lazy, query-time check** — `expires_at>NOW()` is evaluated fresh on every call. The `status` column is never actively maintained; a row can sit with the literal text `status='active'` in the database forever after its `expires_at` has passed, and the check still correctly treats it as expired because of the date comparison, not the status flag.

**Nothing automatically flips a subscription to expired.** Confirmed by searching `backend/src/server.js` (where every cron job in this codebase is registered) for `driver_subscriptions`/`premium_subscriptions` — zero matches. There is no cron, no scheduled job, nothing. The only thing that ever changes a `driver_subscriptions.status` value at all is `Subscription.activateDriverPlan` (`backend/src/models/Subscription.js:44-64`), which flips the *previous* row to `'expired'` at the moment a *new* plan is purchased — not based on time passing.

**Real gap — the check is enforced in the wrong place.** `checkDriverSubscriptionAllowed` is called in exactly one place: `DriverController.getAvailableOrders` (`backend/src/controllers/driverController.js:216-219`, route `GET /api/drivers/available-orders`). It is **not** called in `setOnlineStatus` (`driverController.js:151-187`, route `POST /api/drivers/online`), which only checks commission debt and the service-area geofence. Live-confirmed against production:

- Created a real driver, real subscription row with `expires_at` one day in the past but `status` still `'active'`.
- `POST /api/drivers/online` → **`200 {"online":true}`** — succeeds with an expired subscription, no block at all.
- `GET /api/drivers/available-orders` → returned `{"orders":[],"closed":true,...}` — blocked, but by the *operating-hours* gate (`isClosedNow()`, which runs first in that same handler), not the subscription check, since the live test ran outside 07:00–19:00 SAST. To close that gap honestly, I ran the exact subscription query directly against the same expired row: **0 rows returned** — confirming the block condition itself is real and would fire the moment a driver reaches this endpoint during open hours.

Net: a driver whose subscription expires **mid-shift** is never kicked offline and isn't interrupted on an order already in progress — they simply stop being able to see or accept *new* orders the next time they poll the available-orders list. This is a soft cutoff on new work, not a hard mid-shift interruption, and there is no explicit "you're about to expire" warning anywhere in this code path.

**No renewal mechanism exists — auto or otherwise beyond a fresh manual purchase.** `Subscription.purchaseDriverPlan` (`Subscription.js:14-40`) always calls `paystackService.initializeGenericCharge`, which returns a fresh Paystack-hosted-checkout URL (see §5). `activateDriverPlan` is only ever invoked from `webhookController` after a brand-new charge completes. There is no stored "renew this automatically" flag, no cron that attempts one. Every renewal is a fully manual, from-scratch purchase.

**No grace period exists.** Because the check is a strict `expires_at>NOW()` comparison with no buffer, the very first `getAvailableOrders` call after expiry blocks with `"No active subscription plan. Purchase a plan to accept deliveries."` (or the delivery-limit message if `deliveries_used >= deliveries_limit`). Instant hard stop for new-order visibility, no window.

**Aside, not part of this audit's core ask but relevant context**: `subscriptionService.js`'s own header comment documents that `DRIVER_TEST_MODE` grants a real, signup-scoped `driver_subscriptions` row directly in `Driver.create()` — an already-existing, already-audited mechanism for giving test-mode drivers a working subscription without a real purchase. Not a new finding, just confirming it doesn't interact with anything above.

**Real duplicate code found, unrelated to any bug but worth flagging**: `Subscription.checkDriverSubscriptionAllowed` (`Subscription.js:128-151`) is a byte-for-byte duplicate of `subscriptionService.checkDriverSubscriptionAllowed`. Only the service version is actually imported and used (`driverController.js:5`); the model version appears to be dead code. Not verified further since this audit is investigation-only.

---

## §2 — The R99 premium subscription: confirmed decorative

Exhaustive search for every reference to `premium_subscriptions`, `isPremium`, and `getPremiumStatus` across the entire backend:

- `subscriptionController.getPremiumStatus` (`backend/src/controllers/subscriptionController.js:43-47`) — reads the status and returns it to the client. Nothing else.
- `Admin.js:149` and `Admin.js:245` — pure revenue reporting (total premium revenue, daily revenue chart in the admin dashboard).
- **Zero references anywhere in `Order.js`, pricing, driver-matching, or checkout logic** — confirmed by grepping `Order.js` specifically for "premium" (case-insensitive): no matches.

This is the same class of finding as `store_boosts` before it was given a real effect earlier tonight: **a customer can pay R99 and have it change literally nothing about their experience.** No priority matching, no fee waiver, no anything. This is a genuinely unused/aspirational feature today, confirmed precisely rather than assumed.

**Purchase flow status**: uses the identical Paystack hosted-checkout mechanism as driver plans (`Subscription.purchasePremium` → `initializeGenericCharge`, same as §1/§5). Whether this actually completes in production depends on whether `PAYSTACK_SECRET_KEY` is genuinely configured with a live key — this is **not a new gap found in this audit**, it's the same cross-cutting, already-documented, still-unconfirmed risk from `docs/audits/PRODUCTION_SECRETS_CHECKLIST.md` ("treat `PAYSTACK_SECRET_KEY` as a known, confirmed-broken gap — not a guess" — that document's own words, not re-verified fresh here since it's out of scope for a subscription-specific audit to re-litigate a cross-cutting secrets question already tracked elsewhere).

---

## §3 — Account deletion while subscribed: real, live-tested, and a real gap on both sides

**Driver side.** `Driver.deleteAccount` (`backend/src/models/Driver.js:136-179`) has exactly two guards: an active order (`orders.status IN ('driver_assigned', 'driver_arrived_store', 'picked_up', 'in_transit', 'delivered')`) and an outstanding wallet balance. **No subscription check of any kind.**

Live-tested against production: created a real driver, a real `driver_subscriptions` row with 25 days genuinely remaining, then called `DELETE /api/drivers/account` with that driver's own token.

- Result: **`200 {"success":true}`** — deletion succeeded immediately, no block.
- The `driver_subscriptions` row **after** deletion: `{"status":"active","expires_at":"2026-08-23T22:36:38.276Z"}` — completely untouched, still showing 25 real days remaining.
- The `drivers` row after deletion: `{"name":"Deleted Driver","email":"deleted-<uuid>@flash.invalid","status":"suspended"}` — correctly anonymized per the existing pattern.

So yes: the subscription silently persists as "active," attached to now-anonymized data, exactly as the audit hypothesized.

**User side — a real finding beyond just subscriptions.** `User.deleteAccount` (`backend/src/models/User.js:93-115`) has **zero guards of any kind** — not an active-order check, not anything. This audit's own framing assumed parity with the driver side's guards; that parity doesn't actually exist. Live-tested: created a real user, a real `premium_subscriptions` row with 20 days genuinely remaining, called `DELETE /api/users/account`.

- Result: **`200 {"success":true}`**, instant, no check.
- `premium_subscriptions` after: `{"status":"active","expires_at":"2026-08-18T22:36:48.171Z"}` — identically untouched and orphaned.

**Ghost-charge risk: confirmed moot, not just assumed.** Since §1 and §2 both confirm there is no auto-renewal or background charge mechanism for either subscription type — every charge is a manually-initiated, one-time Paystack hosted-checkout transaction — there is no cron or scheduled job that could ever attempt to charge a deleted account later. The orphaned row is a **data-hygiene and admin-reporting issue** (e.g., it would silently inflate an "active subscriptions" count in any future admin metric that trusts `status='active'` without also checking `expires_at`, the same trap noted in §1), not a financial or security risk.

**The real policy question, presented rather than decided**: should deleting an account with real time remaining on a paid plan be blocked (matching the order/wallet guards already on the driver side), explicitly refunded, or simply forfeited? In practice, forfeiture is already the *de facto* outcome today regardless of the subscription row's own status — the account's login credentials are destroyed and the driver's own `status` flips to `'suspended'`, so the subscription becomes functionally inert the instant the account is deleted, independent of whatever the `driver_subscriptions`/`premium_subscriptions` row still says. The open question is narrower than "should this be blocked" — it's really "should the orphaned row be explicitly closed out for data-hygiene reasons," which is a much smaller, lower-stakes decision than the audit's framing implied.

---

## §4 — Saved cards and subscriptions: the concern is moot by design

Confirmed via schema (`backend/src/db/migrate.js:427-440` for `driver_subscriptions`, `:511-518` for `premium_subscriptions`): neither table has any foreign key or column referencing `payment_methods` or `saved_cards`. The only payment-related column on either table is a plain-text `paystack_reference VARCHAR(255)` — a pointer to a *past, already-completed* transaction, not a live, reusable authorization.

Confirmed via code: both `purchaseDriverPlan` and `purchasePremium` call `paystackService.initializeGenericCharge` (Paystack's hosted-checkout initialization, see §5) — neither function reads from or writes to `payment_methods` at all.

**There is no persistent "this card renews this subscription" link anywhere in this codebase.** Combined with §1's finding that no auto-renewal mechanism exists at all, deleting any saved card can never affect any subscription, today, by construction — not because of a defensive check anywhere, but because the two features simply never reference each other.

---

## §5 — Subscription charges do *not* use the same card-selection flow as orders

The real order-payment flow (`backend/src/controllers/paymentController.js:252`) charges a specific, previously-saved card directly:

```js
paystackService.chargeAuthorization(card.authorization_code, ...)
```

The customer picks a saved card in-app; Flash's own server charges it server-side, with no redirect anywhere.

Subscriptions use a **fundamentally different mechanism**. `paystackService.initializeGenericCharge` (`backend/src/services/paystackService.js:149-180`) calls Paystack's `/transaction/initialize` endpoint and returns a hosted `authorization_url`. The user is redirected **out of the Flash app entirely**, to a page Paystack itself controls, where they enter or select a card within Paystack's own UI — completely bypassing Flash's saved-cards feature.

Practical effect: a user with an existing saved card from a previous order **cannot** reuse it in-app to buy a subscription the way they could reuse it for a new order. Every subscription purchase is a fresh, external, Paystack-hosted flow. This is a real, confirmed inconsistency — not "already correct by virtue of shared payment infrastructure," since the two flows use genuinely different Paystack integration patterns (hosted checkout vs. direct server-side authorization charge).

---

## Summary — what needs a founder decision vs. what's just a finding

| # | Question | Status |
|---|---|---|
| 1 | Subscription check at go-online? | **Confirmed gap** — only enforced at browse-orders, not go-online. Live-tested. |
| 1 | Auto-renewal / grace period? | **Confirmed: neither exists.** Hard stop, manual repurchase only. |
| 2 | Does premium do anything? | **Confirmed: no.** Decorative, same class as pre-fix `store_boosts`. |
| 3 | Driver subscription survives deletion? | **Confirmed, live-tested.** Orphaned, not cancelled. Ghost-charge risk moot. |
| 3 | User account deletion guards? | **New finding**: zero guards at all, not just missing the subscription check. |
| 3 | Should paid-time-remaining deletion be blocked/refunded/forfeited? | **Real policy question — not decided here.** |
| 4 | Saved-card deletion breaks subscriptions? | **Confirmed moot** — no link exists between the two features. |
| 5 | Do subscriptions use the picked-card flow? | **Confirmed: no.** Real, different mechanism (Paystack hosted checkout vs. direct saved-card charge). |

Nothing above has been built or changed. Awaiting direction on which of these (if any) should become real fixes.
