const BaseModel = require("./BaseModel");
const s3Service = require("../services/s3Service");

class Admin extends BaseModel {
  // Phase 0: individual admin accounts (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md).
  static async findByEmail(email) {
    const result = await this.query("SELECT * FROM admins WHERE email=$1", [email]);
    return result.rows[0] || null;
  }

  static async getDrivers(status = null) {
    const query = status
      ? "SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers WHERE status=$1 ORDER BY created_at DESC"
      : "SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers ORDER BY created_at DESC";

    const result = await this.query(query, status ? [status] : []);
    return result.rows;
  }

  static async getDriverById(driverId) {
    const driver = await this.query("SELECT * FROM drivers WHERE id=$1", [
      driverId,
    ]);
    if (!driver.rows.length) return null;

    // H-access-audit FIX: this used to SELECT * and return the stored
    // file_url straight through, which (before the upload-side fix) was a
    // permanently-valid Cloudinary URL — so every admin API call handed out
    // a link that never expired. Now file_url is never selected; a fresh,
    // short-lived signed URL is generated per document at request time
    // instead. Documents uploaded before this fix have no public_id and
    // get file_url: null — they'll need to be re-uploaded to be viewable.
    const docs = await this.query(
      `SELECT id, driver_id, document_type, file_name, verified, verified_at,
              verified_by, notes, uploaded_at, public_id, resource_type
       FROM driver_documents WHERE driver_id=$1`,
      [driverId],
    );
    const documents = await Promise.all(
      docs.rows.map(async ({ public_id, resource_type, ...doc }) => ({
        ...doc,
        file_url: public_id
          ? await s3Service.getSignedUrl(public_id, resource_type || "image")
          : null,
      })),
    );
    const { password_hash, ...safeDriver } = driver.rows[0];
    return { driver: safeDriver, documents };
  }

  static async updateDriverStatus(driverId, status) {
    await this.query(
      "UPDATE drivers SET status=$1, updated_at=NOW() WHERE id=$2",
      [status, driverId],
    );
  }

  static async getOrders() {
    const result = await this.query(
      `SELECT o.id, o.order_number, o.status, o.total, o.payment_method, o.created_at,
              u.name as user_name, d.name as driver_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       ORDER BY o.created_at DESC LIMIT 100`,
    );
    return result.rows;
  }

  // Pre-pickup cancellation split breakdown — one row per cancellation,
  // with the store's share pulled from order_cancellation_store_shares
  // (today always exactly one row per cancellation; the extension point for
  // a future multi-store split into several rows per cancellation).
  static async getCancellations() {
    const result = await this.query(
      `SELECT oc.id, oc.order_id, oc.reason, oc.refund_mode, oc.created_at,
              oc.item_value_at_cancellation, oc.store_amount, oc.driver_amount,
              oc.customer_item_refund, oc.delivery_fee_refunded,
              o.order_number, o.payment_method,
              u.name as customer_name, d.name as driver_name,
              COALESCE(
                json_agg(json_build_object('storeId', s.store_id, 'amount', s.amount)) FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) as store_shares
       FROM order_cancellations oc
       JOIN orders o ON o.id = oc.order_id
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       LEFT JOIN order_cancellation_store_shares s ON s.order_cancellation_id = oc.id
       GROUP BY oc.id, o.order_number, o.payment_method, u.name, d.name
       ORDER BY oc.created_at DESC LIMIT 100`,
    );
    return result.rows;
  }

  static async getStats() {
    const [users, drivers, orders, grossOrderValue] = await Promise.all([
      this.query("SELECT COUNT(*) FROM users"),
      this.query("SELECT COUNT(*) FROM drivers WHERE status='approved'"),
      this.query("SELECT COUNT(*) FROM orders"),
      this.query(
        "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE payment_status='paid'",
      ),
    ]);

    return {
      totalUsers: parseInt(users.rows[0].count),
      approvedDrivers: parseInt(drivers.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      // Renamed from totalRevenue (ADMIN_PANEL_AUDIT_AND_VISION.md §4.4):
      // this sums orders.total where paid -- gross order value processed
      // (item price + delivery fee, the customer's full payment), not
      // Flash's actual revenue share. Kept as its own honestly-labeled
      // figure; see getFinancials() below for the real revenue/cost/net
      // picture. Nothing else in the codebase reads the old `totalRevenue`
      // key (confirmed by search) -- this rename is not a breaking change.
      grossOrderValue: parseFloat(grossOrderValue.rows[0].total),
    };
  }

  // Real financial picture (ADMIN_PANEL_AUDIT_AND_VISION.md §4.3). Every
  // figure here is traced to a real, existing money-movement table -- no
  // new tracking invented, no new tables. Deliberately excludes
  // store_boosts/store_promotions.price_paid: confirmed by re-reading
  // boostController.js that purchaseBoost/createPromotion only insert a
  // DB row, never call Paystack -- including it in revenue would report
  // money Flash never actually received.
  static async getFinancials() {
    const [
      cardCommission, cashCommissionCollected, cashCommissionOutstanding,
      driverSubscriptions, premiumSubscriptions, cancellationStoreShare,
      driverPayoutsPaid, cancellationDriverCompensation, refundsCompleted,
      penalties,
    ] = await Promise.all([
      // Order.create(): flashCommission = max(10, delivery_fee * 0.25),
      // driverPayout = delivery_fee - flashCommission -- so
      // delivery_fee - driver_payout recovers Flash's commission directly
      // from the two stored columns, without re-deriving the formula.
      this.query(
        "SELECT COALESCE(SUM(delivery_fee - driver_payout),0) as v FROM orders WHERE payment_status='paid' AND payment_method != 'cash'",
      ),
      this.query(
        "SELECT COALESCE(SUM(commission_amount),0) as v FROM driver_commission_debts WHERE status IN ('collected_wallet','collected_payout')",
      ),
      this.query(
        "SELECT COALESCE(SUM(commission_amount),0) as v FROM driver_commission_debts WHERE status = 'outstanding'",
      ),
      this.query("SELECT COALESCE(SUM(price),0) as v FROM driver_subscriptions WHERE paystack_reference IS NOT NULL"),
      this.query("SELECT COALESCE(SUM(price),0) as v FROM premium_subscriptions WHERE paystack_reference IS NOT NULL"),
      this.query("SELECT COALESCE(SUM(store_amount),0) as v FROM order_cancellations"),
      // payout_transactions.status='success' is the real, completed
      // Paystack transfer -- not orders.driver_payout, which includes
      // amounts still sitting pending in a driver's wallet, not yet paid.
      this.query("SELECT COALESCE(SUM(amount),0) as v FROM payout_transactions WHERE status = 'success'"),
      this.query("SELECT COALESCE(SUM(driver_amount),0) as v FROM order_cancellations"),
      this.query("SELECT COALESCE(SUM(amount),0) as v FROM payment_refunds WHERE status = 'completed'"),
      // No reversal mechanism exists anywhere in the codebase (confirmed by
      // search -- driver_penalties.status is never updated after insert),
      // so summing every row is equivalent to filtering status='applied'.
      this.query("SELECT COALESCE(SUM(amount),0) as v FROM driver_penalties"),
    ]);

    const num = (r) => parseFloat(r.rows[0].v);

    const flashRevenue = {
      cardOrderCommission: num(cardCommission),
      cashOrderCommission: num(cashCommissionCollected),
      driverSubscriptions: num(driverSubscriptions),
      premiumSubscriptions: num(premiumSubscriptions),
      cancellationStoreShare: num(cancellationStoreShare),
    };
    flashRevenue.total = Object.values(flashRevenue).reduce((a, b) => a + b, 0);

    const costs = {
      driverPayoutsPaid: num(driverPayoutsPaid),
      cancellationDriverCompensation: num(cancellationDriverCompensation),
      refundsIssued: num(refundsCompleted),
    };
    costs.total = Object.values(costs).reduce((a, b) => a + b, 0);

    const driverPenaltiesCollected = num(penalties);

    return {
      flashRevenue,
      costs,
      driverPenaltiesCollected,
      // Driver penalties are a cost *offset* (money taken from a driver,
      // reducing what Flash pays out), not a separate cost -- netted in,
      // never double-counted as its own cost line (per the audit doc).
      netPosition: flashRevenue.total - costs.total + driverPenaltiesCollected,
      excludedFromRevenue: {
        boostAndPromotionPricePaid: 'Not real revenue — no Paystack charge is ever made for boost/promotion purchases (purchaseBoost/createPromotion only insert a DB row). Deliberately excluded.',
      },
      outstanding: {
        cashCommissionNotYetCollected: num(cashCommissionOutstanding),
      },
      excludesExternalCosts: 'Excludes infrastructure costs (Cloudinary, Resend, Render, Supabase, Paystack fees) — check each provider dashboard directly, not tracked here.',
    };
  }

  // Day-over-day trends (Addendum 2 §5): user signups, driver signups,
  // order volume, revenue — all buildable entirely from data that already
  // exists (created_at is already real on every relevant table), grouped
  // by day. Revenue uses the same real sources as getFinancials() above,
  // just grouped by day instead of summed once — not a separate, simpler
  // definition. "Real-time" per the audit doc's own conclusion means a
  // periodic pull on page load, not a live socket feed — proportionate to
  // how a solo founder actually checks this.
  //
  // TO_CHAR(..., 'YYYY-MM-DD') is used for every date, both the canonical
  // day list and each grouped query, deliberately avoiding node-postgres's
  // own DATE→JS-Date conversion (which applies a timezone interpretation
  // that can shift a date by a day depending on server timezone) — a plain
  // string produced by Postgres itself, matched directly, sidesteps that
  // ambiguity entirely rather than risking an off-by-one day.
  static async getDailyTrends(days = 14) {
    const [dayListRes, usersRes, driversRes, ordersRes, revenueRes] = await Promise.all([
      this.query(
        `SELECT TO_CHAR(generate_series(NOW() - (($1::int - 1) || ' days')::interval, NOW(), '1 day'), 'YYYY-MM-DD') AS day`,
        [days],
      ),
      this.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS count FROM users
         WHERE created_at >= NOW() - ($1 || ' days')::interval GROUP BY day`,
        [days],
      ),
      this.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS count FROM drivers
         WHERE created_at >= NOW() - ($1 || ' days')::interval GROUP BY day`,
        [days],
      ),
      this.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS count FROM orders
         WHERE created_at >= NOW() - ($1 || ' days')::interval GROUP BY day`,
        [days],
      ),
      this.query(
        `SELECT day, SUM(amount) AS amount FROM (
           SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, (delivery_fee - driver_payout) AS amount FROM orders
             WHERE payment_status = 'paid' AND payment_method != 'cash' AND created_at >= NOW() - ($1 || ' days')::interval
           UNION ALL
           SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, price AS amount FROM driver_subscriptions
             WHERE paystack_reference IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval
           UNION ALL
           SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, price AS amount FROM premium_subscriptions
             WHERE paystack_reference IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval
           UNION ALL
           SELECT TO_CHAR(settled_at, 'YYYY-MM-DD') AS day, commission_amount AS amount FROM driver_commission_debts
             WHERE status IN ('collected_wallet', 'collected_payout') AND settled_at >= NOW() - ($1 || ' days')::interval
           UNION ALL
           SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, store_amount AS amount FROM order_cancellations
             WHERE created_at >= NOW() - ($1 || ' days')::interval
         ) combined GROUP BY day`,
        [days],
      ),
    ]);

    const toMap = (rows, key) => new Map(rows.map((r) => [r.day, parseFloat(r[key])]));
    const usersMap = toMap(usersRes.rows, 'count');
    const driversMap = toMap(driversRes.rows, 'count');
    const ordersMap = toMap(ordersRes.rows, 'count');
    const revenueMap = toMap(revenueRes.rows, 'amount');

    return dayListRes.rows.map((r) => ({
      day: r.day,
      newUsers: usersMap.get(r.day) || 0,
      newDrivers: driversMap.get(r.day) || 0,
      orders: ordersMap.get(r.day) || 0,
      revenue: revenueMap.get(r.day) || 0,
    }));
  }
}

module.exports = Admin;
