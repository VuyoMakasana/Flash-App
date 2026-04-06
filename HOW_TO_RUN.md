# Flash — How to Run

This is the complete guide for running, testing, and deploying the Flash platform.
Read this from top to bottom the first time. After that you only need the "Daily Dev" section.

---

## What Flash Is

Flash is a same-day clothing delivery platform built for South Africa.
It has three parts that all work together:

| Part | What it does | Technology |
|---|---|---|
| `backend/` | The API server — handles all data, payments, real-time events | Node.js, Express, PostgreSQL, Socket.io |
| `flash-user-app/` | The customer app — browse, order, track, chat | React Native, Expo |
| `flash-driver-app/` | The driver app — accept orders, navigate, earn | React Native, Expo Router |

---

## Project Structure

```
Flash/
├── backend/
│   ├── server.js                ← Thin backend entry point used by npm start and Docker.
│   ├── src/
│   │   ├── server.js            ← Server startup. Starts Express, Socket.io,
│   │   │                           Redis adapter, and cron jobs.
│   │   ├── db/
│   │   │   ├── pool.js           ← PostgreSQL connection pool (size set by DB_POOL_MAX)
│   │   │   └── migrate.js        ← Creates all 25 database tables and 28 indexes.
│   │   │                           Run once on first setup, safe to re-run anytime.
│   │   ├── middleware/
│   │   │   └── auth.js           ← JWT verification. Attaches userId and userRole
│   │   │                           to every authenticated request.
│   │   ├── routes/
│   │   │   ├── auth.js           ← POST /api/auth/user/register, /login
│   │   │   │                        POST /api/auth/driver/register, /login
│   │   │   ├── users.js          ← GET/PUT /api/users/me (profile)
│   │   │   ├── drivers.js        ← Driver location updates, available orders,
│   │   │   │                        order acceptance, nearby drivers endpoint.
│   │   │   │                        Location writes throttled to every 5th ping
│   │   │   │                        to reduce DB load under heavy usage.
│   │   │   ├── orders.js         ← Create orders, get order history (paginated),
│   │   │   │                        get single order, update order status.
│   │   │   ├── payments.js       ← Paystack payment initialization and verification,
│   │   │   │                        cash on delivery, Payflex BNPL, saved cards.
│   │   │   │                        Uses Paystack REST API directly (no SDK needed).
│   │   │   ├── webhooks.js       ← Receives events from Paystack after payment.
│   │   │   │                        Verifies HMAC-SHA512 signature before trusting body.
│   │   │   │                        Marks orders as paid, saves card authorizations,
│   │   │   │                        notifies drivers via Socket.io.
│   │   │   ├── messages.js       ← In-app chat between user and driver.
│   │   │   │                        Real-time via Socket.io, history stored in DB.
│   │   │   ├── trustedDrivers.js ← Users save preferred drivers. Drivers accept/decline.
│   │   │   ├── sizing.js         ← Size profile, measurement guide, size recommendations.
│   │   │   │                        Never crashes — always returns a safe fallback.
│   │   │   ├── tracking.js       ← REST fallback for driver location polling.
│   │   │   ├── admin.js          ← Driver approval, stats, order overview.
│   │   │   │                        Protected by bcrypt admin password hash.
│   │   │   ├── subscriptions.js  ← Driver plans (daily/weekly/monthly/quarterly).
│   │   │   │                        Flash Premium for users (R99/month).
│   │   │   ├── feed.js           ← Social feed with shoppable posts.
│   │   │   ├── inventory.js      ← Products for the Flash Closet store.
│   │   │   ├── boost.js          ← Store promotions and boost campaigns.
│   │   │   ├── trends.js         ← Browsing event tracking for fleet intelligence.
│   │   │   ├── returns.js        ← Return requests and store credit.
│   │   │   └── fleet.js          ← Fleet intelligence — clusters browsing events
│   │   │                            to tell drivers where demand is highest.
│   │   └── socket/
│   │       └── socketServer.js   ← All Socket.io event handlers.
│   │                                Handles: driver location, order updates, chat,
│   │                                arrival notifications, trust requests, feed likes.
│   ├── mock-server.js            ← Standalone dev server. Returns fake data for
│   │                                every endpoint. Use this when you don't have
│   │                                PostgreSQL set up yet.
│   ├── .env                      ← Your real secrets (never commit this to git)
│   ├── .env.example              ← Template — copy to .env and fill in values
│   ├── package.json              ← Backend dependencies
│   └── Dockerfile                ← For Docker and production deployment
│
├── flash-user-app/
│   ├── App.js                    ← Navigation setup. Registers all screens.
│   │                                Tabs: Shop, Feed, Orders, Profile.
│   ├── context/
│   │   └── FlashContext.js       ← Global state for the user app.
│   │                                Holds: user, cart, orders, products.
│   │                                Fetches products from /api/inventory on startup.
│   │                                Falls back to 8 demo products if API is offline.
│   ├── services/
│   │   └── api.js                ← All API calls in one place.
│   │                                Change BASE_URL here to point to your backend.
│   └── screens/
│       ├── HomeScreen.js         ← Product grid with category filtering
│       ├── ProductScreen.js      ← Product detail with size recommendation
│       ├── CartScreen.js         ← Cart with quantity controls
│       ├── CheckoutScreen.js     ← Delivery mode, driver picker (real drivers from API),
│       │                            time slot, order summary. Shows busy status on drivers.
│       ├── PaymentScreen.js      ← Payment method selection.
│       │                            Card → opens Paystack secure payment page in browser.
│       │                            Cash → confirms immediately.
│       │                            Payflex → opens Payflex BNPL checkout.
│       ├── OrderStatusScreen.js  ← Shows order progress. Handles both {order} object
│       │                            and {orderId} string — fetches order if only ID passed.
│       ├── TrackingScreen.js     ← Live map with driver marker. Arrival notification
│       │                            banners (15/10/5/2min + arrived). Cash reminder.
│       │                            Call button (opens dialler). Message button (opens chat).
│       ├── ChatScreen.js         ← Real-time iMessage-style chat with driver.
│       │                            Optimistic UI — message appears instantly before server confirms.
│       ├── OrdersScreen.js       ← Order history (paginated, 20 per page)
│       ├── ProfileScreen.js      ← Profile, saved cards, sizing, trusted drivers
│       ├── SavedCardsScreen.js   ← Cards saved automatically after first Paystack payment.
│       │                            Delete cards, set default for recurring charges.
│       ├── SizingScreen.js       ← Body measurements with how-to-measure modal per field.
│       │                            SA size charts for shirt, jeans, shoes.
│       ├── TrustedDriversScreen.js ← Manage trusted drivers. Shows online/busy status.
│       ├── FeedScreen.js         ← Social feed with shoppable product tags
│       ├── LoginScreen.js        ← Email/password login
│       ├── SignUpScreen.js       ← Registration with phone number
│       ├── SplashScreen.js       ← Loading/branding screen
│       └── TermsAndConditionsScreen.js
│
├── flash-driver-app/
│   ├── services/
│   │   └── api.js                ← All driver API calls. Change BASE_URL here.
│   ├── context/
│   │   └── DriverContext.js      ← Global state for the driver app.
│   │                                Holds: driver profile, token, online status.
│   └── app/
│       ├── _layout.js            ← Root layout. Auth guard — redirects to login
│       │                            if no token is found.
│       ├── index.js              ← Entry redirect
│       ├── auth/
│       │   ├── login.js          ← Driver login
│       │   ├── register.js       ← Driver registration (name, email, password,
│       │   │                        vehicle type, plate number)
│       │   └── onboarding.js     ← KYC document upload (ID, license, etc.)
│       │                            Documents sent to S3 via backend.
│       └── driver/
│           ├── dashboard.js      ← Main driver screen. Shows:
│           │                        - Online/offline toggle
│           │                        - Active order with status controls
│           │                        - Available orders list
│           │                        - Trust request notifications (accept/decline)
│           │                        - Fleet intelligence alerts
│           │                        - Earnings summary
│           ├── earnings.js       ← Earnings history and subscription status
│           ├── profile.js        ← Driver profile management
│           └── subscription.js   ← Buy daily/weekly/monthly delivery plans
│
├── docker-compose.yml            ← Starts Postgres + Redis + Backend together
├── scripts/
│   └── start-all-dev.ps1         ← One-command startup for backend + both Expo apps
└── HOW_TO_RUN.md                 ← This file
```

---

## First Time Setup (Step by Step)

### Step 1 — Install tools you need

Make sure you have these installed on your computer:
- **Node.js 20+** — download from nodejs.org
- **Git** — download from git-scm.com
- **Expo Go app** — install on your phone from the App Store or Play Store
- **PostgreSQL** (only if not using Docker) — download from postgresql.org

To check if Node.js is installed, open a terminal and run:
```bash
node --version
```
You should see something like `v20.x.x`.

---

### Step 2 — Set your API base URL for Expo

Your phone and your computer need to be on the same WiFi network.

Find your computer's IP address:
- **Windows:** Open Command Prompt → type `ipconfig` → look for "IPv4 Address" (looks like `192.168.x.x`)
- **Mac:** Open Terminal → type `ifconfig | grep "inet "` → look for a `192.168.x.x` address

Set the API base URL in the shell before starting Expo so you do not have to edit source files:

**PowerShell (Windows):**
```powershell
$env:EXPO_PUBLIC_API_BASE_URL = "http://192.168.1.5:3000"
```

**bash/zsh (macOS/Linux):**
```bash
export EXPO_PUBLIC_API_BASE_URL="http://192.168.1.5:3000"
```

Both apps already read `EXPO_PUBLIC_API_BASE_URL` automatically.

---

### Step 3 — Set up the backend

Copy the environment file template:
```bash
cd backend
cp .env.example .env
```

Open `backend/.env` and at minimum fill in:
- `JWT_SECRET` — change to any long random string
- `PAYSTACK_SECRET_KEY` — from dashboard.paystack.com (use sk_test_ for now)
- `ADMIN_EMAIL` and `ADMIN_PASSWORD` — your admin login

Everything else can stay as placeholder during development.

**For production**, also set:
- `PAYSTACK_SECRET_KEY` — use sk_live_ key (not sk_test_)
- `ADMIN_PASSWORD_HASH` — bcrypt hash (generate: `node -e "require('bcryptjs').hash('yourPassword',12).then(console.log)"`)
- `JWT_SECRET` — strong 64-character random string
- `PAYFLEX_WEBHOOK_SECRET` — real secret from Payflex dashboard (if using BNPL)
- `APP_URL` — production server URL (https://examples.com)

Install backend dependencies:
```bash
npm install
# For push notifications (FIX 6), also install:
npm install expo-server-sdk
```

---

### Step 4 — Start the database

**Option A — Using Docker (easiest, recommended):**
```bash
# One-time on Windows: make Docker Desktop launch when you sign in
powershell -ExecutionPolicy Bypass -File .\scripts\enable-docker-desktop-autostart.ps1

# From the root Flash folder
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-docker.ps1
```
This starts Docker Desktop if needed, waits for the daemon, then brings up Postgres, Redis, and the backend API.

**Option B — Using a local PostgreSQL installation:**
Make sure PostgreSQL is running, then create the database:
```bash
psql -U postgres
CREATE USER flash_user WITH PASSWORD 'flash_password';
CREATE DATABASE flash_db OWNER flash_user;
\q
```

---

### Step 5 — Create all database tables

This only needs to run once. It is safe to run again — it uses `CREATE TABLE IF NOT EXISTS` so it never destroys existing data:

**If you are using Docker:**
```bash
docker compose exec backend npm run migrate
```

**If you are running PostgreSQL locally:**
```bash
cd backend
node src/db/migrate.js
```
You should see: `Flash database migration v3 completed successfully`

---

### Step 6 — Run everything

Open 3 separate terminal windows:

**Terminal 1 — Backend (Docker):**
```bash
docker compose logs -f backend
```

**Terminal 1 — Backend (without Docker):**
```bash
cd backend
node mock-server.js       # ← use this for dev (no real DB needed)
# OR
node server.js            # ← use this when you have PostgreSQL running
```
You should see: ` Flash Backend v3.0 on port 3000`

**Terminal 2 — User App:**
```bash
$env:EXPO_PUBLIC_API_BASE_URL="http://YOUR-COMPUTER-IP:3000"
cd flash-user-app
npm install               # only needed first time
npx expo start --clear
```
Scan the QR code with Expo Go on your phone.

**Before building for production:**
- Set `EXPO_PUBLIC_API_BASE_URL` to your production server URL (https://...)
- Verify `app.json` has real Google Maps API keys (not placeholders), restricted to your app's bundle ID

**Terminal 3 — Driver App:**
```bash
$env:EXPO_PUBLIC_API_BASE_URL="http://YOUR-COMPUTER-IP:3000"
cd flash-driver-app
npm install               # only needed first time
npx expo install expo-notifications  # Install for push notifications (FIX 6)
npx expo start --clear --port 8082
```
Scan the QR code with Expo Go on your phone (different QR than the user app).

**Before building for production:**
- Set `EXPO_PUBLIC_API_BASE_URL` to your production server URL (https://...)
- Verify `app.json` has real Google Maps API keys (not placeholders), restricted to your app's bundle ID
- Verify the app has permission to request push notification permission on first login

---

## Quick One-Command Startup

From the project root:

```powershell
# Starts backend + user app + driver app in separate PowerShell windows
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-dev.ps1

# Optional: use mock backend instead of docker backend
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-dev.ps1 -UseMockBackend
```

Comment/Note: the script defaults to `8081` for the user app and `8084` for the driver app to reduce Expo port conflicts.

---

## Daily Development (after first setup)

Once set up, you only need to run:
```bash
# Terminal 1
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-docker.ps1 -SkipBuild

# Terminal 2
$env:EXPO_PUBLIC_API_BASE_URL="http://YOUR-COMPUTER-IP:3000"
cd flash-user-app && npx expo start --clear

# Terminal 3
$env:EXPO_PUBLIC_API_BASE_URL="http://YOUR-COMPUTER-IP:3000"
cd flash-driver-app && npx expo start --clear --port 8082
```

---

## Environment Variables — Complete Reference

All variables go in `backend/.env`. The `.env.example` file has all of these with descriptions.

| Variable | Required? | What it does |
|---|---|---|
| `PORT` | Optional | Port the backend runs on. Default: 3000 |
| `NODE_ENV` | Recommended | Set to `production` when deploying |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DB_POOL_MAX` | Optional | Max DB connections. Default: 20. Raise to 50 on paid plans |
| `JWT_SECRET` | Yes | Signs auth tokens. Change before deploying |
| `JWT_EXPIRES_IN` | Optional | How long tokens last. Default: 30d |
| `PAYSTACK_SECRET_KEY` | Yes (for payments) | From dashboard.paystack.com |
| `PAYSTACK_PUBLIC_KEY` | Yes (for payments) | From dashboard.paystack.com |
| `APP_URL` | For payments | Your backend URL. Used in Paystack callback redirects |
| `REDIS_URL` | Optional | Set to redis://... to enable multi-server Socket.io scaling |
| `AWS_ACCESS_KEY_ID` | For doc uploads | AWS credentials for S3 driver document storage |
| `AWS_SECRET_ACCESS_KEY` | For doc uploads | AWS credentials for S3 driver document storage |
| `AWS_REGION` | For doc uploads | Default: af-south-1 (Cape Town) |
| `AWS_S3_BUCKET` | For doc uploads | Name of your S3 bucket |
| `GOOGLE_MAPS_API_KEY` | For maps | Backend distance calculations |
| `ADMIN_EMAIL` | Yes | Admin login email |
| `ADMIN_PASSWORD` | Dev only | Plain text fallback. Use ADMIN_PASSWORD_HASH in production |
| `ADMIN_PASSWORD_HASH` | Production | bcrypt hash. Generate with: `node -e "require('bcryptjs').hash('pass',12).then(console.log)"` |
| `PAYFLEX_API_KEY` | Optional | For Payflex BNPL. Contact payflex.co.za for credentials |

---

## API Endpoints — Complete Reference

### Authentication
```
POST /api/auth/user/register     Register a new customer
POST /api/auth/user/login        Customer login → returns JWT token
POST /api/auth/driver/register   Register a new driver
POST /api/auth/driver/login      Driver login → returns JWT token
POST /api/auth/user/accept-terms Accept T&Cs (required before first order)
```

### Users
```
GET  /api/users/me               Get current user profile
PUT  /api/users/me               Update profile (name, address, phone)
```

### Drivers
```
GET  /api/drivers/me             Get driver profile
PUT  /api/drivers/me             Update driver profile
POST /api/drivers/documents/upload  Upload KYC document (multipart/form-data)
POST /api/drivers/online         Set online/offline status
POST /api/drivers/location       Update GPS location (called every ~3 seconds)
GET  /api/drivers/available-orders  Get unassigned paid orders
POST /api/drivers/orders/:id/accept Accept an order (atomic — prevents double-accept)
GET  /api/drivers/earnings       Earnings history
GET  /api/drivers/nearby         Online drivers near a location (?lat=&lng=)
```

### Orders
```
POST /api/orders                 Create a new order
GET  /api/orders/my-orders       Get order history (paginated: ?page=1&limit=20)
GET  /api/orders/:id             Get a single order with driver info and items
PUT  /api/orders/:id/status      Update order status (driver only)
```

### Payments
```
POST /api/payments/initialize         Start a Paystack card payment
                                       Returns { authorizationUrl, reference }
                                       Open the URL in the browser — Paystack handles card entry
GET  /api/payments/verify/:reference  Verify a payment after Paystack redirect
POST /api/payments/cash-on-delivery   Confirm cash payment option
POST /api/payments/payflex/initiate   Start a Payflex BNPL payment
GET  /api/payments/status/:orderId    Get payment status for an order
GET  /api/payments/cards              Get saved cards for the current user
DELETE /api/payments/cards/:id        Delete a saved card
PATCH  /api/payments/cards/:id/default  Set a card as default
```

### Webhooks (called by Paystack — not by the app)
```
POST /api/webhooks/paystack      Paystack fires this after charge.success or charge.failed
                                  Verifies HMAC-SHA512 signature. Marks order paid.
                                  Saves card authorization for future charges.
POST /api/webhooks/payflex       Payflex fires this after payment approval/decline
```

### Messages (In-App Chat)
```
GET  /api/messages/:orderId      Get chat history for an order
POST /api/messages/:orderId      Send a message to the other party
GET  /api/messages/:orderId/unread  Count of unread messages
```

### Trusted Drivers
```
GET    /api/trusted-drivers                        My accepted trusted drivers (user)
GET    /api/trusted-drivers/pending                Trust requests I have sent (user)
POST   /api/trusted-drivers/:driverId/request      Send a trust request to a driver
DELETE /api/trusted-drivers/:driverId              Remove a trusted driver
GET    /api/trusted-drivers/:driverId/status       Check if driver is available/busy
GET    /api/trusted-drivers/requests               Incoming trust requests (driver)
PATCH  /api/trusted-drivers/:id/respond            Accept or decline a request (driver)
DELETE /api/trusted-drivers/remove-self/:userId    Driver removes themselves from a user's list
```

### Sizing
```
GET  /api/sizing/guide                        Measurement instructions and SA size charts
GET  /api/sizing/profile                      Current user's saved measurements
POST /api/sizing/profile                      Save/update measurements
GET  /api/sizing/recommend/:storeId/:category Size recommendation for a product category
POST /api/sizing/mappings/seed                Add size chart data for a store
```

### Subscriptions
```
GET  /api/subscriptions/driver              Get driver's active subscription plan
POST /api/subscriptions/driver/purchase     Buy a driver plan (daily/weekly/monthly/quarterly)
POST /api/subscriptions/driver/increment    Add +1 to delivery count after completing a delivery
GET  /api/subscriptions/premium             Get user's Flash Premium status
POST /api/subscriptions/premium/purchase    Buy Flash Premium (R99/month)
```

### Admin (requires admin JWT)
```
POST /api/admin/login                        Admin login
GET  /api/admin/drivers                      List all drivers (filter: ?status=documents_submitted)
GET  /api/admin/drivers/:id                  Driver detail with all uploaded documents
PUT  /api/admin/drivers/:id/status           Approve or reject a driver
GET  /api/admin/orders                       Recent 100 orders
GET  /api/admin/stats                        User count, driver count, order count, revenue
```

### Other
```
GET  /api/inventory              Products list (?category= to filter)
GET  /api/inventory/:id          Single product
GET  /api/feed                   Social feed posts (?page=)
POST /api/feed                   Create a post
POST /api/feed/:id/like          Like a post
GET  /api/feed/:id/comments      Post comments
POST /api/feed/:id/comments      Add a comment
GET  /api/boost/active           Active store promotions
GET  /api/fleet/clusters         Demand clusters for fleet intelligence
GET  /api/tracking/order/:id     Driver location for an order (REST fallback)
POST /api/returns/:orderId        Request a return
GET  /api/returns/my             My return requests
GET  /api/returns/credits         My store credits balance
GET  /health                     Server health check
```

---

## Socket.io Events — Complete Reference

The user app and driver app connect to the backend via Socket.io for real-time updates.
Authentication is via the JWT token passed in `socket.handshake.auth.token`.

### Events sent FROM the app TO the server
| Event | Who sends it | Payload | What it does |
|---|---|---|---|
| `track_order` | User | `{ orderId }` | Joins the order room to receive updates |
| `stop_tracking` | User | `{ orderId }` | Leaves the order room |
| `join_driver_pool` | Driver | none | Joins the driver pool to receive new order alerts |
| `leave_driver_pool` | Driver | none | Goes offline from the order pool |
| `join_order_chat` | Driver | `{ orderId }` | Joins the chat room for an active order |
| `driver_location_update` | Driver | `{ lat, lng, orderId }` | Sends live GPS position |
| `driver_status` | Driver | `{ online }` | Broadcasts online/offline change to admin |
| `join_admin` | Admin | none | Joins the admin room for all events |

### Events sent FROM the server TO the app
| Event | Who receives it | Payload | What it means |
|---|---|---|---|
| `driver_location` | User (tracking) | `{ driverId, lat, lng, timestamp }` | Driver moved — update the map marker |
| `order_update` | User | `{ orderId, status }` | Order status changed (assigned, en_route, etc.) |
| `payment_confirmed` | User | `{ orderId }` | Paystack confirmed payment successful |
| `payment_failed` | User | `{ orderId, message }` | Payment failed — show error to user |
| `new_order_available` | Drivers (pool) | `{ orderId, isCashDelivery }` | New paid order ready to be accepted |
| `arrival_update` | User | `{ milestone, message, distanceKm, estimatedMins }` | Driver is 15/10/5/2 min away or arrived |
| `cash_reminder` | User | `{ orderId, message }` | Driver is 5 min away and it's a cash order |
| `new_message` | User + Driver | `{ orderId, message }` | New chat message received |
| `trust_request` | Driver | `{ requestId, userId, message }` | A user wants to add this driver as trusted |
| `trust_response` | User | `{ driverId, status }` | Driver accepted/declined trust request |
| `feed_notification` | User | `{ type, postId, message }` | Someone liked your Feed post |
| `return_credit_issued` | User | `{ returnId, creditAmount }` | Store credit added after return approved |

---

## Payment Flow — How Paystack Works

Flash uses Paystack for all card payments. Here is exactly what happens step by step:

```
1. User taps "Pay R299" in PaymentScreen
2. App calls POST /api/payments/initialize
3. Backend calls Paystack API → gets a secure payment URL
4. Backend saves the reference in the orders table
5. App opens the URL in the phone's browser (Paystack handles card entry securely)
6. User enters card details on Paystack's page (not in our app)
7. Paystack charges the card
8. Paystack sends a webhook POST to /api/webhooks/paystack
9. Backend verifies the HMAC-SHA512 signature to confirm it's really from Paystack
10. Backend marks the order as 'paid'
11. Backend saves the card authorization code (for future charges without redirecting)
12. Backend emits 'payment_confirmed' via Socket.io → user sees order confirmation
13. Backend emits 'new_order_available' to driver_pool → drivers see the new order
```

Card details never pass through your app or backend. Paystack handles PCI compliance.

---

## How to Add Real Stores and Products

Products are stored in the `flash_inventory` table. The app fetches them automatically.

**Add a product via SQL:**
```sql
INSERT INTO flash_inventory (
  product_name, category, brand, price, cost_price,
  sizes, stock_by_size, image_url, description, is_active
) VALUES (
  'Nike Air Max 270',
  'Footwear',
  'Nike',
  2499.00,
  1200.00,
  '["40","41","42","43","44","45"]',
  '{"40":5,"41":8,"42":10,"43":8,"44":5,"45":3}',
  'https://your-cdn.com/airmax.jpg',
  'Max cushioning meets modern style.',
  true
);
```

**Field reference:**
| Field | Example | Notes |
|---|---|---|
| `product_name` | `"Nike Air Max 270"` | Shown in the app |
| `category` | `"Men"` / `"Women"` / `"Sports"` / `"Casual"` / `"Footwear"` | Used for filtering |
| `brand` | `"Nike"` | Shown as a badge |
| `price` | `2499.00` | In Rands |
| `cost_price` | `1200.00` | Not shown to users |
| `sizes` | `["S","M","L","XL"]` | JSON array |
| `stock_by_size` | `{"S":5,"M":10}` | JSON object |
| `image_url` | HTTPS URL | Must be publicly accessible |
| `is_active` | `true` / `false` | Set to false to hide without deleting |

---

## Driver Onboarding Flow

```
1. Driver downloads Flash Driver app
2. Driver registers (name, email, password, vehicle type, plate)
   → status set to 'pending_documents'
3. Driver uploads 5 required documents in the onboarding screen:
   - Government ID or Passport
   - Driver's License
   - Police clearance certificate (stamped at police station)
   - Profile photo
   - Vehicle registration document
   → status set to 'documents_submitted'
4. Admin logs into admin API and reviews the driver
5. Admin approves the driver:
   PUT /api/admin/drivers/:id/status  { "status": "approved" }
   → status set to 'approved'
6. Driver can now go online, accept orders, and earn
```

---

## Admin API Usage

```bash
# Step 1: Login as admin
curl -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@flash.co.za","password":"your-password"}'
# → returns { "token": "eyJ..." }

# Step 2: Use the token for all admin requests
export ADMIN_TOKEN="eyJ..."

# Get all drivers waiting for approval
curl http://localhost:3000/api/admin/drivers?status=documents_submitted \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Approve a driver
curl -X PUT http://localhost:3000/api/admin/drivers/DRIVER_UUID/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'

# Get platform stats
curl http://localhost:3000/api/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Paystack Setup (Step by Step)

1. Go to **dashboard.paystack.com** and create an account
2. Go to **Settings → API Keys & Webhooks**
3. Copy your **Secret Key** (starts with `sk_test_`) into `backend/.env` as `PAYSTACK_SECRET_KEY`
4. Copy your **Public Key** (starts with `pk_test_`) into `backend/.env` as `PAYSTACK_PUBLIC_KEY`
5. Under **Webhooks**, add a new webhook URL:
   - URL: `https://your-backend.onrender.com/api/webhooks/paystack`
   - Events: select **charge.success** and **charge.failed**
6. Test with Paystack test cards (see paystack.com/docs for test card numbers)
7. When ready to go live, swap `sk_test_` → `sk_live_` and `pk_test_` → `pk_live_`

---

## Google Maps Setup

1. Go to **console.cloud.google.com**
2. Create a new project
3. Go to **APIs & Services → Library**
4. Enable: **Maps SDK for Android** and **Maps SDK for iOS**
5. Go to **APIs & Services → Credentials → Create Credentials → API Key**
6. Add the key to both app.json files:

`flash-user-app/app.json`:
```json
"ios": {
  "config": { "googleMapsApiKey": "AIza..." }
},
"android": {
  "config": { "googleMaps": { "apiKey": "AIza..." } }
}
```

`flash-driver-app/app.json` — same changes.

Also add to `backend/.env`:
```
GOOGLE_MAPS_API_KEY=AIza...
```

---

## Going Live Checklist (Production Launch Fixes)

All 8 production fixes must be verified before going live:

### FIX 1 & 2 — App Configuration
- [ ] Both `flash-user-app/services/api.js` and `flash-driver-app/services/api.js` point to production server URL (not hardcoded 100.66.43.71)
- [ ] Both `app.json` files have real Google Maps API keys (not placeholders like YOUR_IOS_GOOGLE_MAPS_API_KEY)
- [ ] Google Maps keys are restricted to the app's bundle ID in Google Cloud Console
- [ ] `EXPO_PUBLIC_API_BASE_URL` environment variable is set to production server URL

### FIX 3 — Trusted Driver Field
- [ ] `flash-user-app/context/FlashContext.js` sends `preferred_driver_id` (not `requested_driver_id`)
- [ ] Test: Request a specific driver from "Trusted Drivers" and verify the order is assigned to that driver

### FIX 4 — Order Status Display
- [ ] All 6 order statuses display correctly: paid, driver_assigned, driver_arrived_store, picked_up, in_transit, delivered, completed
- [ ] "Track Driver Live" button shows when order is in driver_assigned, driver_arrived_store, picked_up, or in_transit
- [ ] Test: Place an order and track through all states without blank screens

### FIX 5 — Cash OTP Completion
- [ ] Driver app shows "Request Cash OTP" button when order is cash + delivered
- [ ] Test: Mark a cash order as delivered and verify the OTP UI appears and works
- [ ] Test: Entering correct OTP marks order completed and releases driver wallet balance

### FIX 6 — Background Push Notifications
- [ ] Backend has `expo-server-sdk` installed (`npm install expo-server-sdk`)
- [ ] Driver app installed `expo-notifications` (`npx expo install expo-notifications`)
- [ ] Driver app requests push notification permission on first login
- [ ] Backend saves push token to `drivers.push_token` column
- [ ] Test: New order assigned to driver while app backgrounded still reaches driver with push notification + sound

### FIX 7 — Real Paystack Payouts
- [ ] Backend has real `paystack_recipient_code` saved in drivers table (driver added bank account)
- [ ] Payout flow calls `paystackService.initiateTransfer()` (not simulated)
- [ ] Test: Process a payout and verify money actually arrives in driver's bank account

### FIX 8 — Environment Variables & Security
- [ ] `JWT_SECRET` is a long random string (not placeholder)
- [ ] `PAYSTACK_SECRET_KEY` is `sk_live_` (not `sk_test_`)
- [ ] `ADMIN_PASSWORD_HASH` is a bcrypt hash (not plain text)
- [ ] Payflex webhook endpoint URL is registered in Payflex dashboard
- [ ] `PAYFLEX_WEBHOOK_SECRET` is set to real value in `.env`
- [ ] `APP_URL` is production server URL
- [ ] Webhook idempotency check prevents duplicate order processing

### Database Migrations
- [ ] Run migration script once: `node src/db/migrate.js`
- [ ] Verify new columns exist: `drivers.push_token`, `drivers.paystack_recipient_code`, `users.push_token`
- [ ] Verify new tables exist: `payflex_webhook_events`

### Before Switching to Live
- [ ] Change `PAYSTACK_SECRET_KEY` from `sk_test_` to `sk_live_`
- [ ] Change `PAYSTACK_PUBLIC_KEY` from `pk_test_` to `pk_live_`
- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Change `JWT_SECRET` to a long random string
- [ ] Generate `ADMIN_PASSWORD_HASH` and set it in `.env`
- [ ] Set `APP_URL` to your real backend URL
- [ ] Add the production backend URL as a Paystack webhook endpoint
- [ ] Set real Google Maps API keys in both `app.json` files
- [ ] Add AWS S3 credentials for driver document uploads
- [ ] Set `REDIS_URL` if running more than one backend server
- [ ] Set `DB_POOL_MAX=50` on a paid Postgres plan

---

## Deployment to Render (Recommended for SA)

Render has data centers in Cape Town (af-south-1) making it fast for SA users.

1. Push your code to GitHub
2. Go to **render.com** → New → Web Service → connect your GitHub repo
3. Set **Root Directory** to `backend`
4. Set **Build Command** to `npm install` (will also install expo-server-sdk)
5. Set **Start Command** to `node server.js`
6. Under **Environment**, add all your `.env` variables from the checklist above
7. Add a **PostgreSQL** service from Render and copy the Internal Database URL into `DATABASE_URL`
8. After deploy, open the Render Shell and run `node src/db/migrate.js` (will add push_token and paystack_recipient_code columns)
9. Verify the app connects and test all 8 fixes work end-to-end

---

## Troubleshooting

**App shows "Request failed" or "Network Error"**
- Check that `EXPO_PUBLIC_API_BASE_URL` matches your current WiFi IP
- Make sure the backend is running (`docker compose ps`, `node server.js`, or `node mock-server.js`)
- Make sure your phone and computer are on the same WiFi network

**Map is blank on the tracking screen**
- In Expo Go the map works without an API key
- For a real build (Play Store/App Store), you must add Google Maps API keys to `app.json`

**Payment opens Paystack but order stays unpaid**
- The Paystack webhook URL must be set in the Paystack dashboard
- The `APP_URL` in `.env` must match your running backend URL
- For local testing, use the Paystack CLI or ngrok to forward webhooks to localhost

**Driver app says "Account not approved"**
- The driver registered but hasn't been approved yet
- Use the admin API to approve: `PUT /api/admin/drivers/:id/status` with `{ "status": "approved" }`

**"No order data" on Order Status screen**
- This is handled — the screen fetches the order by ID if only an ID is passed
- If it still shows, check that the backend `/api/orders/:id` endpoint is reachable

