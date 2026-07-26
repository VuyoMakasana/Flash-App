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

const bcrypt = require('bcryptjs');
const Admin = require('./models/Admin');
const AdminAction = require('./models/AdminAction');
const Return = require('./models/Return');
// Named pgPool, deliberately not db — mountAdminPanel already has a local
// `db` variable for the @adminjs/sql adapter; reusing that name here for an
// unrelated plain pg Pool would be exactly the kind of mistake worth
// avoiding on purpose, not by luck.
const pgPool = require('./config/database');

const ADMIN_PANEL_PATH = '/admin-panel';

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

async function mountAdminPanel(app) {
  const AdminJSModule = require('adminjs');
  const AdminJS = AdminJSModule.default;
  const { buildAuthenticatedRouter } = await import('@adminjs/express');
  const { Adapter, Database, Resource } = await import('@adminjs/sql');

  AdminJS.registerAdapter({ Database, Resource });

  const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
  const db = await new Adapter('postgresql', {
    connectionString: process.env.DATABASE_URL,
    database: dbName,
  }).init();

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
  function suppressReference(resourceMetadata, propertyName) {
    const prop = resourceMetadata.properties.find((p) => p.name() === propertyName);
    if (prop) {
      prop._referencedTable = null;
      prop._type = 'string';
    }
    return resourceMetadata;
  }

  const admin = new AdminJS({
    rootPath: ADMIN_PANEL_PATH,
    // loginPath/logoutPath do NOT derive from rootPath — confirmed directly
    // against adminjs's own type definitions (adminjs-options.interface.d.ts),
    // not assumed. Left unset, they default to /admin/login and /admin/logout
    // regardless of rootPath — found live: the login page redirected to
    // /admin/login (a 404, since nothing is mounted there) instead of staying
    // under /admin-panel.
    loginPath: `${ADMIN_PANEL_PATH}/login`,
    logoutPath: `${ADMIN_PANEL_PATH}/logout`,
    resources: [
      {
        resource: db.table('drivers'),
        options: {
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
          },
          actions: {
            list: { after: [stripSensitive] },
            show: { after: [stripSensitive] },
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
        },
      },
      {
        resource: suppressReference(db.table('orders'), 'user_id'),
        options: {
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
          },
          actions: {
            // attachUserNames only on `list` — show intentionally keeps the
            // raw user_id UUID untouched, per the founder's explicit ask to
            // keep raw IDs available in the detail view.
            list: { after: [stripSensitive, attachUserNames('user_id')] },
            show: { after: [stripSensitive] },
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
        },
      },
      {
        resource: db.table('order_cancellations'),
        options: {
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
        },
      },
      {
        resource: suppressReference(db.table('return_requests'), 'user_id'),
        options: {
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
        },
      },
    ],
    // No custom frontend component registered — that needs AdminJS's
    // component-loader/bundling system, unproven in this exact setup, and
    // not worth the added risk this late without a separately-verified
    // pass. This still returns real, correct data via
    // GET /admin-panel/api/dashboard (callable directly, and picked up by
    // AdminJS's own default dashboard view) — the getStats() numbers plus
    // the one new query Phase 1's own plan named explicitly: a live
    // active-orders-by-status breakdown.
    dashboard: {
      handler: async () => {
        const stats = await Admin.getStats();
        const statusBreakdown = await pgPool.query(
          `SELECT status, COUNT(*) as count FROM orders
           WHERE status NOT IN ('completed', 'cancelled')
           GROUP BY status ORDER BY count DESC`,
        );
        return {
          ...stats,
          activeOrdersByStatus: statusBreakdown.rows.map((r) => ({
            status: r.status,
            count: parseInt(r.count, 10),
          })),
        };
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

  // Scoped CSP disable — only for this mount path. AdminJS ships its own
  // bundled React frontend (inline scripts/styles) that Helmet's default
  // CSP blocks; removing the header only here leaves the strict default
  // CSP untouched for every other route in the app.
  adminPanelRouter.use((req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
  });
  adminPanelRouter.use(router);

  console.log(`[AdminPanel] Mounted at ${ADMIN_PANEL_PATH} (drivers, orders, order_cancellations, return_requests)`);
}

module.exports = { mountAdminPanel, ADMIN_PANEL_PATH };
