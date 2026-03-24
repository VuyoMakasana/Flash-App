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
# 1. Set up the backend
cd backend
cp .env.example .env
# Edit .env — add your Paystack keys at minimum
npm install
node src/db/migrate.js

# 2. Start the backend
node src/server.js
# (or: node mock-server.js for dev without a database)

# 3. Start the user app
cd ../flash-user-app
npm install
npx expo start --clear

# 4. Start the driver app
cd ../flash-driver-app
npm install
npx expo start --clear --port 8082
```

See `HOW_TO_RUN.md` for the complete step-by-step setup guide.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Required | Get it from |
|---|---|---|
| `DATABASE_URL` | Your PostgreSQL connection string |
| `JWT_SECRET` | Any long random string |
| `PAYSTACK_SECRET_KEY` | (payments) | dashboard.paystack.com → Settings → API Keys |
| `PAYSTACK_PUBLIC_KEY` | (payments) | dashboard.paystack.com → Settings → API Keys |
| `ADMIN_EMAIL` | Your admin login email |
| `ADMIN_PASSWORD` | Your admin login password |
| `GOOGLE_MAPS_API_KEY` | For maps | console.cloud.google.com |
| `AWS_ACCESS_KEY_ID` | For doc uploads | AWS IAM Console |
| `REDIS_URL` | For scaling | Upstash.com or Redis Cloud |

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

## Order Status Lifecycle

```
created → payment_pending → paid → driver_assigned → en_route → picked_up → delivered → completed
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
3. Build: `npm install` / Start: `node src/server.js`
4. Add a Render Postgres database, copy the internal URL to `DATABASE_URL`
5. Add all `.env` variables in Render's environment settings
6. After first deploy, open Render Shell and run `node src/db/migrate.js`

For the apps: build with `eas build` (Expo Application Services) for Play Store and App Store.

---

## Contributing / Understanding the Code

Every file has comments explaining what it does. Start here:
- `backend/src/server.js` — server startup, middleware, routes, cron jobs
- `backend/src/routes/payments.js` — Paystack payment flow with inline comments
- `backend/src/socket/socketServer.js` — all real-time events documented
- `flash-user-app/context/FlashContext.js` — global state, product loading, order creation
- `HOW_TO_RUN.md` — complete API reference, Socket.io event reference, setup guides
