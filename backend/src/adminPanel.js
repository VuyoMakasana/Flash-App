'use strict';

// Admin panel Phase 1 — minimal proof-of-concept mount, ONE resource
// (drivers), deliberately not the full build. The point of this file right
// now is to prove the whole chain actually works end to end — ESM interop,
// the no-ORM SQL adapter against the real live database, real auth against
// the existing admins table, and scoped CSP — before Phase 1's remaining
// resources (orders, returns, cancellations) get built on top of it.
// See docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md, §3 Phase 1 + Addendum 3 §3.
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

const ADMIN_PANEL_PATH = '/admin-panel';

// Real observed response shape (confirmed live against the running mount,
// not assumed from AdminJS's own generic docs example): list responses are
// { records: [{ params: {...} }] }, show/edit responses are { record: { params: {...} } }.
function stripPasswordHash(response) {
  if (response.record?.params) {
    delete response.record.params.password_hash;
  }
  if (Array.isArray(response.records)) {
    response.records.forEach((r) => {
      if (r.params) delete r.params.password_hash;
    });
  }
  return response;
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
          },
          actions: {
            list: { after: [stripPasswordHash] },
            show: { after: [stripPasswordHash] },
            edit: { after: [stripPasswordHash] },
          },
        },
      },
    ],
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

  // Mounted onto the placeholder router createApp() registered before
  // notFound/errorHandler (server.js) — not directly onto `app` — since by
  // the time this async function finishes, app.use(notFound) has already
  // been registered and would otherwise intercept every request here first.
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

  console.log(`[AdminPanel] Mounted at ${ADMIN_PANEL_PATH} (proof-of-concept: drivers resource only)`);
}

module.exports = { mountAdminPanel, ADMIN_PANEL_PATH };
