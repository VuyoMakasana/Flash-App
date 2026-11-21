'use strict';

// v43 / FI-081 (#73): the backend must keep working with RLS on every table.
//
// CI and local integration tests connect as a SUPERUSER, which ignores RLS,
// so the other integration tests prove nothing about v43. This test creates a
// role shaped like production's backend role (postgres on Supabase: LOGIN,
// NOT superuser, BYPASSRLS, owner of every table in public), re-loads the
// real backend modules connected AS THAT ROLE, and runs the normal read and
// write paths and the cron functions against the RLS-enabled tables.
// A control role (not owner, no BYPASSRLS, but granted SELECT/INSERT) proves
// RLS really is on: it sees no rows and cannot insert. Everything is undone
// in afterAll (owners restored, rows deleted, roles dropped).
// Local test database only (tests/setup/testEnv.js refuses anything else).

// No real email or push notification may ever be sent from this test. File
// level, so the mocks also apply inside jest.isolateModules and to the
// services' lazy require('./emailService') calls.
jest.mock('../../src/services/emailService', () => ({ sendOrderEscalationEmail: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/notificationService', () => new Proxy({}, {
  get: (_t, prop) => (prop === 'then' || prop === '__esModule' ? undefined : jest.fn().mockResolvedValue()),
}));

const crypto = require('crypto');
const { Pool } = require('pg');

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const suffix = `${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
const BACKEND_ROLE = `flash_rls_backend_${suffix}`;
const OUTSIDER_ROLE = `flash_rls_outsider_${suffix}`;
const BACKEND_PW = crypto.randomBytes(18).toString('hex');
const OUTSIDER_PW = crypto.randomBytes(18).toString('hex');
const EMAIL = `rls-${suffix}@flash.invalid`;

function urlFor(role, password) {
  const u = new URL(process.env.DATABASE_URL);
  u.username = role;
  u.password = password;
  return u.toString();
}

d('backend role under RLS (production-shaped: owner, BYPASSRLS, not superuser)', () => {
  let admin;            // the test's own superuser connection: setup/cleanup only
  let originalOwners;   // [{ relname, owner }]
  let outsider;         // control connection
  let backend;          // the real backend modules, connected as BACKEND_ROLE
  const savedUrl = process.env.DATABASE_URL;
  const created = { userId: null, orderIds: [] };

  beforeAll(async () => {
    admin = new Pool({ connectionString: savedUrl });

    const rls = await admin.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE relrowsecurity)::int AS rls
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`,
    );
    if (rls.rows[0].n === 0 || rls.rows[0].rls !== rls.rows[0].n) {
      throw new Error(`v43 is not applied to the test database (RLS on ${rls.rows[0].rls}/${rls.rows[0].n} tables); run npm run test:db:migrate`);
    }

    originalOwners = (await admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`,
    )).rows;

    await admin.query(`CREATE ROLE ${BACKEND_ROLE} LOGIN NOSUPERUSER BYPASSRLS PASSWORD '${BACKEND_PW}'`);
    await admin.query(`CREATE ROLE ${OUTSIDER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${OUTSIDER_PW}'`);
    for (const { relname } of originalOwners) {
      await admin.query(`ALTER TABLE public.${relname} OWNER TO ${BACKEND_ROLE}`);
    }
    await admin.query(`GRANT SELECT, INSERT ON public.users, public.orders TO ${OUTSIDER_ROLE}`);
    outsider = new Pool({ connectionString: urlFor(OUTSIDER_ROLE, OUTSIDER_PW) });

    // Re-load the real backend modules with DATABASE_URL pointing at the
    // backend role, so config/database's pool connects as that role.
    process.env.DATABASE_URL = urlFor(BACKEND_ROLE, BACKEND_PW);
    jest.isolateModules(() => {
      backend = {
        pool: require('../../src/config/database'),
        User: require('../../src/models/User'),
        Order: require('../../src/models/Order'),
        Payment: require('../../src/models/Payment'),
        sm: require('../../src/services/orderStateMachineService'),
        email: require('../../src/services/emailService'),
      };
    });
    process.env.DATABASE_URL = savedUrl;
  });

  afterAll(async () => {
    try {
      if (created.orderIds.length) {
        await admin.query('DELETE FROM payments WHERE order_id = ANY($1::uuid[])', [created.orderIds]);
        await admin.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [created.orderIds]);
      }
      if (created.userId) await admin.query('DELETE FROM users WHERE id = $1', [created.userId]);
      await admin.query("DELETE FROM flagged_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'rls-%@flash.invalid')");
    } finally {
      if (backend) await backend.pool.end().catch(() => {});
      if (outsider) await outsider.end().catch(() => {});
      for (const { relname, owner } of originalOwners || []) {
        await admin.query(`ALTER TABLE public.${relname} OWNER TO "${owner}"`).catch(() => {});
      }
      await admin.query(`REVOKE ALL ON public.users, public.orders FROM ${OUTSIDER_ROLE}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${OUTSIDER_ROLE}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${BACKEND_ROLE}`).catch(() => {});
      await admin.end();
    }
  });

  test('the backend connection is the production-shaped role: not superuser, BYPASSRLS, owner of every table', async () => {
    const me = (await backend.pool.query(
      'SELECT current_user AS who, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
    )).rows[0];
    expect(me).toEqual({ who: BACKEND_ROLE, rolsuper: false, rolbypassrls: true });
    const notOwned = (await admin.query(
      `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace
          AND relkind IN ('r', 'p') AND pg_get_userbyid(relowner) <> $1`, [BACKEND_ROLE],
    )).rows[0].n;
    expect(notOwned).toBe(0);
  });

  test('users: create, find, update (User model)', async () => {
    const u = await backend.User.create({ name: 'RLS Probe', email: EMAIL, password: 'not-a-real-password-1', phone: null });
    created.userId = u.id;
    expect((await backend.User.findByEmail(EMAIL)).id).toBe(u.id);
    const updated = await backend.User.updateProfile(u.id, { name: 'RLS Probe Updated' });
    expect(updated.name).toBe('RLS Probe Updated');
  });

  test('orders and payments: insert, read with details, card payment in a FOR UPDATE transaction', async () => {
    const ins = await backend.pool.query(
      `INSERT INTO orders (user_id, order_number, subtotal, delivery_fee, total, status, payment_status, updated_at)
       VALUES ($1, $2, 100, 30, 130, 'pending_store_acceptance', 'pending', NOW() - INTERVAL '10 minutes'),
              ($1, $3, 100, 30, 130, 'pending_store_acceptance', 'pending', NOW())
       RETURNING id`,
      [created.userId, `RLS-${suffix}-A`, `RLS-${suffix}-B`],
    );
    created.orderIds.push(...ins.rows.map((r) => r.id));
    const [orderA, orderB] = created.orderIds;

    const mine = await backend.Order.getUserOrders(created.userId);
    expect(JSON.stringify(mine)).toContain(orderA);
    const details = await backend.Order.getByIdWithDetails(orderA, created.userId);
    expect(details.id).toBe(orderA);

    await backend.Payment.createPayment(orderA, created.userId, 130, 'card', 'paystack', `rls_txn_${suffix}_a`);
    await backend.Payment.markOrderPaidByCard(orderB, created.userId, 130, `rls_txn_${suffix}_b`);
    const b = (await backend.pool.query('SELECT payment_status FROM orders WHERE id = $1', [orderB])).rows[0];
    expect(b.payment_status).toBe('paid');
    const pays = (await backend.pool.query('SELECT count(*)::int AS n FROM payments WHERE order_id = ANY($1::uuid[])', [created.orderIds])).rows[0].n;
    expect(pays).toBe(2);
  });

  test('state machine: a row-locked status transition (updateOrderStatus)', async () => {
    const [, orderB] = created.orderIds;
    await backend.sm.updateOrderStatus(orderB, 'preparing', { actorId: 'system', actorRole: 'system', io: null });
    const row = (await backend.pool.query('SELECT status FROM orders WHERE id = $1', [orderB])).rows[0];
    expect(row.status).toBe('preparing');
  });

  test('cron paths: escalation claim UPDATE, timeout/recovery scans, flagged-accounts sync, prunes', async () => {
    const res = await backend.sm.escalateStuckPendingAcceptanceOrders({});
    expect(res.escalated).toBeGreaterThanOrEqual(1);
    // The service's lazy require('./emailService') runs after isolateModules
    // has returned, so it resolves the main-registry instance of the same
    // file-level mock (never the real module). Count calls on both instances.
    const mainEmail = require('../../src/services/emailService');
    const calls = mainEmail.sendOrderEscalationEmail.mock.calls.length + backend.email.sendOrderEscalationEmail.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    const flagged = (await backend.pool.query('SELECT acceptance_escalated_at FROM orders WHERE id = $1', [created.orderIds[0]])).rows[0];
    expect(flagged.acceptance_escalated_at).not.toBeNull();

    await expect(backend.sm.cancelAbandonedPaymentPendingOrders({ io: null })).resolves.toBeDefined();
    await expect(backend.sm.cancelStalePreparingOrders({ io: null })).resolves.toBeDefined();
    await expect(backend.sm.recoverStuckPaidOrders({ io: null })).resolves.toBeDefined();
    await expect(backend.sm.escalateStuckPreparingOrders({})).resolves.toBeDefined();

    // The same SQL the server.js cron jobs run (flag sync, prunes, token purge).
    await backend.pool.query(`UPDATE users SET cash_refusal_count = 1 WHERE id = $1`, [created.userId]);
    await backend.pool.query(`
      INSERT INTO flagged_accounts (user_id, flagged_for_cash_abuse, cash_refusal_count, synced_at)
      SELECT id, flagged_for_cash_abuse, COALESCE(cash_refusal_count, 0), NOW()
      FROM users WHERE flagged_for_cash_abuse = true OR COALESCE(cash_refusal_count, 0) > 0
      ON CONFLICT (user_id) DO UPDATE SET cash_refusal_count = EXCLUDED.cash_refusal_count, synced_at = NOW()`);
    const synced = (await backend.pool.query('SELECT count(*)::int AS n FROM flagged_accounts WHERE user_id = $1', [created.userId])).rows[0].n;
    expect(synced).toBe(1);
    await backend.pool.query(`DELETE FROM driver_locations WHERE recorded_at < NOW() - INTERVAL '30 days'`);
    await backend.pool.query(`DELETE FROM browsing_events WHERE created_at < NOW() - INTERVAL '60 days'`);
    await backend.pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
    await backend.pool.query('DELETE FROM revoked_tokens WHERE expires_at < NOW()');
  });

  test('control: a non-owner role WITHOUT BYPASSRLS sees no rows and cannot insert (RLS is really on)', async () => {
    const seenByBackend = (await backend.pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [created.userId])).rows[0].n;
    expect(seenByBackend).toBe(1);
    const seenByOutsider = (await outsider.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    expect(seenByOutsider).toBe(0);
    await expect(
      outsider.query(`INSERT INTO users (name, email, password_hash) VALUES ('x', 'rls-outsider-${suffix}@flash.invalid', 'x')`),
    ).rejects.toThrow(/row-level security/);
  });
});
