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
// { records: [{ params: {...} }] }, show/edit responses are { record: { params: {...} } }.
// Factory, not a single hardcoded field list — drivers needs password_hash
// stripped, orders needs the two cash_otp fields stripped, each resource
// gets its own instance of this rather than one shared, field-specific function.
function stripFields(fieldNames) {
  return function (response) {
    if (response.record?.params) {
      fieldNames.forEach((f) => delete response.record.params[f]);
    }
    if (Array.isArray(response.records)) {
      response.records.forEach((r) => {
        if (r.params) fieldNames.forEach((f) => delete r.params[f]);
      });
    }
    return response;
  };
}

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

  const stripPasswordHash = stripFields(['password_hash']);
  const stripCashOtp = stripFields(['cash_otp_hash', 'cash_otp_plain']);

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
  function suppressReference(resourceMetadata, propertyName) {
    const prop = resourceMetadata.properties.find((p) => p.name() === propertyName);
    if (prop) prop._referencedTable = null;
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
            status: { isVisible: { edit: false } },
          },
          actions: {
            list: { after: [stripPasswordHash] },
            show: { after: [stripPasswordHash] },
            edit: { after: [stripPasswordHash] },
            approveDriver: {
              actionType: 'record',
              component: false,
              guard: 'Approve this driver?',
              // Found live (same class of gap already fixed once for
              // list/show/edit): a custom action's response isn't covered
              // by those hooks automatically — this leaked the real bcrypt
              // hash in plain text over the wire until caught here.
              after: [stripPasswordHash],
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
              after: [stripPasswordHash],
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
          properties: {
            cash_otp_hash: { isVisible: false },
            cash_otp_plain: { isVisible: false },
          },
          actions: {
            list: { after: [stripCashOtp] },
            show: { after: [stripCashOtp] },
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
          // Fully read-only — this table is a record of what already
          // happened (real money already split at cancellation time,
          // orderController.cancelOrder), not something an admin edits.
          actions: {
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
          actions: {
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
