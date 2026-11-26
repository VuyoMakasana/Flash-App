# Kill switches (L0.5b): how to stop one flow fast

**Who this is for:** the founder (or an on-call admin) during an incident, a test, or a launch step; and developers adding a new guarded route.

Built in #98, on the v44 `feature_switches` table. **The design was approved on 2026-11-21**, with these decisions: the admin panel only flips switches; the messages are fixed in code.

## How to switch something off (or on)
1. **Open the screen:** admin panel → **Operations → Feature switches**.
2. **Switch it:** open the switch, then choose **Switch off** (or **Switch on**). **Type a reason**: it's required, and it's kept in `admin_actions`, with the old value, the new value and your admin id.
3. **When it applies:** everywhere **within 15 seconds**, with no restart. The server you're on applies it at once.
4. **Check it:**
   - the **Effective now** column on the list;
   - or open `https://api.flashdelivery.co.za/api/status/features` in a browser. It's public and shows only on/off and the customer messages.

**If the panel or the database is down:** in Render → Flash-App → Environment, set **`FEATURE_<KEY>=off`** (for example `FEATURE_CARD_PAYMENTS=off`).
- It always wins, even over the panel.
- **It needs a restart** (about a minute of cold start).
- Remove the variable to hand control back to the panel. The panel's "Effective now" column shows when a switch is forced off this way.

## What each switch stops, and what customers see
| Switch | Stops | Message (fixed in code) |
|---|---|---|
| `card_payments` | `POST /api/payments/initialize`, `POST /api/payments/charge-saved-card` | "Card payments are paused for a few minutes. Nothing has been charged, and your cart is saved. Please try again shortly." |
| `new_orders` | `POST /api/orders` | "Flash isn't taking new orders right now. Your cart is saved. Please try again a little later." |
| `cash_orders` | `POST /api/payments/cash-on-delivery` | "Cash isn't available right now. Please pay the delivery fee by card." |
| `driver_payouts` | `PayoutService.processRequestedPayout` itself (so the L3 nightly transfer and any future caller); driver withdrawals are permanently refused anyway (FI-086) | "Payouts are paused for now. Your earnings are safe and will be paid when payouts resume." |
| `store_portal_writes` | Every store-portal write to inventory, staff and banking | "Store settings are read-only for a few minutes while we do maintenance. Orders still work as normal." |
| `signups` | `POST /api/auth/user/register`, `POST /api/auth/driver/register`, `POST /api/store-onboarding/apply`, and **new** accounts through Google/Apple sign-in (existing accounts still sign in) | "New sign-ups are paused right now. Please try again later." |
| `premium` | `POST /api/subscriptions/premium/purchase`, `…/purchase-with-card` | "This feature isn't available yet." |
| `boosts` | `POST /api/boost/purchase`, `POST /api/boost/promotions` | "This feature isn't available yet." |

**How a refusal looks:** `503`, with `Retry-After: 300` and `{"error": "<message>", "code": "FEATURE_OFF", "feature": "<key>"}`. Today's apps show the `error` text in their alert.

## Never blocked by any switch
These keep working even with every switch off, because blocking them would strand money or trigger auto-cancels and refunds:
- Paystack **webhooks**;
- payment **verification**;
- **reconciliation**;
- **refunds**;
- **cash OTP** (send, read, confirm, fail);
- **cancellations**;
- **store order handling** (accept, reject, mark ready);
- driver status updates on orders in progress;
- login and token refresh.

`tests/unit/featureSwitchGuards.test.js` proves both lists on the real Express app.

## If the database can't be read
- **The last known values are kept**, and the read is retried 15 s later.
- **On a cold start with no value,** money-moving switches **fail closed** (`driver_payouts`, `premium`, `boosts`) and the rest **fail open**, so customers can still order.

## For developers
- **Guarding a route:** `requireFeature('<key>')` from `middleware/requireFeature.js`, placed after auth. Add the route to the tables above and to `GUARDED` in `featureSwitchGuards.test.js`.
- **Never** put it on anything in the never-blocked list.
- **A new switch key needs a migration:** the table's CHECK allows exactly these 8 keys.
