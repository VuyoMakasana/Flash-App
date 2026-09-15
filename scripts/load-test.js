#!/usr/bin/env node
'use strict';

/**
 * scripts/load-test.js — Flash reusable load-test harness (Phase 5).
 *
 * Simulates the full flash-user-app flow (signup, browse, cart, checkout,
 * track, rate) at a configurable customer concurrency, and the full
 * flash-driver-app flow (go online, accept/complete deliveries, cash-OTP,
 * earnings) at a configurable driver concurrency, against a running Flash
 * backend (local Docker sandbox by default).
 *
 * Deliberately zero new npm dependencies — uses only Node 20+ built-ins
 * (global fetch/FormData/Blob, crypto, perf_hooks). CLAUDE.md's own rule is
 * "do not install new libraries automatically" and everything this script
 * needs (HTTP requests, multipart uploads, timing) is already covered by
 * what ships with Node 20, which this repo already requires — a load-test-
 * specific HTTP client (autocannon/k6/artillery) was considered and
 * rejected: this script needs to orchestrate real, stateful, multi-step
 * user/driver flows with data carried between steps (a created order's id,
 * a cash OTP passed from the customer side to the driver side), which those
 * tools are built to bypass, not help with — a plain script is the right
 * tool for "simulate a real flow," a request-blaster is the right tool for
 * "hammer one endpoint," which isn't what was asked for here.
 *
 * Usage:
 *   node scripts/load-test.js [--customers=50] [--drivers=10]
 *     [--base-url=http://localhost:3000] [--duration=60]
 *
 * Every number above is a parameter, not a constant baked into the flow
 * logic below — re-run at 500/100 later exactly the same way.
 *
 * KNOWN LIMITATION (documented, not hidden): pickup-photo/dropoff-photo
 * (driverController.submitPickupPhoto/submitDropoffPhoto) upload through
 * s3Service.js to real Cloudinary — a local/dev .env with placeholder
 * Cloudinary credentials (this repo's own docker-compose sandbox, per
 * CLAUDE.md, has no requirement to configure a real one) makes those two
 * specific calls fail with a real upstream auth error, not a bug in this
 * script or the backend. That means a driver's flow in THIS sandbox
 * realistically completes through "accept order," not all the way to
 * "delivered" — reported honestly as its own metric below, not silently
 * papered over. Point CLOUDINARY_* at a real (even free-tier) account to
 * exercise the full pickup→dropoff→cash-OTP→earnings chain.
 */

const { performance } = require('perf_hooks');
const crypto = require('crypto');

// ─── CLI args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { customers: 50, drivers: 10, baseUrl: 'http://localhost:3000', duration: 60 };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-z-]+)=(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'customers') args.customers = parseInt(val, 10);
    else if (key === 'drivers') args.drivers = parseInt(val, 10);
    else if (key === 'base-url') args.baseUrl = val;
    else if (key === 'duration') args.duration = parseInt(val, 10);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const BASE_URL = ARGS.baseUrl;
const RUN_UNTIL = Date.now() + ARGS.duration * 1000;

// A minimal but genuinely valid JPEG signature (FF D8 FF) — enough for
// fileSignature.js's real magic-byte check (detectRealMimeType), which is
// exactly what it inspects; a full real photo is not required to exercise
// that code path under load.
const FAKE_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

// Nelson Mandela Bay bounds (geoBoundary.js's real NMB_BOUNDS, same values
// migrate.js v36 seeds stores.service_area_bounds with) — a load-test order
// needs a real, in-bounds dropoff or every single one is rejected at the
// same geofence check real customers hit.
const DROPOFF = { lat: -33.90, lng: 25.60 };

// ─── Metrics ─────────────────────────────────────────────────────────────
class Metrics {
  constructor() {
    this.byEndpoint = new Map(); // label -> { count, errors, totalMs, maxMs, samples: [] }
  }

  record(label, ms, ok) {
    let entry = this.byEndpoint.get(label);
    if (!entry) {
      entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] };
      this.byEndpoint.set(label, entry);
    }
    entry.count += 1;
    if (!ok) entry.errors += 1;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    entry.samples.push(ms);
  }

  percentile(samples, p) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  report() {
    const rows = [];
    for (const [label, e] of this.byEndpoint.entries()) {
      rows.push({
        endpoint: label,
        count: e.count,
        errors: e.errors,
        errorRate: e.count ? `${((e.errors / e.count) * 100).toFixed(1)}%` : '0%',
        avgMs: e.count ? (e.totalMs / e.count).toFixed(0) : 0,
        p95Ms: this.percentile(e.samples, 95).toFixed(0),
        maxMs: e.maxMs.toFixed(0),
      });
    }
    return rows;
  }
}

const metrics = new Metrics();

// ─── HTTP helper ─────────────────────────────────────────────────────────
async function call(label, path, options = {}) {
  const start = performance.now();
  let ok = true;
  let status = 0;
  let body = null;
  try {
    const res = await fetch(`${BASE_URL}${path}`, options);
    status = res.status;
    ok = res.ok;
    body = await res.json().catch(() => ({}));
  } catch (err) {
    ok = false;
    body = { error: err.message };
  }
  const ms = performance.now() - start;
  metrics.record(label, ms, ok);
  return { ok, status, body };
}

// Every request from a given virtual user carries a distinct synthetic
// X-Forwarded-For — server.js sets `trust proxy` whenever NODE_ENV=production
// (this sandbox's docker-compose backend service does), so Express's req.ip
// (what every IP-keyed rate limiter in rateLimiter.js — the general limiter,
// authLimiter, orderLimiter, etc. — actually keys on) honors it. Without
// this, every virtual user in this single Node process shares ONE real
// source IP, and authLimiter's real, correct 10-req/15-min-per-IP cap
// (protecting real production traffic from credential-stuffing) would trip
// almost immediately under concurrency — measuring "how fast does the rate
// limiter reject a single IP" instead of "how does the backend perform
// under N distributed users," which is what this harness is actually for.
// This is not a bypass of that protection: it's the accurate model of what
// N real users behind N real distinct IPs actually look like to it.
function simulatedIp(kind, index) {
  const base = kind === 'driver' ? 10 : 20;
  return `${base}.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
}

function authHeaders(token, ip, extra = {}) {
  return { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip, ...extra };
}

function jsonHeaders(token, ip) {
  return authHeaders(token, ip, { 'Content-Type': 'application/json' });
}

function randomEmail(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}@loadtest.flash.invalid`;
}

// ─── Customer flow ───────────────────────────────────────────────────────
// Mirrors flash-user-app's real flow: signup, browse, cart (client-side —
// no request), checkout, track, rate. Runs in a loop until RUN_UNTIL so the
// harness measures sustained load, not one single pass.
async function customerFlow(index, board) {
  const ip = simulatedIp('customer', index);
  let iteration = 0;
  while (Date.now() < RUN_UNTIL) {
    iteration += 1;
    const email = randomEmail(`customer${index}-${iteration}`);
    const password = `LoadTest#${crypto.randomBytes(4).toString('hex')}A1`;

    // Signup
    const reg = await call('user:register', '/api/auth/user/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({
        name: `Load Test Customer ${index}`,
        email,
        password,
        phone: `08${String(1000000 + index).padStart(8, '0')}`,
        date_of_birth: '1995-01-01',
      }),
    });
    if (!reg.ok || !reg.body.token) continue;
    const token = reg.body.token;

    // Browse — the real customer-facing catalog.
    const browse = await call('user:browse-inventory', '/api/inventory', { headers: jsonHeaders(token, ip) });
    const products = browse.body?.products || [];
    if (!products.length) continue; // nothing to buy — seed inventory before running at scale

    const product = products[Math.floor(Math.random() * products.length)];
    const sizes = Object.keys(product.stock_by_size || {});
    const size = sizes.length ? sizes[Math.floor(Math.random() * sizes.length)] : null;

    // Cart is purely client-side state in the real app (FlashContext.js) —
    // nothing to call here; the "cart" is just the item chosen above.

    // Checkout — cash order, a real in-bounds dropoff.
    const orderRes = await call('user:create-order', '/api/orders', {
      method: 'POST',
      headers: jsonHeaders(token, ip),
      body: JSON.stringify({
        items: [{ productId: product.id, name: product.product_name, size, quantity: 1, price: product.price }],
        delivery_mode: 'standard',
        subtotal: product.price,
        dropoff_address: 'Load test address, Gqeberha',
        dropoff_lat: DROPOFF.lat,
        dropoff_lng: DROPOFF.lng,
      }),
    });
    if (!orderRes.ok || !orderRes.body.order) continue;
    const orderId = orderRes.body.order.id;

    const paid = await call('user:cash-on-delivery', '/api/payments/cash-on-delivery', {
      method: 'POST',
      headers: jsonHeaders(token, ip),
      body: JSON.stringify({ orderId }),
    });
    if (paid.ok) {
      board.openOrders.push({ orderId, customerToken: token, customerIp: ip });
    }

    // Track — poll a few times, the same real GET a customer's app calls
    // repeatedly while an order is active.
    for (let i = 0; i < 3; i += 1) {
      await call('user:track-order', `/api/orders/${orderId}`, { headers: jsonHeaders(token, ip) });
      await sleep(1000);
    }

    // Rate — only meaningful once delivered; best-effort, not forced.
    const current = await call('user:get-order-for-rating', `/api/orders/${orderId}`, { headers: jsonHeaders(token, ip) });
    if (current.ok && current.body?.order?.status === 'delivered') {
      await call('user:rate-driver', `/api/orders/${orderId}/rate-driver`, {
        method: 'POST',
        headers: jsonHeaders(token, ip),
        body: JSON.stringify({ rating: 5, comment: 'Load test rating' }),
      });
    }
  }
}

// ─── Driver flow ─────────────────────────────────────────────────────────
async function driverFlow(index, board) {
  const ip = simulatedIp('driver', index);
  const email = randomEmail(`driver${index}`);
  const password = `LoadTest#${crypto.randomBytes(4).toString('hex')}A1`;

  const reg = await call('driver:register', '/api/auth/driver/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({
      name: `Load Test Driver ${index}`,
      email,
      password,
      phone: `07${String(2000000 + index).padStart(8, '0')}`,
      vehicle_type: 'motorbike',
      vehicle_plate: `LT${index}TEST`,
      date_of_birth: '1990-01-01',
    }),
  });
  if (!reg.ok || !reg.body.token) return;
  const token = reg.body.token;

  await call('driver:go-online', '/api/drivers/online', {
    method: 'POST',
    headers: jsonHeaders(token, ip),
    body: JSON.stringify({ online: true, lat: DROPOFF.lat, lng: DROPOFF.lng }),
  });

  while (Date.now() < RUN_UNTIL) {
    await call('driver:location-update', '/api/drivers/location', {
      method: 'POST',
      headers: jsonHeaders(token, ip),
      body: JSON.stringify({ lat: DROPOFF.lat + (Math.random() - 0.5) * 0.01, lng: DROPOFF.lng + (Math.random() - 0.5) * 0.01 }),
    });

    const available = await call('driver:available-orders', '/api/drivers/available-orders', { headers: jsonHeaders(token, ip) });
    const orders = available.body?.orders || [];
    if (orders.length) {
      const target = orders[0];
      const accept = await call('driver:accept-order', `/api/drivers/orders/${target.id}/accept`, {
        method: 'POST',
        headers: jsonHeaders(token, ip),
      });
      if (accept.ok) {
        await attemptDelivery(token, ip, target.id, board);
      }
    }

    await sleep(2000);
  }

  await call('driver:earnings', '/api/drivers/earnings', { headers: jsonHeaders(token, ip) });
  await call('driver:wallet', '/api/drivers/wallet', { headers: jsonHeaders(token, ip) });
}

// Best-effort completion of an accepted delivery. See the KNOWN LIMITATION
// note at the top of this file — the two photo-upload steps genuinely
// cannot succeed against this sandbox's placeholder Cloudinary credentials,
// so this function's own metrics (driver:pickup-photo / driver:dropoff-
// photo) are expected to show a real, honestly-reported error rate here,
// not a bug to chase.
async function attemptDelivery(driverToken, ip, orderId, board) {
  const form1 = new FormData();
  form1.append('photo', new Blob([FAKE_JPEG_BYTES], { type: 'image/jpeg' }), 'pickup.jpg');
  await call('driver:pickup-photo', `/api/drivers/orders/${orderId}/pickup-photo`, {
    method: 'POST',
    headers: authHeaders(driverToken, ip),
    body: form1,
  });

  const form2 = new FormData();
  form2.append('photo', new Blob([FAKE_JPEG_BYTES], { type: 'image/jpeg' }), 'dropoff.jpg');
  const dropoff = await call('driver:dropoff-photo', `/api/drivers/orders/${orderId}/dropoff-photo`, {
    method: 'POST',
    headers: authHeaders(driverToken, ip),
    body: form2,
  });
  if (!dropoff.ok) return;

  await call('driver:cash-send-otp', '/api/payments/cash/send-otp', {
    method: 'POST',
    headers: jsonHeaders(driverToken, ip),
    body: JSON.stringify({ orderId }),
  });

  const record = board.openOrders.find((o) => o.orderId === orderId);
  if (!record) return;
  const otpRes = await call('user:get-cash-otp', `/api/payments/cash/otp/${orderId}`, { headers: jsonHeaders(record.customerToken, record.customerIp) });
  const otp = otpRes.body?.otp;
  if (!otp) return;

  await call('driver:cash-confirm', '/api/payments/cash/confirm', {
    method: 'POST',
    headers: jsonHeaders(driverToken, ip),
    body: JSON.stringify({ orderId, otp }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Flash load test — ${ARGS.customers} customers, ${ARGS.drivers} drivers, ${ARGS.duration}s, target ${BASE_URL}`);
  const board = { openOrders: [] };

  const customerPromises = Array.from({ length: ARGS.customers }, (_, i) => customerFlow(i, board));
  const driverPromises = Array.from({ length: ARGS.drivers }, (_, i) => driverFlow(i, board));

  await Promise.all([...customerPromises, ...driverPromises]);

  console.log('\n=== Flash load test results ===\n');
  const rows = metrics.report();
  const widths = { endpoint: 32, count: 8, errors: 8, errorRate: 10, avgMs: 10, p95Ms: 10, maxMs: 10 };
  const header = ['endpoint', 'count', 'errors', 'errorRate', 'avgMs', 'p95Ms', 'maxMs'];
  console.log(header.map((h) => h.padEnd(widths[h])).join(''));
  for (const row of rows) {
    console.log(header.map((h) => String(row[h]).padEnd(widths[h])).join(''));
  }
  console.log(`\nOpen/paid orders created: ${board.openOrders.length}`);
  console.log('\nRe-run with, e.g.: node scripts/load-test.js --customers=500 --drivers=100 --duration=120');
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exit(1);
});
