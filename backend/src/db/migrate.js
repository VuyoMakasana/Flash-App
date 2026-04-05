const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, phone VARCHAR(50), address TEXT, terms_accepted BOOLEAN DEFAULT false, terms_accepted_at TIMESTAMP, paystack_customer_code VARCHAR(255), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS drivers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, phone VARCHAR(50), vehicle_type VARCHAR(100), vehicle_plate VARCHAR(50), profile_photo_url TEXT, status VARCHAR(50) DEFAULT 'pending_documents', is_online BOOLEAN DEFAULT false, current_lat DECIMAL(10,8), current_lng DECIMAL(11,8), paystack_customer_code VARCHAR(255), rating DECIMAL(3,2) DEFAULT 5.00, total_deliveries INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE, document_type VARCHAR(100) NOT NULL, file_url TEXT NOT NULL, file_name VARCHAR(255), verified BOOLEAN DEFAULT false, verified_at TIMESTAMP, verified_by UUID, notes TEXT, uploaded_at TIMESTAMP DEFAULT NOW(), UNIQUE(driver_id, document_type))`);
    await client.query(`CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_number VARCHAR(50) UNIQUE NOT NULL, user_id UUID REFERENCES users(id), driver_id UUID REFERENCES drivers(id), store_id VARCHAR(100), preferred_driver_id UUID REFERENCES drivers(id), status VARCHAR(50) DEFAULT 'created', delivery_mode VARCHAR(20) DEFAULT 'fleet', time_slot VARCHAR(50), subtotal DECIMAL(10,2) NOT NULL, delivery_fee DECIMAL(10,2) NOT NULL, total DECIMAL(10,2) NOT NULL, driver_payout DECIMAL(10,2), payment_method VARCHAR(50), payment_status VARCHAR(50) DEFAULT 'pending', delivery_payment_method VARCHAR(20), delivery_payment_status VARCHAR(30), store_paid BOOLEAN DEFAULT false, driver_paid BOOLEAN DEFAULT false, cash_to_collect DECIMAL(10,2), cash_received_at TIMESTAMPTZ, is_return_order BOOLEAN DEFAULT false, parent_order_id UUID REFERENCES orders(id), is_cash_delivery BOOLEAN DEFAULT false, paystack_reference VARCHAR(255), payflex_order_id VARCHAR(255), pickup_address TEXT, dropoff_address TEXT, pickup_lat DECIMAL(10,8), pickup_lng DECIMAL(11,8), dropoff_lat DECIMAL(10,8), dropoff_lng DECIMAL(11,8), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id) ON DELETE CASCADE, product_id VARCHAR(100) NOT NULL, product_name VARCHAR(255) NOT NULL, size VARCHAR(20), quantity INTEGER NOT NULL, unit_price DECIMAL(10,2) NOT NULL, total_price DECIMAL(10,2) NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS return_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id), user_id UUID REFERENCES users(id), driver_id UUID REFERENCES drivers(id), reason TEXT, status VARCHAR(50) DEFAULT 'requested', credit_issued BOOLEAN DEFAULT false, credit_amount DECIMAL(10,2), pickup_scheduled_at TIMESTAMP, picked_up_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(order_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_locations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE, order_id UUID REFERENCES orders(id), lat DECIMAL(10,8) NOT NULL, lng DECIMAL(11,8) NOT NULL, recorded_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id), user_id UUID REFERENCES users(id), amount DECIMAL(10,2) NOT NULL, currency VARCHAR(10) DEFAULT 'ZAR', method VARCHAR(50), provider VARCHAR(50), provider_transaction_id VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', type VARCHAR(20) DEFAULT 'store', metadata JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);


    
    // Phase 1 Fix 1: Add UNIQUE constraint on provider_transaction_id if it does not exist yet.
    // This prevents two payment records being inserted for the same Paystack transaction ID.
    // Before adding the constraint, remove any duplicate rows (keeping the earliest by ctid)
    // so that existing databases with duplicates are not blocked from starting.
    await client.query(`
      DO $$
      DECLARE
        v_has_duplicates BOOLEAN;
      BEGIN
        SELECT EXISTS (
          SELECT provider_transaction_id
          FROM payments
          WHERE provider_transaction_id IS NOT NULL
          GROUP BY provider_transaction_id
          HAVING COUNT(*) > 1
        ) INTO v_has_duplicates;

        IF v_has_duplicates THEN
          DELETE FROM payments p
          USING payments p2
          WHERE p.provider_transaction_id IS NOT NULL
            AND p.provider_transaction_id = p2.provider_transaction_id
            AND p.ctid > p2.ctid;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'payments_provider_transaction_id_key'
        ) THEN
          ALTER TABLE payments
            ADD CONSTRAINT payments_provider_transaction_id_key
            UNIQUE (provider_transaction_id);
        END IF;
      END $$;
    `);

    // Phase 1 Fix 2: Webhook idempotency table.
    // Before processing any webhook event, we insert its paystack_event_id here.
    // If the INSERT fails (duplicate), we know it was already processed and skip it.
    await client.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paystack_event_id VARCHAR(255) NOT NULL UNIQUE,
      event_type VARCHAR(100) NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )`);


    await client.query(`CREATE TABLE IF NOT EXISTS saved_cards (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, paystack_authorization_code VARCHAR(255) UNIQUE, last4 VARCHAR(4) NOT NULL, card_type VARCHAR(50), bank VARCHAR(100), exp_month INTEGER NOT NULL, exp_year INTEGER NOT NULL, nickname VARCHAR(100), is_default BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS payment_methods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      authorization_code TEXT NOT NULL,
      auth_fingerprint VARCHAR(64),
      last4 VARCHAR(4) NOT NULL,
      brand VARCHAR(50),
      exp_month INTEGER NOT NULL,
      exp_year INTEGER NOT NULL,
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS auth_fingerprint VARCHAR(64)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_user_provider_auth
      ON payment_methods(user_id, provider, authorization_code)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_user_provider_fingerprint
      ON payment_methods(user_id, provider, auth_fingerprint)`);

    await client.query(`CREATE TABLE IF NOT EXISTS payment_refunds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
      amount DECIMAL(10,2) NOT NULL,
      provider VARCHAR(50),
      refund_reference VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'processing',
      reason TEXT,
      provider_response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payout_request_id UUID REFERENCES driver_payout_requests(id) ON DELETE SET NULL,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'processing',
      reference VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE UNIQUE,
      wallet_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
      pending_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_wallet_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      order_id UUID REFERENCES orders(id),
      amount DECIMAL(12,2) NOT NULL,
      entry_type VARCHAR(30) NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_payout_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'requested',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_penalties (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      order_id UUID REFERENCES orders(id),
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'applied',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS order_cancellations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      cancelled_by_id UUID,
      cancelled_by_role VARCHAR(20) NOT NULL,
      reason TEXT,
      refund_mode VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, plan_type VARCHAR(20) NOT NULL, price DECIMAL(10,2) NOT NULL, deliveries_limit INTEGER, deliveries_used INTEGER DEFAULT 0, starts_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, status VARCHAR(20) DEFAULT 'active', paystack_reference VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS size_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE, height_cm INTEGER, weight_kg DECIMAL(5,1), chest_cm DECIMAL(5,1), waist_cm DECIMAL(5,1), hips_cm DECIMAL(5,1), shoulder_cm DECIMAL(5,1), inseam_cm DECIMAL(5,1), reference_brand_1 VARCHAR(100), reference_size_1 VARCHAR(20), reference_brand_2 VARCHAR(100), reference_size_2 VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS brand_size_mappings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id VARCHAR(100) NOT NULL, brand_name VARCHAR(100) NOT NULL, category VARCHAR(50) NOT NULL, size_label VARCHAR(20) NOT NULL, chest_min DECIMAL(5,1), chest_max DECIMAL(5,1), waist_min DECIMAL(5,1), waist_max DECIMAL(5,1), hips_min DECIMAL(5,1), hips_max DECIMAL(5,1), height_min INTEGER, height_max INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS feed_posts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, image_url TEXT NOT NULL, caption TEXT, likes_count INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS feed_post_products (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE, product_id VARCHAR(100) NOT NULL, product_name VARCHAR(255), price DECIMAL(10,2), store_id VARCHAR(100), tap_x DECIMAL(5,4), tap_y DECIMAL(5,4))`);
    await client.query(`CREATE TABLE IF NOT EXISTS feed_likes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(post_id, user_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS feed_comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS store_boosts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id VARCHAR(100) NOT NULL, store_name VARCHAR(255), boost_type VARCHAR(50) NOT NULL, price_paid DECIMAL(10,2) NOT NULL, starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, status VARCHAR(20) DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS store_promotions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id VARCHAR(100) NOT NULL, title VARCHAR(255) NOT NULL, description TEXT, discount_percent INTEGER, starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS premium_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE, price DECIMAL(10,2) DEFAULT 99.00, status VARCHAR(20) DEFAULT 'active', paystack_reference VARCHAR(255), starts_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS store_credits (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, return_id UUID REFERENCES return_requests(id), amount DECIMAL(10,2) NOT NULL, balance DECIMAL(10,2) NOT NULL, reason TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS flash_inventory (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_name VARCHAR(255) NOT NULL, category VARCHAR(100), brand VARCHAR(100), price DECIMAL(10,2) NOT NULL, cost_price DECIMAL(10,2), sizes JSONB DEFAULT '[]', stock_by_size JSONB DEFAULT '{}', image_url TEXT, description TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS browsing_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE SET NULL, product_id VARCHAR(100), category VARCHAR(100), lat DECIMAL(10,8), lng DECIMAL(11,8), city VARCHAR(100), duration_seconds INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

    // ─── NEW TABLES (v3 upgrades) ──────────────────────────────────────────────
    // Messages table for in-app chat between user and driver
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL,
      sender_role VARCHAR(10) NOT NULL CHECK (sender_role IN ('user','driver')),
      content TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Trusted drivers — users can save preferred drivers
    await client.query(`CREATE TABLE IF NOT EXISTS trusted_drivers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, driver_id)
    )`);

    // ─── v4: Real driver payouts via Paystack Transfer API ────────────────────
    // Stores verified Paystack transfer recipients (bank accounts) per driver.
    // One driver can have multiple historical recipients but only one active one.
    await client.query(`CREATE TABLE IF NOT EXISTS transfer_recipients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      recipient_code VARCHAR(100) NOT NULL,
      account_number VARCHAR(20) NOT NULL,
      bank_code VARCHAR(10) NOT NULL,
      account_name VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(driver_id, account_number, bank_code)
    )`);

    // Stores each Paystack transfer attempt for a payout request.
    // Separate from driver_payouts (legacy) to keep a clean audit trail.
    await client.query(`CREATE TABLE IF NOT EXISTS payout_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payout_request_id UUID REFERENCES driver_payout_requests(id) ON DELETE SET NULL,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'initiated',
      reference VARCHAR(255) NOT NULL UNIQUE,
      recipient_code VARCHAR(100),
      transfer_code VARCHAR(100),
      provider_response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);

    // ─── v4: Payflex webhook idempotency table ─────────────────────────────────
    // Same pattern as paystack webhook_events — prevents double-processing of
    // the same Payflex webhook event.
    await client.query(`CREATE TABLE IF NOT EXISTS payflex_webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payflex_event_id VARCHAR(255) NOT NULL UNIQUE,
      order_id VARCHAR(255),
      event_status VARCHAR(50),
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ─── v4: Push notification tokens ─────────────────────────────────────────
    // Store Expo push tokens so we can notify users and drivers about order events.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS push_token TEXT`);

    // ─── v4: Migrate saved_cards → payment_methods ───────────────────────────
    // saved_cards was the original card storage table. payment_methods is the
    // current canonical table. Migrate any unmigrated rows across so the old
    // table can be phased out. We map card_type → brand and
    // paystack_authorization_code → authorization_code.
    await client.query(`
      INSERT INTO payment_methods
        (user_id, provider, authorization_code, last4, brand, exp_month, exp_year, is_default, created_at)
      SELECT
        sc.user_id,
        'paystack',
        sc.paystack_authorization_code,
        sc.last4,
        sc.card_type,
        sc.exp_month,
        sc.exp_year,
        sc.is_default,
        sc.created_at
      FROM saved_cards sc
      WHERE sc.paystack_authorization_code IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_methods pm
          WHERE pm.user_id = sc.user_id
            AND pm.provider = 'paystack'
            AND pm.authorization_code = sc.paystack_authorization_code
        )
      ON CONFLICT DO NOTHING
    `);

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS preferred_driver_id UUID REFERENCES drivers(id)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_paid BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_paid BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_to_collect DECIMAL(10,2)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_received_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_otp_hash VARCHAR(255)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_otp_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_otp_sent_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_otp_verified_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_otp_attempts INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_return_order BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_order_id UUID REFERENCES orders(id)`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cancel_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cash_refusal_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS flagged_for_cash_abuse BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS approved_by UUID`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS return_order_id UUID REFERENCES orders(id)`);

    // Indexes
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_id ON driver_locations(driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON driver_documents(driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_subs_driver ON driver_subscriptions(driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_subs_status ON driver_subscriptions(status, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_feed_posts_active ON feed_posts(is_active, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_browsing_events_location ON browsing_events(lat, lng, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_store_boosts_active ON store_boosts(status, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_premium_subs_user ON premium_subscriptions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_store_credits_user ON store_credits(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_browsing_category ON browsing_events(category, created_at DESC)`,
      // ─── v3: 4 missing indexes from audit ────────────────────────────────────
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_browsing_events_user_id ON browsing_events(user_id)`,
      // ─── v3: new tables indexes ───────────────────────────────────────────────
      `CREATE INDEX IF NOT EXISTS idx_messages_order_id ON messages(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(order_id, created_at ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_drivers_user ON trusted_drivers(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_drivers_driver ON trusted_drivers(driver_id)`,
      // ─── v3.1: additional scale indexes ──────────────────────────────────────
      `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded ON driver_locations(recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, created_at ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(order_id, sender_role, read_at)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_status ON trusted_drivers(driver_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_preferred_driver ON orders(preferred_driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id, is_default)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_wallet_ledger_driver ON driver_wallet_ledger(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_penalties_driver ON driver_penalties(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_order_cancellations_order ON order_cancellations(order_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(order_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_payouts_driver ON driver_payouts(driver_id, created_at DESC)`,
      // idx_webhook_events_id and idx_payments_provider_txn are intentionally omitted:
      // UNIQUE constraints on those columns already create implicit indexes.
      // ─── v4: new payout and notification indexes ──────────────────────────────
      `CREATE INDEX IF NOT EXISTS idx_transfer_recipients_driver ON transfer_recipients(driver_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_payout_transactions_driver ON payout_transactions(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_payout_transactions_request ON payout_transactions(payout_request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payflex_webhook_events_id ON payflex_webhook_events(payflex_event_id)`,
    ];
    for (const idx of indexes) await client.query(idx);

    await client.query('COMMIT');
    console.log('Flash database migration v4 completed successfully');
    console.log('   New tables: transfer_recipients, payout_transactions, payflex_webhook_events');
    console.log('   New columns: users.push_token, drivers.push_token');
    console.log('   Data migration: saved_cards → payment_methods');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
