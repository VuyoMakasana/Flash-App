'use strict';

// Admin panel Phase 1 (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md, §3 Phase 1
// + Addendum 3 §3). Proof-of-concept (drivers only) proven live and verified
// in a real browser before this file grew to its full Phase 1 scope: drivers,
// orders, order_cancellations, and return_requests with real custom actions
// wrapping the existing controller/model business logic — not reimplementing
// it. Every custom action logs to admin_actions (Phase 0), the same audit
// trail the JSON API's admin-mutating endpoints already write to.
//
// @adminjs/express and @adminjs/sql are ESM-only — confirmed directly
// against the installed packages (require() throws ERR_PACKAGE_PATH_NOT_EXPORTED
// for both), not assumed from their docs. Dynamic import() is the standard,
// well-supported Node interop path for an ESM-only package from CommonJS —
// this does not require converting the rest of the backend to ESM.
// adminjs core itself IS require()-able, but its class is at .default
// (dual CJS/ESM interop shape, confirmed the same way).

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const Admin = require('./models/Admin');
const AdminAction = require('./models/AdminAction');
const Return = require('./models/Return');
const SosAlert = require('./models/SosAlert');
const Inventory = require('./models/Inventory');
const Fleet = require('./models/Fleet');
const s3Service = require('./services/s3Service');
const { clearCache } = require('./middleware/cache');
const { withChronologicalDefaults, RESOURCE_TIMESTAMP_COLUMNS } = require('./config/adminResourceDefaults');
// Named pgPool, deliberately not db — mountAdminPanel already has a local
// `db` variable for the @adminjs/sql adapter; reusing that name here for an
// unrelated plain pg Pool would be exactly the kind of mistake worth
// avoiding on purpose, not by luck.
const pgPool = require('./config/database');

const ADMIN_PANEL_PATH = '/admin-panel';
// The real Flash logo -- confirmed the exact same file (identical MD5) as
// both flash-user-app/assets/icon.png and flash-driver-app/assets/flash-logo.png,
// so this is a real, existing brand asset copied in, not a new/invented one.
// Served as a plain static file under this mount (below) so branding.logo
// can point at a real URL -- AdminJS's own login/sidebar components already
// constrain it to max-width 200px/170px respectively (confirmed by reading
// login/index.js and sidebar-branding.js directly), so the single
// full-resolution 512x512 source renders correctly in both spots without
// needing separate pre-resized copies.
const ADMIN_LOGO_URL = `${ADMIN_PANEL_PATH}/assets/flash-logo.png`;

// Real observed response shape (confirmed live against the running mount,
// not assumed from AdminJS's own generic docs example): list responses are
// { records: [{ params: {...}, populated: {...} }] }, show/edit responses
// are { record: { params: {...}, populated: {...} } }.
//
// FOUND LIVE while verifying the display-cleanup work below (adding
// titleProperty to drivers/orders so references show real names instead of
// raw UUIDs — see suppressReference's neighbors further down): AdminJS's
// own reference-populator embeds the FULL referenced record — including its
// raw, unstripped params — under record.populated[path]. That means once
// orders.driver_id (or return_requests.driver_id, or anything referencing
// drivers) started resolving to a real driver record, the driver's actual
// bcrypt password_hash rode along inside orders'/return_requests' own
// list/show responses, completely bypassing the stripping this function
// already did for drivers' OWN direct responses. Same risk for orders'
// cash_otp_hash/cash_otp_plain riding along inside order_cancellations' and
// return_requests' responses via their order_id reference. Fixed by
// recursing into record.populated so a single call covers a record's own
// fields AND anything pulled in through any reference, at any depth.
function stripFields(fieldNames) {
  function stripFromRecord(record) {
    if (!record) return;
    if (record.params) fieldNames.forEach((f) => delete record.params[f]);
    if (record.populated) Object.values(record.populated).forEach(stripFromRecord);
  }
  return function (response) {
    stripFromRecord(response.record);
    if (Array.isArray(response.records)) response.records.forEach(stripFromRecord);
    return response;
  };
}

// Single shared list, applied on every resource's list/show (and any custom
// action that returns a record) — deliberately not per-resource anymore.
// Given the populated-record leak above, ANY resource that references
// drivers or orders can carry these fields in, regardless of whether that
// resource "owns" the field itself — a shared list applied everywhere is
// the only way to be sure none of the four resources can leak one of these
// by way of a reference someone adds later.
const SENSITIVE_FIELDS = ['password_hash', 'cash_otp_hash', 'cash_otp_plain'];
const stripSensitive = stripFields(SENSITIVE_FIELDS);

// @adminjs/sql's own introspection never returns a "users" table at all
// (confirmed live — 46 tables discovered, users absent; the real cause,
// found while investigating this fix: information_schema.columns has TWO
// tables named "users" in this database — public.users (the real app
// table) and auth.users (Supabase-managed) — and the adapter's own
// unqualified-by-schema queries return "more than one row" for any table
// name that collides across schemas, so it silently drops them). That
// means user_id/cancelled_by_id can never be a real AdminJS reference —
// only a plain UUID column. To still show a real name instead of a bare
// UUID in the list view (per the founder's explicit ask), this resolves
// the raw ids in a page of list results directly against the real
// public.users table (one batched query per page, not one query per row)
// and overwrites the displayed value. Deliberately applied to `list`
// only, never `show` — the founder explicitly asked for raw IDs to stay
// available in the detail view for anyone who needs them.
function attachUserNames(fieldName) {
  return async function (response) {
    const records = response.records;
    if (!Array.isArray(records) || records.length === 0) return response;
    const ids = [...new Set(records.map((r) => r.params?.[fieldName]).filter(Boolean))];
    if (ids.length === 0) return response;
    const { rows } = await pgPool.query(
      'SELECT id, name, phone FROM public.users WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.map((u) => [u.id, u]));
    records.forEach((r) => {
      const rawId = r.params?.[fieldName];
      const user = rawId && byId.get(rawId);
      if (user && r.params && user.name) {
        r.params[fieldName] = user.phone ? `${user.name} — ${user.phone}` : user.name;
      }
    });
    return response;
  };
}

// Real enum values, confirmed by reading the actual source of truth for
// each — not guessed. Orders: orderStateMachineService.js's ORDER_STATES.
// Drivers: the literal status strings assigned in models/Driver.js.
// Returns: the literal status strings assigned in models/Return.js.
// Order cancellations: the literal refundMode/cancelled_by_role strings
// assigned in controllers/orderController.js + server.js's timeout job.
// AdminJS renders any property with matching availableValues as a real
// styled Badge component automatically (confirmed by reading
// default-property-value.js) — no custom frontend component needed.
const ORDER_STATUS_VALUES = [
  { value: 'created', label: 'Created' },
  { value: 'payment_pending', label: 'Payment Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'scheduled_for_morning', label: 'Scheduled For Morning' },
  { value: 'waiting_for_driver', label: 'Waiting For Driver' },
  { value: 'driver_assigned', label: 'Driver Assigned' },
  { value: 'driver_arrived_store', label: 'Driver Arrived At Store' },
  { value: 'picked_up', label: 'Picked Up' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const DRIVER_STATUS_VALUES = [
  { value: 'pending_documents', label: 'Pending Documents' },
  { value: 'documents_submitted', label: 'Documents Submitted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
];

const RETURN_STATUS_VALUES = [
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'refunded', label: 'Refunded' },
];

const REFUND_MODE_VALUES = [
  { value: 'none', label: 'No Refund' },
  { value: 'full_refund', label: 'Full Refund' },
  { value: 'pre_pickup_split', label: 'Pre-Pickup Split' },
  { value: 'store_refund_no_delivery_refund', label: 'Store Refund (No Delivery Refund)' },
  // Legacy value, found live in real historical data — predates the
  // pre_pickup_split rename. Kept here purely so old rows still get a
  // readable badge instead of falling through to the raw string.
  { value: 'store_refund_keep_delivery', label: 'Store Refund (Legacy — Delivery Fee Kept)' },
];

const CANCELLED_BY_ROLE_VALUES = [
  { value: 'user', label: 'Customer' },
  { value: 'system', label: 'System (Auto-Cancelled)' },
];

// sos_alerts.triggered_by_role's own real CHECK constraint (migrate.js).
const TRIGGERED_BY_ROLE_VALUES = [
  { value: 'user', label: 'Customer' },
  { value: 'driver', label: 'Driver' },
];

// Real, fixed set — confirmed by reading driverController.js's own
// REQUIRED_DOCS array (the actual server-side allow-list a driver's upload
// is checked against), not guessed. document_type has no DB-level CHECK
// constraint, so this is a display label lookup, not a validator — an
// unrecognized value still renders, just with its raw string as the label.
const DOCUMENT_TYPE_LABELS = {
  government_id: 'Government ID',
  drivers_license: "Driver's License",
  police_certified: 'Police Clearance Certificate',
  profile_photo: 'Profile Photo',
  vehicle_registration: 'Vehicle Registration',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Surfaces the same signed, short-lived URLs Admin.getDriverById already
// generates (the H-access-audit fix — never the permanent file_url column)
// as a real, viewable-in-panel document review screen. `documents` is a
// virtual property (declared in drivers' resource options below, not a real
// DB column) — AdminJS's own decorateVirtualProperties creates a real
// property for any options.properties key that isn't an existing column,
// confirmed by reading decorate-properties.js directly. Uses AdminJS's
// built-in `richtext` property type (renders via the `xss` package's
// default whitelist, confirmed to keep <a href>/<img src> intact) instead of
// a custom frontend component -- no new bundling risk, no new dependency.
async function attachDriverDocuments(response) {
  const record = response.record;
  if (!record?.params) return response;
  const result = await Admin.getDriverById(record.id);
  const documents = result?.documents || [];
  record.params.documents = documents.length
    ? documents.map((doc) => {
      const label = DOCUMENT_TYPE_LABELS[doc.document_type] || doc.document_type;
      const status = doc.verified ? 'Verified' : 'Not yet verified';
      if (!doc.file_url) {
        return `<p><b>${escapeHtml(label)}</b> — ${status}<br>(no file available — either nothing uploaded yet, or it predates the signed-URL fix and needs re-upload)</p>`;
      }
      return `<p><b>${escapeHtml(label)}</b> — ${status}<br>`
        + `<a href="${doc.file_url}" target="_blank" rel="noopener">Open full-size in a new tab</a><br>`
        + `<img src="${doc.file_url}" alt="${escapeHtml(label)}" style="max-width:320px;margin-top:6px;border:1px solid #ccc" /></p>`;
    }).join('<hr>')
    : '<p>No documents uploaded yet.</p>';
  return response;
}

// Unified order-detail view (Addendum 2 §1 of the planning doc): customer
// contact and driver contact, plus that order's return/cancellation shown
// inline if one exists, rather than requiring a switch to a separate
// resource to discover them. Four virtual properties (declared show-only,
// textarea type — plain multi-line text, no HTML, so no escaping/xss
// concerns the way the richtext driver-documents field has). Deliberately
// additive: user_id/driver_id stay exactly as they already were (raw UUID
// column + driver_id's existing working reference-link) — this only adds
// alongside, it doesn't touch either of those two fields, so tonight's
// earlier "keep raw IDs in the detail view" behavior is unaffected.
async function attachOrderDetailContext(response) {
  const record = response.record;
  if (!record?.params) return response;
  const orderId = record.id;
  const userId = record.params.user_id;
  const driverId = record.params.driver_id;

  const [userRes, driverRes, returnRes, cancellationRes] = await Promise.all([
    userId
      ? pgPool.query('SELECT name, phone, email FROM public.users WHERE id = $1', [userId])
      : Promise.resolve({ rows: [] }),
    driverId
      ? pgPool.query('SELECT phone, vehicle_type, vehicle_plate FROM drivers WHERE id = $1', [driverId])
      : Promise.resolve({ rows: [] }),
    pgPool.query(
      'SELECT status, reason, refund_amount, credit_amount FROM return_requests WHERE order_id = $1',
      [orderId],
    ),
    pgPool.query(
      `SELECT reason, refund_mode, store_amount, driver_amount, customer_item_refund, delivery_fee_refunded
       FROM order_cancellations WHERE order_id = $1`,
      [orderId],
    ),
  ]);

  const u = userRes.rows[0];
  record.params.customer_contact = u
    ? `Name: ${u.name || '(none on file)'}\nPhone: ${u.phone || '(none on file)'}\nEmail: ${u.email || '(none on file)'}`
    : 'No customer record found for this order.';

  const d = driverRes.rows[0];
  record.params.driver_contact = driverId
    ? (d
      ? `Phone: ${d.phone || '(none on file)'}\nVehicle: ${d.vehicle_type || '(not on file)'} ${d.vehicle_plate || ''}`.trim()
      : 'Assigned driver record not found.')
    : 'No driver assigned to this order yet.';

  const ret = returnRes.rows[0];
  record.params.return_status = ret
    ? `Status: ${ret.status}\nReason: ${ret.reason || '(none given)'}\nRefund amount: R${ret.refund_amount || '0.00'}\nCredit amount: R${ret.credit_amount || '0.00'}`
    : 'No return request on this order.';

  const canc = cancellationRes.rows[0];
  record.params.cancellation_details = canc
    ? `Reason: ${canc.reason || '(none given)'}\nRefund mode: ${canc.refund_mode || '(not recorded)'}\n`
      + `Store share: R${canc.store_amount || '0.00'}\nDriver compensation: R${canc.driver_amount || '0.00'}\n`
      + `Customer item refund: R${canc.customer_item_refund || '0.00'}\nDelivery fee refunded: R${canc.delivery_fee_refunded || '0.00'}`
    : 'This order was not cancelled.';

  return response;
}

// Phase 2 -- the order-photos dispute-review screen (Addendum 2 §1's
// "returns/cancellations, full detail, not siloed" ask, plus the messages
// table finding from Addendum 1 §4.1: "a dispute needs the conversation,
// not just the photo"). Reuses s3Service.getSignedUrl directly -- the same
// short-lived, never-permanent signed URL the real JSON API's
// orderController.getOrderPhotos already generates, not a second
// implementation of that logic. pickup/dropoff_photo_public_id are real
// columns already present in record.params (never hidden), read directly
// rather than re-queried.
async function attachDisputeContext(response) {
  const record = response.record;
  if (!record?.params) return response;
  const orderId = record.id;
  const {
    pickup_photo_public_id: pickupId, pickup_photo_resource_type: pickupType, pickup_photo_at: pickupAt,
    dropoff_photo_public_id: dropoffId, dropoff_photo_resource_type: dropoffType, dropoff_photo_at: dropoffAt,
  } = record.params;

  const [pickupUrl, dropoffUrl, messagesRes] = await Promise.all([
    s3Service.getSignedUrl(pickupId, pickupType || 'image'),
    s3Service.getSignedUrl(dropoffId, dropoffType || 'image'),
    pgPool.query(
      'SELECT sender_id, sender_role, content, created_at FROM messages WHERE order_id = $1 ORDER BY created_at ASC',
      [orderId],
    ),
  ]);

  record.params.photos = [
    pickupUrl
      ? `<p><b>Pickup photo</b> — ${new Date(pickupAt).toLocaleString()}<br><a href="${pickupUrl}" target="_blank" rel="noopener">Open full-size</a><br><img src="${pickupUrl}" style="max-width:280px;margin-top:6px;border:1px solid #ccc" /></p>`
      : '<p><b>Pickup photo</b> — none uploaded yet.</p>',
    dropoffUrl
      ? `<p><b>Dropoff photo</b> — ${new Date(dropoffAt).toLocaleString()}<br><a href="${dropoffUrl}" target="_blank" rel="noopener">Open full-size</a><br><img src="${dropoffUrl}" style="max-width:280px;margin-top:6px;border:1px solid #ccc" /></p>`
      : '<p><b>Dropoff photo</b> — none uploaded yet.</p>',
  ].join('<hr>');

  // sender_id is polymorphic (messages.sender_role CHECK ('user','driver')) --
  // same pattern as sos_alerts.triggered_by_id, same fix.
  const rows = messagesRes.rows;
  const userIds = rows.filter((m) => m.sender_role === 'user').map((m) => m.sender_id);
  const driverIds = rows.filter((m) => m.sender_role === 'driver').map((m) => m.sender_id);
  const [userRows, driverRows] = await Promise.all([
    userIds.length ? pgPool.query('SELECT id, name FROM public.users WHERE id = ANY($1::uuid[])', [userIds]) : { rows: [] },
    driverIds.length ? pgPool.query('SELECT id, name FROM drivers WHERE id = ANY($1::uuid[])', [driverIds]) : { rows: [] },
  ]);
  const nameById = new Map([...userRows.rows, ...driverRows.rows].map((p) => [p.id, p.name]));

  // Type 'textarea', not 'richtext' -- rendered as plain text children
  // (confirmed by reading textarea/show.js), never dangerouslySetInnerHTML,
  // so real customer/driver-written message content can never inject HTML
  // through this field the way it safely could for `photos` above (whose
  // only interpolated values are server-generated URLs/dates, never raw
  // user text).
  record.params.order_chat = rows.length
    ? rows.map((m) => `${new Date(m.created_at).toLocaleString()} — ${nameById.get(m.sender_id) || m.sender_role}: ${m.content}`).join('\n')
    : 'No messages on this order.';

  return response;
}

// Phase 2 (ADMIN_PANEL_AUDIT_AND_VISION.md §3/§4.3) -- driver wallet/payout
// visibility. Real data already exists in driver_wallets/driver_wallet_ledger/
// driver_payout_requests -- there was simply no admin endpoint at all to see
// any driver's balance, pending amount, or payout history (an admin could
// previously only find this out by querying the database directly). This
// virtual field gives the at-a-glance answer directly on a driver's own
// page; the four detailed tables are also registered as their own
// resources below for full browsing/filtering.
async function attachWalletSummary(response) {
  const record = response.record;
  if (!record?.params) return response;
  const driverId = record.id;
  const [walletRes, ledgerRes, payoutRes] = await Promise.all([
    pgPool.query(
      'SELECT wallet_balance, pending_balance, cash_commission_debt, unpaid_cash_deliveries FROM driver_wallets WHERE driver_id = $1',
      [driverId],
    ),
    pgPool.query(
      'SELECT amount, entry_type, note, created_at FROM driver_wallet_ledger WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 5',
      [driverId],
    ),
    pgPool.query(
      'SELECT amount, status, created_at FROM driver_payout_requests WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 3',
      [driverId],
    ),
  ]);
  const w = walletRes.rows[0];
  const walletLines = w
    ? `Available: R${w.wallet_balance}\nPending: R${w.pending_balance}\nCash commission owed: R${w.cash_commission_debt}\nUnpaid cash deliveries: ${w.unpaid_cash_deliveries}`
    : 'No wallet record yet (no completed deliveries).';
  const ledgerLines = ledgerRes.rows.length
    ? ledgerRes.rows.map((l) => `${new Date(l.created_at).toLocaleString()} — ${l.entry_type} R${l.amount}${l.note ? ` (${l.note})` : ''}`).join('\n')
    : 'No ledger entries yet.';
  const payoutLines = payoutRes.rows.length
    ? payoutRes.rows.map((p) => `${new Date(p.created_at).toLocaleString()} — R${p.amount} — ${p.status}`).join('\n')
    : 'No payout requests yet.';
  record.params.wallet_summary = `${walletLines}\n\nRecent ledger entries (last 5):\n${ledgerLines}\n\nRecent payout requests (last 3):\n${payoutLines}`;
  return response;
}

const WALLET_LEDGER_ENTRY_TYPE_VALUES = [
  { value: 'pending_credit', label: 'Pending Credit' },
  { value: 'available_credit', label: 'Available Credit' },
  { value: 'pending_debit', label: 'Pending Debit' },
  { value: 'payout_debit', label: 'Payout Debit' },
];

const PAYOUT_REQUEST_STATUS_VALUES = [
  { value: 'requested', label: 'Requested' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const PAYOUT_TRANSACTION_STATUS_VALUES = [
  { value: 'initiated', label: 'Initiated' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

// driver_ratings.rating's own real CHECK constraint (migrate.js: BETWEEN 1
// AND 5). Not a status in the usual sense, but the same Badge mechanism
// (default-property-value.js) applies to any availableValues match
// regardless of the underlying data's meaning -- a real, low-risk touch,
// consistent with how every other enum-shaped column in this file renders.
const RATING_VALUES = [
  { value: 1, label: '1 star' },
  { value: 2, label: '2 stars' },
  { value: 3, label: '3 stars' },
  { value: 4, label: '4 stars' },
  { value: 5, label: '5 stars' },
];

const INVENTORY_ACTIVE_VALUES = [
  { value: true, label: 'Active' },
  { value: false, label: 'Inactive' },
];

// Phase 4 -- flash_inventory (ADMIN_PANEL_AUDIT_AND_VISION.md §3: "real
// admin CRUD already exists (inventoryRoutes.js), UI not yet built"). Unlike
// every other resource in this file, inventory is something an admin is
// genuinely expected to actively edit, not a read-only historical record --
// so new/edit stay enabled (real forms, real column writes -- sizes/
// stock_by_size are real JSONB columns, confirmed mapped to AdminJS's
// built-in 'key-value' editor type, not raw text). What they must NOT skip:
// inventoryController.js's addProduct/updateStock both call
// clearCache('cache:*/inventory*') after writing -- confirmed by reading
// Inventory.js/inventoryController.js directly -- so a customer-facing
// stale-cache bug is the real risk of using AdminJS's generic new/edit
// without this. This after-hook replicates that one real side effect
// without duplicating the rest of the controller's logic.
async function clearInventoryCacheAfter(response) {
  await clearCache('cache:*/inventory*');
  return response;
}

// Phase 3 (ADMIN_PANEL_AUDIT_AND_VISION.md §1.4/§3) -- SOS alert queue
// helpers. triggered_by_id is genuinely polymorphic -- sos_alerts'
// triggered_by_role has a real CHECK constraint of ('user','driver')
// (confirmed in migrate.js), so unlike order_cancellations.cancelled_by_id
// (always a user), this needs to check EACH row's own role before deciding
// which table to look the name up in. Applied to `list` only, matching the
// same convention as attachUserNames elsewhere in this file.
async function attachTriggeredByName(response) {
  const records = response.records;
  if (!Array.isArray(records) || records.length === 0) return response;
  const userIds = records.filter((r) => r.params?.triggered_by_role === 'user').map((r) => r.params.triggered_by_id).filter(Boolean);
  const driverIds = records.filter((r) => r.params?.triggered_by_role === 'driver').map((r) => r.params.triggered_by_id).filter(Boolean);
  const [userRows, driverRows] = await Promise.all([
    userIds.length ? pgPool.query('SELECT id, name, phone FROM public.users WHERE id = ANY($1::uuid[])', [userIds]) : { rows: [] },
    driverIds.length ? pgPool.query('SELECT id, name, phone FROM drivers WHERE id = ANY($1::uuid[])', [driverIds]) : { rows: [] },
  ]);
  const byId = new Map([...userRows.rows, ...driverRows.rows].map((p) => [p.id, p]));
  records.forEach((r) => {
    const rawId = r.params?.triggered_by_id;
    const person = rawId && byId.get(rawId);
    if (person && r.params && person.name) {
      r.params.triggered_by_id = person.phone ? `${person.name} — ${person.phone}` : person.name;
    }
  });
  return response;
}

// acknowledged_by is always a real admins.id (set by the acknowledge action
// below) -- not polymorphic, so this is a plain single-table lookup, same
// shape as attachUserNames.
async function attachAcknowledgedByName(response) {
  const records = response.records;
  if (!Array.isArray(records) || records.length === 0) return response;
  const ids = [...new Set(records.map((r) => r.params?.acknowledged_by).filter(Boolean))];
  if (ids.length === 0) return response;
  const { rows } = await pgPool.query('SELECT id, name FROM admins WHERE id = ANY($1::uuid[])', [ids]);
  const byId = new Map(rows.map((a) => [a.id, a]));
  records.forEach((r) => {
    const rawId = r.params?.acknowledged_by;
    const admin = rawId && byId.get(rawId);
    if (admin && r.params) r.params.acknowledged_by = admin.name;
  });
  return response;
}

// Virtual richtext field (same mechanism as the driver-documents screen --
// AdminJS's own decorateVirtualProperties, no low-level property hacking).
// Applied to both list and show -- unlike the customer/driver-name fields
// above, this doesn't hide or replace any real column (lat/lng stay exactly
// as they are), so there's no "keep the raw value in show" tension to
// balance here -- an admin scanning the queue should be able to jump
// straight to a live location without opening each row individually.
function attachLocationLink(response) {
  function addLink(record) {
    if (!record?.params) return;
    const { lat, lng } = record.params;
    record.params.location_link = (lat != null && lng != null)
      ? `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Open live location in Google Maps</a>`
      : '<p>No location data was provided.</p>';
  }
  addLink(response.record);
  if (Array.isArray(response.records)) response.records.forEach(addLink);
  return response;
}

// @adminjs/sql auto-detects the user_id foreign key on orders/return_requests
// and tries to populate it as a reference to a "users" resource — found
// live: both threw 'There are no resources with given id: "users"' from
// AdminJS's internal reference populator, since users was never registered.
// Registering users to fix this turned out not to work either: db.tables()
// (confirmed directly, not assumed) never includes "users" at all — 46
// tables discovered, users absent — apparently dropped by the adapter's own
// introspection, for a reason not worth chasing further into a third-party
// adapter's internals.
//
// The real, root-level fix: PropertyDecorator.referenceName() is
// `options.reference || property.reference()` — an OR-fallback, so passing
// `reference: null` through resource options (tried first) can never
// suppress an already-auto-detected reference, since null is falsy and
// always falls through to the same adapter-detected value regardless of
// what's passed in options. property.reference() reads directly from
// Property._referencedTable (@adminjs/sql's Property.js) — a plain,
// ordinary JS instance property, not a real private field (TypeScript's
// `private` doesn't survive to compiled JS) — so mutating it directly,
// before the resource is ever handed to AdminJS's constructor, is the one
// approach that actually reaches the value reference() reads from.
//
// FOUND LIVE, MISSED THE FIRST TIME: nulling _referencedTable alone stops
// the backend populator from crashing, but the frontend still rendered a
// broken "property: user_id does not have a reference" error box in the
// list view. Root cause, confirmed by reading postgres.parser.js directly:
// `type: column.referenced_table ? 'reference' : getColumnType(...)` is
// set once at construction, independent of _referencedTable — so the
// property's type() still reported 'reference' regardless, and the
// frontend picks its rendering component from type(), not from
// reference(). type() reads from BaseProperty._type (adminjs core,
// base-property.js) — same plain-JS-property situation, same fix: also
// override that directly, not just the adapter-level reference field.
//
// FOUND LIVE AGAIN, missed a second time (flagged_accounts, Phase 3):
// .find() only mutates the FIRST property with a matching name -- but a
// column that carries BOTH a UNIQUE constraint and a REFERENCES constraint
// (flagged_accounts.user_id: `UUID NOT NULL REFERENCES users(id) ... UNIQUE`
// -- unlike every other user_id column in this file, which is REFERENCES-only,
// no UNIQUE) makes @adminjs/sql's own introspection enumerate that column
// TWICE, producing two separate Property objects with the identical name
// 'user_id' -- confirmed directly by logging resourceMetadata.properties'
// names for this exact table, not assumed. .find() silently left the
// second, still-broken duplicate in place, which is exactly the one
// populator.js's getFlattenProperties() iterated onto and crashed on ("There
// are no resources with given id: users"). Switched to .filter()+.forEach()
// so every matching property gets fixed, not just the first -- correct
// regardless of whether a given column happens to duplicate like this.
function suppressReference(resourceMetadata, propertyName) {
  resourceMetadata.properties
    .filter((p) => p.name() === propertyName)
    .forEach((prop) => {
      prop._referencedTable = null;
      prop._type = 'string';
    });
  return resourceMetadata;
}

// Refactored out of mountAdminPanel (chronological-ordering pass) so it's
// independently testable without booting the full Express app/session --
// adminChronologicalSort.test.js imports this directly, builds its own `db`
// adapter against the same DATABASE_URL, and asserts every resource this
// function returns has a real options.sort set via withChronologicalDefaults.
// This is the enforcement mechanism §1 asked for: a resource added here
// without going through withChronologicalDefaults has no `sort` key and
// fails that test, the same shape adminCoverage.test.js already uses for
// table-visibility decisions.
function buildResources(db) {
  return [
      {
        resource: db.table('drivers'),
        options: withChronologicalDefaults({
          // titleProperty controls two things at once, both confirmed by
          // reading resource-decorator.js directly: (1) which column AdminJS
          // treats as this resource's "title" in its own breadcrumbs, and
          // (2) — the part that matters here — what text ANY reference to
          // this resource displays elsewhere (orders.driver_id,
          // return_requests.driver_id). Without this, AdminJS falls back to
          // the first property (the raw `id` UUID) as the title, so every
          // reference to a driver would show a bare UUID as its link text.
          titleProperty: 'name',
          // Explicit column set/order for the list view — real, human-facing
          // fields first, raw UUID (`id`) and other technical fields (push
          // tokens, lat/lng, paystack codes) omitted entirely from the list.
          // Nothing here removes them from the detail view — `showProperties`
          // is left at its default (every real column), so raw IDs and every
          // other field stay available to anyone who opens a driver's detail
          // page, per the founder's explicit instruction.
          listProperties: ['name', 'email', 'phone', 'status', 'vehicle_type', 'rating', 'created_at'],
          // isVisible: false only hides the field in the rendered UI — confirmed
          // live: the raw list API response still included the real bcrypt hash
          // in plain text over the wire. AdminJS's own documented fix for
          // exactly this is an `after` hook that deletes the field from the
          // response data itself, on every action that can return a record
          // (list/show/edit) — both layers together, not isVisible alone.
          properties: {
            password_hash: { isVisible: false },
            // Found while adding the new resources below, not part of the
            // original proof-of-concept: AdminJS's generic `edit` action
            // does a raw column UPDATE with no business-logic awareness at
            // all — an admin could change a driver's status directly through
            // it, completely bypassing Admin.updateDriverStatus() and the
            // admin_actions audit log Phase 0 just built. Hiding the field
            // from the edit form (not just making the whole resource
            // read-only, since name/phone edits are harmless) forces status
            // changes through the two real actions below instead.
            status: { isVisible: { edit: false }, availableValues: DRIVER_STATUS_VALUES },
            // Virtual — no such column on drivers. show-only: the driver
            // document-review screen the founder asked for, populated by
            // attachDriverDocuments below.
            documents: { type: 'richtext', isVisible: { list: false, show: true, edit: false, filter: false } },
            // Virtual — wallet/payout at-a-glance summary (Phase 2), populated
            // by attachWalletSummary below.
            wallet_summary: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
          },
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive, attachDriverDocuments, attachWalletSummary] },
            edit: { after: [stripSensitive] },
            approveDriver: {
              actionType: 'record',
              component: false,
              guard: 'Approve this driver?',
              // Found live (same class of gap already fixed once for
              // list/show/edit): a custom action's response isn't covered
              // by those hooks automatically — this leaked the real bcrypt
              // hash in plain text over the wire until caught here.
              after: [stripSensitive],
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Admin.updateDriverStatus(record.id(), 'approved');
                AdminAction.log(currentAdmin.id, 'driver_status_update', 'drivers', record.id(), { status: 'approved', via: 'admin_panel' });
                record.set('status', 'approved');
                return { record: record.toJSON(currentAdmin), notice: { message: 'Driver approved.', type: 'success' } };
              },
            },
            rejectDriver: {
              actionType: 'record',
              component: false,
              guard: 'Reject this driver?',
              after: [stripSensitive],
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Admin.updateDriverStatus(record.id(), 'rejected');
                AdminAction.log(currentAdmin.id, 'driver_status_update', 'drivers', record.id(), { status: 'rejected', via: 'admin_panel' });
                record.set('status', 'rejected');
                return { record: record.toJSON(currentAdmin), notice: { message: 'Driver rejected.', type: 'success' } };
              },
            },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.drivers),
      },
      {
        resource: suppressReference(db.table('orders'), 'user_id'),
        options: withChronologicalDefaults({
          // Same reasoning as drivers' titleProperty above: makes every
          // reference TO orders (order_cancellations.order_id,
          // return_requests.order_id) display the real, human-facing order
          // number instead of a raw UUID, and makes order_number (not `id`)
          // the primary/title column for orders itself.
          titleProperty: 'order_number',
          listProperties: ['order_number', 'user_id', 'driver_id', 'status', 'payment_method', 'total', 'created_at'],
          properties: {
            cash_otp_hash: { isVisible: false },
            cash_otp_plain: { isVisible: false },
            status: { availableValues: ORDER_STATUS_VALUES },
            payment_method: { availableValues: [{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }] },
            // Virtual — none of these four are real columns on orders. All
            // show-only: the unified order-detail view (customer/driver
            // contact, inline return/cancellation), populated by
            // attachOrderDetailContext below.
            customer_contact: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
            driver_contact: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
            return_status: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
            cancellation_details: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
            // Virtual -- the dispute-review screen (Phase 2): real signed
            // pickup/dropoff photos + the order's real chat thread,
            // populated by attachDisputeContext below.
            photos: { type: 'richtext', isVisible: { list: false, show: true, edit: false, filter: false } },
            order_chat: { type: 'textarea', isVisible: { list: false, show: true, edit: false, filter: false } },
          },
          actions: {
            // attachUserNames only on `list` — show intentionally keeps the
            // raw user_id UUID untouched, per the founder's explicit ask to
            // keep raw IDs available in the detail view. attachOrderDetailContext
            // is additive on top of that -- it doesn't touch user_id/driver_id
            // at all, it adds the four virtual fields above alongside them.
            list: { after: [stripSensitive, attachUserNames('user_id')] },
            show: { after: [stripSensitive, attachOrderDetailContext, attachDisputeContext] },
            // Read-only — orders are created and mutated through the real
            // app/driver flows and the order state machine
            // (orderStateMachineService.js), never by an admin editing a row
            // directly. Phase 1's own scope was "a real order list with
            // filtering," not order mutation.
            edit: { isAccessible: false },
            new: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.orders),
      },
      {
        resource: db.table('order_cancellations'),
        options: withChronologicalDefaults({
          listProperties: [
            'order_id', 'cancelled_by_role', 'cancelled_by_id', 'reason',
            'refund_mode', 'store_amount', 'driver_amount', 'created_at',
          ],
          properties: {
            refund_mode: { availableValues: REFUND_MODE_VALUES },
            cancelled_by_role: { availableValues: CANCELLED_BY_ROLE_VALUES },
          },
          // Fully read-only — this table is a record of what already
          // happened (real money already split at cancellation time,
          // orderController.cancelOrder), not something an admin edits.
          actions: {
            // cancelled_by_id is only ever a real users.id when
            // cancelled_by_role is 'user' (confirmed by reading the actual
            // INSERT statements in orderController.js/server.js — the
            // 'system' auto-cancel path never sets this column) —
            // attachUserNames is null-safe, so it's fine to apply
            // unconditionally. stripSensitive covers the populated order_id
            // -> orders sub-record, which otherwise carries orders'
            // cash_otp_hash/cash_otp_plain along for the ride.
            list: { after: [attachUserNames('cancelled_by_id'), stripSensitive] },
            show: { after: [stripSensitive] },
            edit: { isAccessible: false },
            new: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.order_cancellations),
      },
      {
        resource: suppressReference(db.table('return_requests'), 'user_id'),
        options: withChronologicalDefaults({
          listProperties: ['order_id', 'user_id', 'driver_id', 'status', 'reason', 'refund_amount', 'credit_amount', 'created_at'],
          properties: {
            status: { availableValues: RETURN_STATUS_VALUES },
          },
          actions: {
            // Same as orders — attachUserNames only on `list`, show keeps
            // the raw user_id UUID for anyone who needs it. stripSensitive
            // covers the populated driver_id -> drivers (password_hash) and
            // order_id -> orders (cash_otp_hash/cash_otp_plain) sub-records.
            list: { after: [attachUserNames('user_id'), stripSensitive] },
            show: { after: [stripSensitive] },
            // Generic new/edit/delete disabled — every real mutation on a
            // return goes through the three actions below, which call the
            // exact same Return.js model methods the JSON API's
            // returnController.js already uses (approveReturn creates a
            // real reverse-delivery order; finalizeRefund calls
            // RefundService for a real Paystack refund) — this file wraps
            // that existing logic, it does not reimplement it.
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
            approveReturn: {
              actionType: 'record',
              component: false,
              guard: 'Approve this return? This dispatches a real reverse-delivery order.',
              isAccessible: ({ record }) => record.param('status') === 'requested',
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Return.approveReturn(record.id(), currentAdmin.id);
                AdminAction.log(currentAdmin.id, 'return_approve', 'return_requests', record.id());
                record.set('status', 'approved');
                return { record: record.toJSON(currentAdmin), notice: { message: 'Return approved — reverse-delivery order dispatched.', type: 'success' } };
              },
            },
            rejectReturn: {
              actionType: 'record',
              component: false,
              guard: 'Reject this return?',
              isAccessible: ({ record }) => ['requested', 'approved'].includes(record.param('status')),
              // PROTOTYPE NOTE: the old hand-written admin.js page had a
              // free-text rejection-reason modal. A generic reason here
              // instead of a real text-input form is a deliberate, honest
              // scope cut for this pass — a real text input needs a custom
              // AdminJS frontend component (its own bundling/registration
              // step, not proven yet in this setup), not just a backend
              // handler. Return.rejectReturn's rejectionReason parameter is
              // already nullable, so this isn't a data-model gap, only a
              // UI one — worth a real follow-up, not silently dropped.
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Return.rejectReturn(record.id(), currentAdmin.id, 'Rejected via admin panel');
                AdminAction.log(currentAdmin.id, 'return_reject', 'return_requests', record.id());
                record.set('status', 'rejected');
                return { record: record.toJSON(currentAdmin), notice: { message: 'Return rejected.', type: 'success' } };
              },
            },
            finalizeReturnRefund: {
              actionType: 'record',
              component: false,
              guard: "Finalize this refund? This charges the customer's original payment method for real.",
              isAccessible: ({ record }) => record.param('status') === 'approved',
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Return.finalizeRefund(record.id(), currentAdmin.id);
                AdminAction.log(currentAdmin.id, 'return_finalize_refund', 'return_requests', record.id());
                record.set('status', 'refunded');
                return { record: record.toJSON(currentAdmin), notice: { message: 'Refund finalized.', type: 'success' } };
              },
            },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.return_requests),
      },
      {
        // Phase 3's own top-priority item (ADMIN_PANEL_AUDIT_AND_VISION.md
        // §1.4/§3): "the single most safety-relevant gap in this whole
        // audit" -- before this, a triggered SOS alert only ever reached a
        // live Socket.io connection to the 'admin' room; missed entirely if
        // nobody had the panel open at that exact moment. order_id is a
        // real FK to orders -- automatically shows the real order_number as
        // a working reference link, same as every other order_id column in
        // this file, no extra code needed.
        resource: db.table('sos_alerts'),
        options: withChronologicalDefaults({
          listProperties: [
            'order_id', 'triggered_by_role', 'triggered_by_id', 'location_link',
            'acknowledged_at', 'acknowledged_by', 'created_at',
          ],
          properties: {
            triggered_by_role: { availableValues: TRIGGERED_BY_ROLE_VALUES },
            // Virtual -- no such column on sos_alerts.
            location_link: { type: 'richtext', isVisible: { list: true, show: true, edit: false, filter: false } },
          },
          actions: {
            list: { after: [attachTriggeredByName, attachAcknowledgedByName, attachLocationLink, stripSensitive] },
            show: { after: [attachLocationLink, stripSensitive] },
            // Fully read-only except for the one real action below -- this
            // table is either an active emergency or a record of one that
            // already happened, not something an admin free-edits.
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
            acknowledge: {
              actionType: 'record',
              component: false,
              guard: 'Acknowledge this SOS alert? This marks it as handled by you.',
              // Only actionable while genuinely unacknowledged -- matches
              // SosAlert.acknowledge's own WHERE acknowledged_at IS NULL
              // guard, so the button disappears once someone has already
              // handled it instead of inviting a second, meaningless click.
              isAccessible: ({ record }) => !record.param('acknowledged_at'),
              after: [stripSensitive],
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                const updated = await SosAlert.acknowledge(record.id(), currentAdmin.id);
                if (!updated) {
                  return { record: record.toJSON(currentAdmin), notice: { message: 'Already acknowledged by someone else.', type: 'error' } };
                }
                AdminAction.log(currentAdmin.id, 'sos_acknowledge', 'sos_alerts', record.id());
                record.set('acknowledged_at', updated.acknowledged_at);
                record.set('acknowledged_by', currentAdmin.id);
                return { record: record.toJSON(currentAdmin), notice: { message: 'SOS alert acknowledged.', type: 'success' } };
              },
            },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.sos_alerts),
      },
      // Phase 2 (§3/§4.3) -- the four tables backing driver wallet/payout
      // visibility. Each is a live balance/ledger/transaction record of
      // real money movement, not something an admin hand-edits -- fully
      // read-only, same reasoning as order_cancellations. driver_id
      // references drivers everywhere below and works automatically
      // (drivers.titleProperty is already 'name', set earlier in this
      // file) -- no extra code needed for that part.
      {
        resource: db.table('driver_wallets'),
        options: withChronologicalDefaults({
          listProperties: ['driver_id', 'wallet_balance', 'pending_balance', 'cash_commission_debt', 'unpaid_cash_deliveries', 'updated_at'],
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive] },
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.driver_wallets),
      },
      {
        resource: db.table('driver_wallet_ledger'),
        options: withChronologicalDefaults({
          listProperties: ['driver_id', 'order_id', 'entry_type', 'amount', 'note', 'created_at'],
          properties: {
            entry_type: { availableValues: WALLET_LEDGER_ENTRY_TYPE_VALUES },
          },
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive] },
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.driver_wallet_ledger),
      },
      {
        resource: db.table('driver_payout_requests'),
        options: withChronologicalDefaults({
          listProperties: ['driver_id', 'amount', 'status', 'created_at', 'updated_at'],
          properties: {
            status: { availableValues: PAYOUT_REQUEST_STATUS_VALUES },
          },
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive] },
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.driver_payout_requests),
      },
      {
        // The real Paystack transfer trail (Addendum 1 §4.3: "the one cost
        // line with a genuinely real, auditable multi-table trail already").
        resource: db.table('payout_transactions'),
        options: withChronologicalDefaults({
          listProperties: ['driver_id', 'amount', 'status', 'reference', 'created_at', 'completed_at'],
          properties: {
            status: { availableValues: PAYOUT_TRANSACTION_STATUS_VALUES },
          },
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive] },
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.payout_transactions),
      },
      {
        // Phase 3 (§3's original text: "driver-rating trends (aggregation
        // query over existing rating data)"). order_id/driver_id are real
        // FKs to already-registered resources and work automatically
        // (orders.titleProperty='order_number', drivers.titleProperty='name'
        // -- both set earlier in this file). user_id is the same broken-
        // reference situation as everywhere else user_id appears (users
        // can't be registered -- see suppressReference's own comment above)
        // -- same fix.
        resource: suppressReference(db.table('driver_ratings'), 'user_id'),
        options: withChronologicalDefaults({
          listProperties: ['order_id', 'driver_id', 'user_id', 'rating', 'comment', 'created_at'],
          properties: {
            rating: { availableValues: RATING_VALUES },
          },
          actions: {
            // attachUserNames only on list -- show keeps the raw user_id
            // UUID, same convention as every other resource in this file.
            // stripSensitive covers the populated driver_id -> drivers
            // (password_hash) and order_id -> orders (cash_otp fields)
            // sub-records.
            list: { after: [attachUserNames('user_id'), stripSensitive] },
            show: { after: [stripSensitive] },
            // Fully read-only -- a real historical record of what a
            // customer actually rated, never admin-edited.
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.driver_ratings),
      },
      {
        // Phase 3 (§2's original text: "a flagged-accounts view
        // (flagged_for_cash_abuse, cash_refusal_count -- trivial new
        // query)"). Real columns already written to by paymentController.js,
        // never surfaced anywhere for a human to see until now. Synced from
        // users into this small, uniquely-named table by server.js's new
        // cron job (every 15 min) -- see migrate.js v20's comment for why
        // users itself can't be a resource directly.
        resource: suppressReference(db.table('flagged_accounts'), 'user_id'),
        options: withChronologicalDefaults({
          listProperties: ['user_id', 'flagged_for_cash_abuse', 'cash_refusal_count', 'synced_at'],
          actions: {
            // attachUserNames only on list, same convention as everywhere
            // else. stripSensitive is a defensive no-op today (user_id's
            // reference is suppressed, so there's no populated sub-record
            // to leak from) -- kept for the same forward-looking reason
            // it's applied everywhere else: a future reference added to
            // this resource should not have to remember to add this back.
            list: { after: [attachUserNames('user_id'), stripSensitive] },
            show: { after: [stripSensitive] },
            // Read-only -- a synced view of real flag state living on
            // users, not something an admin hand-edits here. Reviewing,
            // not managing, per the explicit ask.
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.flagged_accounts),
      },
      {
        resource: db.table('flash_inventory'),
        options: withChronologicalDefaults({
          listProperties: ['product_name', 'category', 'brand', 'price', 'is_active', 'created_at'],
          properties: {
            // cost_price is Flash's internal wholesale/margin data --
            // Inventory.js's own PUBLIC_COLUMNS already excludes it from
            // every public-facing read; hidden from the list here for the
            // same reason (still visible in show/edit -- an admin managing
            // stock legitimately needs to see and set it).
            cost_price: { isVisible: { list: false, show: true, edit: true, filter: false } },
            is_active: { isVisible: { edit: false }, availableValues: INVENTORY_ACTIVE_VALUES },
          },
          actions: {
            list: {},
            show: {},
            // Real forms, real writes -- see clearInventoryCacheAfter's own
            // comment for why the after-hook is required here, unlike every
            // other resource in this file.
            new: { after: [clearInventoryCacheAfter] },
            edit: { after: [clearInventoryCacheAfter] },
            // Generic delete would be a real, permanent DELETE FROM --
            // Inventory.deleteProduct is a soft delete (is_active=false),
            // matching this codebase's "never drop data unless explicitly
            // requested" rule. Disabled in favor of the real action below.
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
            deactivateProduct: {
              actionType: 'record',
              component: false,
              guard: 'Deactivate this product? It will stop showing to customers, but stays in the system.',
              isAccessible: ({ record }) => record.param('is_active') !== false,
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                await Inventory.deleteProduct(record.id());
                await clearCache('cache:*/inventory*');
                AdminAction.log(currentAdmin.id, 'inventory_delete_product', 'flash_inventory', record.id());
                record.set('is_active', false);
                return { record: record.toJSON(currentAdmin), notice: { message: 'Product deactivated.', type: 'success' } };
              },
            },
          },
        }, RESOURCE_TIMESTAMP_COLUMNS.flash_inventory),
      },
  ];
}

async function mountAdminPanel(app) {
  const AdminJSModule = require('adminjs');
  const AdminJS = AdminJSModule.default;
  const { ComponentLoader } = AdminJSModule;
  const { buildAuthenticatedRouter } = await import('@adminjs/express');
  const { Adapter, Database, Resource } = await import('@adminjs/sql');

  // FOUND LIVE while verifying the chronological-search work (real testing,
  // not assumed): @adminjs/sql's own Resource.prototype.filterQuery
  // (lib/Resource.js, confirmed by reading it directly) unconditionally
  // calls Knex's q.whereBetween(key, [from, to]) for any date/datetime
  // filter with an object value -- it never checks whether BOTH bounds are
  // actually present. An admin filtering by an open-ended range ("everything
  // after this date," from-only, or "everything before this date," to-only
  // -- exactly the kind of query real scale needs, not just a fixed window)
  // gets a genuine 500: Knex's whereBetween throws "Undefined binding(s)
  // detected" the moment either bound is undefined. Confirmed live: a full
  // range (both from and to) returns 200 with the correct filtered total;
  // from-only or to-only both throw.
  //
  // Same technique as suppressReference above (a runtime prototype
  // patch, not a node_modules file edit) -- survives npm install/npm ci
  // untouched, and fixes this once, here, for every current and future
  // resource's date/datetime filters, not per-resource. Falls back to a
  // plain >=/<= comparison when only one bound is given; unchanged
  // otherwise (a real range still goes through whereBetween, and every
  // other filter type -- string ILIKE, availableValues equality, plain
  // equality -- is copied verbatim from the original method).
  const originalFilterQuery = Resource.prototype.filterQuery;
  Resource.prototype.filterQuery = function patchedFilterQuery(filter) {
    const knex = this.schemaName
      ? this.knex(this.tableName).withSchema(this.schemaName)
      : this.knex(this.tableName);
    const q = knex;
    if (!filter) return q;
    const { filters } = filter;
    Object.entries(filters ?? {}).forEach(([key, f]) => {
      if (typeof f.value === 'object' && ['date', 'datetime'].includes(f.property.type())) {
        const { from, to } = f.value;
        if (from != null && to != null) {
          q.whereBetween(key, [from, to]);
        } else if (from != null) {
          q.where(key, '>=', from);
        } else if (to != null) {
          q.where(key, '<=', to);
        }
        // Neither bound present: no-op, matching the original method's own
        // (undocumented) behavior of contributing nothing to the query for
        // an empty filter value.
      } else if (f.property.type() === 'string' && !f.property.availableValues()) {
        if (this.dialect === 'postgresql') {
          q.whereILike(key, `%${f.value}%`);
        } else {
          q.whereLike(key, `%${f.value}%`);
        }
      } else {
        q.where(key, f.value);
      }
    });
    return q;
  };
  // Referenced so a future reader can diff this against the real original
  // if @adminjs/sql ever fixes this upstream and the patch should be
  // dropped -- not dead code.
  void originalFilterQuery;

  AdminJS.registerAdapter({ Database, Resource });

  // FOUND while wiring in the real financial numbers below: AdminJS's own
  // default dashboard (default-dashboard.js, confirmed by reading it
  // directly) is a static "welcome to AdminJS" marketing page -- it never
  // renders anything a dashboard.handler returns. That means every number
  // getStats()/getFinancials() compute was already real and correct, but
  // only reachable by calling GET /admin-panel/api/dashboard directly --
  // nothing showed it in the actual panel a founder opens. This is the
  // first real custom AdminJS component in this codebase: registered here
  // via ComponentLoader, rendered by FinanceDashboard.jsx. react/react-dom
  // are already adminjs's own dependencies (confirmed in its package.json)
  // -- no new dependency added for this.
  const componentLoader = new ComponentLoader();
  const financeDashboardComponent = componentLoader.add(
    'FinanceDashboard',
    require('path').join(__dirname, 'adminComponents', 'FinanceDashboard.jsx'),
  );
  // Phase 4 -- individual user lookup and the Flash Fleet demand-cluster
  // view. Both are real AdminJS "pages" (AdminJSOptions.pages, confirmed
  // directly, not assumed), not resources -- neither is backed by a single
  // browsable table (user lookup is search-then-view; fleet clusters is a
  // computed aggregate), so the chronological-sort helper's "resource" model
  // genuinely doesn't apply to either -- a page has no list/sort concept at
  // all, confirmed by reading AdminPage's own type.
  const userLookupComponent = componentLoader.add(
    'UserLookup',
    path.join(__dirname, 'adminComponents', 'UserLookup.jsx'),
  );
  const fleetClustersComponent = componentLoader.add(
    'FleetClusters',
    path.join(__dirname, 'adminComponents', 'FleetClusters.jsx'),
  );

  const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
  const db = await new Adapter('postgresql', {
    connectionString: process.env.DATABASE_URL,
    database: dbName,
  }).init();

  const admin = new AdminJS({
    rootPath: ADMIN_PANEL_PATH,
    componentLoader,
    // Real, documented AdminJS branding options (adminjs-options.interface.d.ts's
    // BrandingOptions -- confirmed directly, not assumed) -- no DOM hacking,
    // no patched compiled output. Deliberately restrained, per the founder's
    // explicit ask for "premium but simple, not too much": the real Flash
    // logo + name replacing AdminJS's own, one accent-color override (the
    // same amber already used as Flash's own highlight color throughout
    // both mobile apps -- confirmed live in flash-driver-app/app/driver/dashboard.js
    // and flash-user-app/screens/SplashScreen.js, not guessed), and turning
    // off AdminJS's own "made with love" self-promotion mark. Every other
    // color/spacing/font default is left untouched on purpose.
    branding: {
      companyName: 'Flash',
      logo: ADMIN_LOGO_URL,
      favicon: ADMIN_LOGO_URL,
      withMadeWithLove: false,
      theme: {
        colors: {
          primary100: '#f59e0b',
        },
      },
    },
    // FOUND LIVE via real screenshots (not caught by the earlier HTML-only
    // verification pass): AdminJS's own logo caps (login: max-width 200px,
    // sidebar: max-width 170px) only constrain width, not height. Against
    // the square source image that meant it rendered up to 200x200/170x170
    // in practice -- a large square block, not a compact header mark.
    // assets.styles is AdminJS's own real, documented mechanism for
    // appending a stylesheet to <head> (AdminJSOptions.assets, confirmed
    // directly) -- used here instead of any DOM/compiled-output hacking to
    // force a deterministic, genuinely small logo size in both spots. See
    // admin-branding.css for the exact rule and why alt="Flash" is the
    // selector.
    assets: {
      styles: [`${ADMIN_PANEL_PATH}/assets/admin-branding.css`],
    },
    // loginPath/logoutPath do NOT derive from rootPath — confirmed directly
    // against adminjs's own type definitions (adminjs-options.interface.d.ts),
    // not assumed. Left unset, they default to /admin/login and /admin/logout
    // regardless of rootPath — found live: the login page redirected to
    // /admin/login (a 404, since nothing is mounted there) instead of staying
    // under /admin-panel.
    loginPath: `${ADMIN_PANEL_PATH}/login`,
    logoutPath: `${ADMIN_PANEL_PATH}/logout`,
    resources: buildResources(db),
    // component registered above (financeDashboardComponent) -- see the
    // comment by componentLoader's construction for why this replaced the
    // silent-no-op default dashboard. handler still returns real, correct
    // data via GET /admin-panel/api/dashboard, same as before -- now
    // actually rendered, plus the real financial picture (Admin.getFinancials(),
    // ADMIN_PANEL_AUDIT_AND_VISION.md §4.3), not just operational stats.
    dashboard: {
      component: financeDashboardComponent,
      handler: async () => {
        const [stats, financials, statusBreakdown, dailyTrends, ratingTrend] = await Promise.all([
          Admin.getStats(),
          Admin.getFinancials(),
          pgPool.query(
            `SELECT status, COUNT(*) as count FROM orders
             WHERE status NOT IN ('completed', 'cancelled')
             GROUP BY status ORDER BY count DESC`,
          ),
          Admin.getDailyTrends(14),
          Admin.getDriverRatingTrend(14),
        ]);
        return {
          ...stats,
          financials,
          activeOrdersByStatus: statusBreakdown.rows.map((r) => ({
            status: r.status,
            count: parseInt(r.count, 10),
          })),
          dailyTrends,
          ratingTrend,
        };
      },
    },
    pages: {
      userLookup: {
        label: 'User Lookup',
        icon: 'User',
        component: userLookupComponent,
        // request.query -- the same real object a dashboard handler
        // receives, confirmed via PageHandler's own type
        // (adminjs-options.interface.d.ts: (request, response, context) =>
        // Promise<any>) -- carries whatever the frontend's ApiClient.getPage
        // call passed as `params`.
        handler: async (request) => {
          const { q, userId } = request.query || {};
          if (userId) {
            return { profile: await Admin.getUserProfile(userId) };
          }
          if (q) {
            return { results: await Admin.searchUsers(q) };
          }
          return {};
        },
      },
      fleetClusters: {
        label: 'Flash Fleet Demand',
        icon: 'TrendingUp',
        component: fleetClustersComponent,
        // Fleet.getClusters() is the real, existing read-only query
        // (fleetController.js's own GET /api/fleet/clusters uses the exact
        // same method) -- deliberately not runFleetIntelligence(), which
        // ALSO emits a real 'fleet_alert' socket event per cluster as a
        // side effect; a page a founder can load repeatedly just to look
        // must never re-trigger that alert each time.
        handler: async () => ({ clusters: await Fleet.getClusters() }),
      },
    },
  });

  // Reuses the exact same check as the real /api/admin/login (Admin.findByEmail
  // + bcrypt.compare against the real admins table) — one source of truth for
  // admin credentials, not a second parallel login. What differs is only the
  // session mechanism: this is a cookie session for AdminJS's own server-rendered
  // UI, not the JWT bearer token the JSON API uses.
  const authenticate = async (email, password) => {
    const adminRow = await Admin.findByEmail(email);
    if (!adminRow) return null;
    const valid = await bcrypt.compare(password, adminRow.password_hash);
    if (!valid) return null;
    return { id: adminRow.id, email: adminRow.email, name: adminRow.name, role: adminRow.role };
  };

  // PROTOTYPE NOTE: reusing ADMIN_JWT_SECRET as the session-cookie signing
  // secret for now, to avoid asking for yet another env var before this has
  // even been looked at in a browser. Worth its own dedicated secret once
  // Phase 1 is fully built out, not before.
  const router = buildAuthenticatedRouter(
    admin,
    {
      cookiePassword: process.env.ADMIN_JWT_SECRET,
      authenticate,
      maxRetries: 5,
    },
    null,
    {
      secret: process.env.ADMIN_JWT_SECRET,
      resave: false,
      saveUninitialized: false,
    },
  );

  // Mounted onto the placeholder router createApp() registered before the
  // global body parser and before notFound/errorHandler (server.js) — not
  // directly onto `app` — since by the time this async function finishes,
  // both would otherwise intercept every request here first (found live:
  // AdminJS's own express-formidable body parsing conflicts with the global
  // express.json() the same way webhooks already had to solve this once).
  const adminPanelRouter = app.locals.adminPanelRouter;

  // Serves the real Flash logo referenced by ADMIN_LOGO_URL above -- a
  // plain static file, same origin as everything else under this mount.
  adminPanelRouter.use('/assets', express.static(path.join(__dirname, 'adminAssets')));

  // Scoped CSP disable — only for this mount path. AdminJS ships its own
  // bundled React frontend (inline scripts/styles) that Helmet's default
  // CSP blocks; removing the header only here leaves the strict default
  // CSP untouched for every other route in the app.
  adminPanelRouter.use((req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
  });
  adminPanelRouter.use(router);

  console.log(`[AdminPanel] Mounted at ${ADMIN_PANEL_PATH} (drivers, orders, order_cancellations, return_requests, sos_alerts, driver_wallets, driver_wallet_ledger, driver_payout_requests, payout_transactions, driver_ratings, flagged_accounts, flash_inventory)`);
}

module.exports = { mountAdminPanel, ADMIN_PANEL_PATH, buildResources };
