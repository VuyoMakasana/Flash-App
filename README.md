# Flash — Same-Day Clothing Delivery Platform

Flash is a complete two-sided delivery marketplace built for South Africa.
Customers order clothing from local stores and drivers deliver it same-day.

---

## What's in This Repo

| Folder | What it is |
|---|---|
| `backend/` | Node.js/Express API. Handles all business logic, payments, real-time events |
| `flash-user-app/` | React Native customer app. Browse, order, pay, track, chat with driver |
| `flash-driver-app/` | React Native driver app. Accept orders, navigate, earn, manage subscriptions |
| `docker-compose.yml` | Starts Postgres + Redis + Backend with one command |

---

## Tech Stack

**Backend**
- Node.js + Express — API server
- PostgreSQL — main database (25 tables, 28 indexes)
- Socket.io — real-time driver tracking, order updates, in-app chat
- Redis — Socket.io adapter for multi-server scaling (optional)
- Paystack — card payments, ZAR native, no Stripe needed
- AWS S3 — driver KYC document storage
- node-cron — daily cleanup of old location history

**Apps**
- React Native + Expo — iOS and Android from one codebase
- expo-location — GPS for driver tracking
- react-native-maps + Google Maps — live driver map on tracking screen
- Socket.io client — real-time connection to backend

---

## Features

**Customer App**
- Browse products by category with AI size recommendations
- Pick a specific driver or use Flash Fleet auto-assignment
- Real-time driver tracking on a live map
- Arrival notifications at 15, 10, 5, 2 minutes and "Driver has arrived"
- In-app messaging with the driver
- Trusted driver system — save and request your preferred drivers
- Cash on delivery or card via Paystack (Visa, Mastercard, Capitec Pay, EFT)
- Order history, returns, and store credits
- Social Feed with shoppable posts

**Driver App**
- Real-time new order notifications with sound/vibration
- Accept orders (atomic — prevents two drivers claiming the same order)
- Status updates: assigned → en route → picked up → delivered
- In-app chat with the customer
- Trust request notifications (accept/decline)
- Earnings tracking and subscription plan management
- KYC document upload during onboarding

**Backend**
- JWT authentication with role-based access (user / driver / admin)
- bcrypt password hashing (cost factor 12)
- Rate limiting (100 req/15min general, 10 req/15min on auth)
- Paginated order history (20 per page by default)
- Driver location write throttle (writes history every 5th ping, ~every 15s)
- Haversine arrival distance calculations
- Fleet intelligence — clusters browsing events to direct drivers to demand zones
- Graceful shutdown — drains DB connections on SIGTERM
- Daily cron cleanup — prunes location history (30 days) and browsing events (60 days)

---

## Quick Start

```bash
# 1. Copy backend/.env.example to backend/.env and fill in your secrets

# 2. Start Docker Desktop + backend stack from the repo root
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-docker.ps1 -RunMigrations

# 3. Start the user app
cd flash-user-app
npm install
npx expo start --clear

# 4. Start the driver app
cd ../flash-driver-app
npm install
npx expo start --clear --port 8082
```

See `HOW_TO_RUN.md` for the complete step-by-step setup guide.

### One Command Start (Backend + Both Apps)

```powershell
# Docker backend + user app + driver app
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-dev.ps1

# Optional: mock backend + user app + driver app
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-dev.ps1 -UseMockBackend
```

Note: The starter uses `8081` for the user app and `8084` for the driver app by default to avoid port collisions.

### Docker-First Local Stack

- Docker now runs the backend, Postgres, and Redis together through `docker compose`.
- `scripts/ensure-docker.ps1` starts Docker Desktop if needed, waits for the daemon, and brings the stack up safely.
- `scripts/enable-docker-desktop-autostart.ps1` adds Docker Desktop to the current Windows user's sign-in startup so Docker comes back automatically after a reboot.
- The Expo apps are not containerized. They connect to the Dockerized backend through `EXPO_PUBLIC_API_BASE_URL`, so you do not need to edit the app source files every time your IP changes.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in all required variables:

| Variable | Required | Purpose | Get it from |
|---|---|---|---|
| `DATABASE_URL` | ✓ | PostgreSQL connection string | Your Postgres server |
| `JWT_SECRET` | ✓ | Secret key for JWT tokens (use 64-char random string) | Generate with `openssl rand -hex 32` |
| `PAYSTACK_SECRET_KEY` | ✓ | Paystack live secret key | dashboard.paystack.com → Settings → API Keys (sk_live_...) |
| `PAYSTACK_PUBLIC_KEY` | ✓ | Paystack live public key | dashboard.paystack.com → Settings → API Keys (pk_live_...) |
| `ADMIN_EMAIL` | ✓ | Admin portal login email | Your choice |
| `ADMIN_PASSWORD_HASH` | ✓ | Bcrypt hash of admin password | Generate: `node -e "require('bcryptjs').hash('yourPassword',12).then(console.log)"` |
| `APP_URL` | ✓ | Production server URL for callbacks | Your production domain (https://...) |
| `PAYFLEX_WEBHOOK_SECRET` | ✓ | Payflex webhook secret | Payflex dashboard → Integrations → Webhook Settings |
| `GOOGLE_MAPS_API_KEY` | Optional | Backend maps API key | console.cloud.google.com → APIs & Services |
| `AWS_ACCESS_KEY_ID` | Optional | AWS IAM access key for S3 uploads | AWS IAM Console |
| `AWS_SECRET_ACCESS_KEY` | Optional | AWS IAM secret key for S3 uploads | AWS IAM Console |
| `REDIS_URL` | Optional | Redis connection (for scaling Socket.io and multi-instance) | Upstash.com or Redis Cloud — set to `disabled` to skip |
| `SENTRY_DSN` | Optional | Sentry error reporting DSN | sentry.io → New Project → Node.js → DSN |
| `DB_POOL_MAX` | Optional | Max PostgreSQL connections per process. Default: 50 | Raise if you see pool timeout errors |
| `NODE_ENV` | Optional | Environment (development/production) | Default: development |
| `SENTRY_DSN` | Optional | Sentry error monitoring DSN | sentry.io → New Project → Node.js → DSN |
| `DB_POOL_MAX` | Optional | Max PostgreSQL connections per process. Default: 50 | Raise if you see pool timeout errors |

**For client apps**, set this environment variable before running:
- `EXPO_PUBLIC_API_BASE_URL` — production server URL (https://...) used by both apps

---

## Payment Flow

Flash uses **Paystack** — a South African payment gateway that supports ZAR natively.

1. User taps Pay → app calls `/api/payments/initialize`
2. Backend initializes a Paystack transaction → gets secure URL
3. App opens the URL → user pays on Paystack's secure page
4. Paystack fires a webhook to `/api/webhooks/paystack`
5. Backend verifies signature → marks order as paid → notifies driver pool via Socket.io

Card details never pass through the app or backend. Paystack handles PCI compliance.

---

## Production Launch Fixes (fix/production-launch-fixes)

## Production Launch Fixes v2 (fix/production-launch-fixes-v2)

All 9 critical blockers have been fixed and are ready for production:

| # | Fix | Files Modified |
|---|---|---|
| **FIX 1** | Replaced hardcoded LAN IP (100.66.43.71) with production server URL | `flash-user-app/services/api.js`, `flash-driver-app/services/api.js` |
| **FIX 2** | Added real Google Maps API keys for iOS and Android | `flash-user-app/app.json`, `flash-driver-app/app.json` |
| **FIX 3** | Renamed `requested_driver_id` → `preferred_driver_id` for trusted driver matching | `flash-user-app/context/FlashContext.js` |
| **FIX 4** | Replaced `en_route` status with `driver_arrived_store` and `in_transit` to match backend state machine | `flash-user-app/screens/OrderStatusScreen.js`, `TrackingScreen.js`, `OrdersScreen.js` |
| **FIX 5** | Added cash OTP UI for driver dashboard to complete cash orders | `flash-driver-app/app/driver/dashboard.js`, `services/api.js` |
| **FIX 6** | Added Expo push notifications to alert drivers of new orders when backgrounded | `flash-driver-app/context/DriverContext.js`, `backend/src/controllers/driverController.js`, `backend/src/routes/driverRoutes.js`, new `backend/src/services/pushNotificationService.js`, updated `migrate.js` |
| **FIX 7** | Replaced simulated payout with real Paystack Transfer API for bank transfers | `backend/src/services/paystackService.js`, `backend/src/services/payoutService.js` (full rewrite), `backend/src/db/migrate.js` |
| **FIX 8** | Updated environment variables and added Payflex webhook idempotency | `backend/.env`, `backend/src/controllers/webhookController.js` |
| **FIX 9** | Added 25% cancellation penalty when user cancels after driver is already assigned | `backend/src/controllers/orderController.js`, `backend/src/db/migrate.js` |

All fixes include inline comments (// FIX [number]: ...) explaining what changed and why.

### New Columns Added to Database

The migration script automatically adds these on first run:
- `drivers.push_token` — stores Expo push token per device for background notifications
- `drivers.paystack_recipient_code` — stores Paystack recipient code for bank transfers
- `users.push_token` — stores Expo push token for user notifications
- `orders.cancellation_penalty` — stores the penalty amount charged when a user cancels after driver is assigned

### Required Environment Variables

Before deploying, set these in `backend/.env`:
- `JWT_SECRET` — strong 64-character random string (not the placeholder)
- `PAYSTACK_SECRET_KEY` — real live Paystack secret key (sk_live_...)
- `PAYFLEX_WEBHOOK_SECRET` — real Payflex webhook secret from dashboard
- `ADMIN_PASSWORD_HASH` — bcrypt hash of your admin password
- `APP_URL` — production server URL for payment callbacks (https://...)
- `EXPO_PUBLIC_API_BASE_URL` — production server URL for both Expo apps

### App Build Requirements

**Before submitting to App Store / Play Store:**
- Both `app.json` files have real, restricted Google Maps API keys
- `flash-user-app/services/api.js` points to production server URL (or uses env var)
- `flash-driver-app/services/api.js` points to production server URL (or uses env var)
- Backend has finished initial migration (tables and columns created)
- Paystack live keys are set in `backend/.env`

---

## Order Status Lifecycle

```
created → payment_pending → paid → driver_assigned → driver_arrived_store → picked_up → in_transit → delivered → completed
```

Each status change is pushed in real-time via Socket.io to the user's app.

---

## Database Tables

| Table | Purpose |
|---|---|
| `users` | Customer accounts |
| `drivers` | Driver accounts and vehicle info |
| `driver_documents` | KYC documents (ID, license, etc.) |
| `orders` | All orders |
| `order_items` | Line items within each order |
| `payments` | Payment records |
| `saved_cards` | Paystack authorization codes for repeat payments |
| `driver_subscriptions` | Driver delivery plans |
| `premium_subscriptions` | Flash Premium user subscriptions |
| `driver_locations` | Location history (pruned after 30 days) |
| `messages` | In-app chat messages per order |
| `trusted_drivers` | User ↔ driver trust relationships |
| `size_profiles` | User body measurements for size recommendations |
| `brand_size_mappings` | Store size chart data |
| `flash_inventory` | Products in the Flash Closet |
| `browsing_events` | Product view events for fleet intelligence |
| `feed_posts` | Social feed posts |
| `feed_post_products` | Products tagged in feed posts |
| `feed_likes` | Post likes |
| `feed_comments` | Post comments |
| `store_boosts` | Paid store promotion slots |
| `store_promotions` | Store discount campaigns |
| `store_credits` | Customer store credit balances |
| `return_requests` | Return and refund requests |

---

## Deployment

Recommended: **Render** (has Cape Town region, low latency for SA users)

1. Push to GitHub
2. Render → New Web Service → connect repo → set root dir to `backend`
3. Build: `npm install` / Start: `node server.js`
4. Add a Render Postgres database, copy the internal URL to `DATABASE_URL`
5. Add all `.env` variables in Render's environment settings
6. After first deploy, open Render Shell and run `node src/db/migrate.js`

For the apps: build with `eas build` (Expo Application Services) for Play Store and App Store.

---

## Contributing / Understanding the Code

Every file has comments explaining what it does. Start here:
- `backend/server.js` — thin backend entrypoint used by npm start and Docker
- `backend/src/server.js` — server startup, middleware, routes, cron jobs
- `backend/src/routes/payments.js` — Paystack payment flow with inline comments
- `backend/src/socket/socketServer.js` — all real-time events documented
- `flash-user-app/context/FlashContext.js` — global state, product loading, order creation
- `HOW_TO_RUN.md` — complete API reference, Socket.io event reference, setup guides
- `HOW_TO_RUN.md` — complete API reference, Socket.io event reference, setup guides

---

## Production Hardening v3 (feature/production-hardening-v3)

13 production hardening changes landed in this release:

| # | Change | Files |
|---|---|---|
| **1A** | Fixed cash OTP endpoints returning 404 (wrong URL paths in driver API client) | `flash-driver-app/services/api.js` |
| **1B** | Stripped customer address and identity from pre-accept order list — drivers now only see pickup and payout info | `backend/src/models/Driver.js` |
| **1C** | Replaced fake support phone number placeholder in TrackingScreen | `flash-user-app/screens/TrackingScreen.js` |
| **2** | Added full driver bank account setup screen (search banks, verify account, save for payouts) | `flash-driver-app/app/driver/bank.js`, `_layout.js`, `dashboard.js`, `earnings.js` |
| **3** | Added stuck order auto-reassignment cron (runs every 10 min, cancels orders stuck >45 min) and auto-suspends drivers after 5 cumulative cancellations | `backend/src/server.js`, `migrate.js`, `middleware/auth.js` |
| **4** | Added PM2 process management for zero-downtime restarts and automatic crash recovery | `backend/ecosystem.config.js`, `backend/package.json` |
| **5** | Added Sentry error monitoring to backend, user app, and driver app | `backend/src/server.js`, `flash-user-app/App.js`, `flash-driver-app/app/_layout.js` |
| **6** | Added Paystack balance check before every driver payout transfer — prevents failed transfers | `backend/src/services/paystackService.js`, `payoutService.js` |
| **7** | Added refund status banner in OrderStatusScreen with 5–10 business day timeline | `flash-user-app/screens/OrderStatusScreen.js` |
| **8** | Added POPIA-compliant Privacy Policy screen (9 sections) and fixed Terms contradicting actual refund logic | `flash-user-app/screens/PrivacyPolicyScreen.js`, `App.js`, `ProfileScreen.js`, `TermsAndConditionsScreen.js` |
| **9** | Enforced private-only S3 document uploads and added signed URL helper for secure document access | `backend/src/services/s3Service.js` |
| **10** | Increased DB connection pool max from 20 → 50 and activated Redis Socket.IO adapter when `REDIS_URL` is set | `backend/src/config/database.js`, `backend/src/server.js` |
| **11** | Updated README and HOW_TO_RUN with all new operations, driver onboarding, and production startup docs | `README.md`, `HOW_TO_RUN.md` |

### New Database Columns (v5 migration — runs automatically)

| Column | Table | Purpose |
|---|---|---|
| `cancel_count` | `drivers` | Cumulative stuck-order cancellation count (auto-suspend at 5) |
| `suspended_at` | `drivers` | Timestamp when account was auto-suspended |
| `suspension_reason` | `drivers` | Human-readable reason for suspension |

### Process Management (PM2)

The backend is now managed by PM2. In production, use these commands instead of `node server.js`:

```bash
cd backend
npm run start:prod    # start with PM2 (autorestart, 500MB memory limit, logs to ./logs/)
npm run stop:prod     # stop all PM2 processes
npm run logs          # tail live logs
# or directly:
pm2 logs flash-backend
pm2 status
```

### Driver Onboarding Requirement

Drivers **must** set up a bank account before they can receive payouts. After registering and getting approved:
1. Log in to the driver app
2. Tap **Bank** on the Dashboard quick actions bar
3. Search for their bank, enter their account number, verify, and save
4. Paystack creates a transfer recipient — all future earnings are paid to this account

### Operations Notes

- **Stuck order cron:** Runs every 10 minutes. An order is "stuck" if it has been `paid`/`driver_assigned`/`driver_arrived_store`/`picked_up` for more than 45 minutes without a status update. The responsible driver's `cancel_count` is incremented and the order is returned to the driver pool for reassignment.
- **Auto-suspension:** A driver is automatically suspended when `cancel_count` reaches 5. They receive a `403` on every API call with a message to contact support. An admin can unsuspend by resetting `status = 'approved'` and `cancel_count = 0` in the database.
- **S3 documents:** All driver KYC documents are uploaded with private ACL. Use `s3Service.getSignedUrl(key)` (300-second expiry by default) to generate temporary access URLs for admin document review.

### Legal / POPIA

A full Privacy Policy screen is accessible in the user app at **Profile → Privacy Policy**. It covers data collection, purpose, retention periods, user rights, and contact details. The Terms & Conditions refund clause has been updated to reflect the actual tiered refund policy (full refund before driver assigned; no refund once picked up; 5–10 business days processing time).
