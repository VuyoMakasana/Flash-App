# Making the app match the live Terms, Returns and Privacy pages

**Who this is for:** the founder, deciding the order of work; and the developer building each PR.

**Source:** the pages live on flashdelivery.co.za (`/terms`, `/privacy`), read 2026-11-27. Founder decision, 2026-11-27: the app must match them. Each PR follows the usual process (issue → failing test → fix → CI → PR → founder merges). **Any schema change goes through `docs/PROD_MIGRATIONS.md` (standalone file, backup, rehearsal, founder applies), never `migrate.js`.**

| PR | What | Migration? | Main files | Tests |
|---|---|---|---|---|
| **G1** (#106, this PR) | **Money correctness:** the Terms A9 cancellation charge, Flash-side cancellations always in full, and an admin full or partial refund (audit H7) | **No** (existing columns: `order_cancellations`, `payment_refunds.reason`, `admin_actions`) | `controllers/orderController.js`, `services/refundService.js`, `adminPanel.js`, `adminComponents/RefundOrder.jsx`, `flash-user-app/screens/CancelOrderScreen.js` | Unit tests for every cancellation stage and the admin refund; real-database integration test for partial and full admin refunds |
| **G2** | **Returns (Part B):** see the list below this table | **Yes (v46):** `return_requests.return_type` (`change_of_mind`, `wrong_item`, `damaged`, `faulty`), `claim_details`, `delivered_at` snapshot | `models/Return.js`, `controllers/returnController.js`, `services/pricingService.js` (fee), user-app return screens, admin return review | Unit tests per type and window edge (6 d 23 h, 7 d, 6 months); fee preview equals fee charged; integration test on real DB |
| **G3** | **Terms and Privacy acceptance:** see the list below this table | **Yes (v46 or v47):** `terms_version` (and `privacy_version`) on `users` and `drivers`. `terms_accepted` / `terms_accepted_at` already exist on both | `controllers/authController.js` / user and driver routes, `models/User.js`, `models/Driver.js`, both apps' sign-up and checkout screens | Order refused without current acceptance; acceptance recorded with version and time; a version bump asks again |
| **G4** | **Admin MFA** (PR 3 of `docs/ADMIN_MFA_DESIGN.md`) | **No:** v45 (`admin_totp`) is already applied | `adminPanel.js` auth, a TOTP service, admin login screens | As specified in the design |
| **F** | **Apple sign-in token revocation on account deletion** (App Store 5.1.1(v)): see the list below this table | **Yes:** an encrypted `apple_refresh_token` on `users` and `drivers` | `services/appleAuthService.js`, `authController.js` Apple paths, both `deleteAccount` paths | Code exchange and revoke calls mocked; deletion still succeeds if Apple is unreachable (retry queued, logged) |

**G2 in detail:**
- **Open from delivery:** today returns open only 48 hours after delivery and never close (audit B-17).
- **Change of mind:** closes 7 days after delivery.
- **Faulty items:** claims up to 6 months, reviewed by an admin.
- **Collection fee:** distance-based, the same calculation as delivery, shown before the customer confirms (today it's a flat R100).
- **No fee for wrong, damaged or faulty items.**
- **Delivery fee:** not refunded on change of mind.

**G3 in detail:**
- **Customers:** an "I agree to the Terms and Privacy Policy" tick box before their first order.
- **Drivers:** the same tick box at sign-up.
- **What's recorded:** the version and the date.
- **Version source:** the current version lives in one backend constant, so a new version asks again.

**F in detail:**
- **At sign-in:** exchange Apple's authorization code for a refresh token, and store it encrypted (`utils/paymentCrypto`-style).
- **On account deletion:** call Apple's revoke endpoint.
- **Needs from the founder (approval):** an Apple Sign in with Apple **private key (.p8)**, its Key ID and the Team ID as **new Render secrets**, to sign the client secret. This is an environment-variable change, so the founder makes it.

**Order:** G1 (money) → G3 (consent, before public launch) → G2 (returns, **before real customer deliveries start**: the Terms open returns at delivery, while today's flow opens them 48 hours later with a flat R100 fee, so it contradicts the Terms from the first delivery) → F (before App Store submission) → G4 (before more admins are added).
