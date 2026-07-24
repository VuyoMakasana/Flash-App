'use strict';


const { Pool } = require('pg');
require('dotenv').config();

// Previously logged the full DATABASE_URL, including its embedded password,
// to stdout on every migration run (local, CI, or a deploy step) — anyone
// with access to those logs could read the live database password.
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
} else {
  const redacted = process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***:***@');
  console.log('DATABASE_URL loaded:', redacted);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── v7: Refresh tokens, revoked tokens, Apple/Google IDs ─────────────────────
async function migrateV7(client) {
  await client.query('BEGIN');

  await client.query(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    token VARCHAR(200) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token
    ON refresh_tokens(token)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
    ON refresh_tokens(user_id)`);

  await client.query(`CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti VARCHAR(200) PRIMARY KEY,
    revoked_at TIMESTAMPTZ DEFAULT NOW(),
    user_id UUID,
    expires_at TIMESTAMPTZ
  )`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti
    ON revoked_tokens(jti)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires
    ON revoked_tokens(expires_at)`);

  await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS apple_id  TEXT`);
  await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS apple_id  TEXT`);
  await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS google_id TEXT`);
  await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS google_id TEXT`);
  await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false`);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id
    ON users(apple_id) WHERE apple_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_apple_id
    ON drivers(apple_id) WHERE apple_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
    ON users(google_id) WHERE google_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_google_id
    ON drivers(google_id) WHERE google_id IS NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_updated_at
    ON orders(updated_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_online
    ON drivers(is_online, status) WHERE is_online = true`);

  await client.query('COMMIT');
  console.log('Flash database migration v7 completed: refresh_tokens, revoked_tokens, Apple/Google IDs');
}

// ─── v8: Driver cash commission debt system ────────────────────────────────────
async function migrateV8(client) {
  await client.query('BEGIN');

  // commission_blocked flag on drivers — set true when debt >= R200 or 10+ deliveries
  await client.query(`ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS commission_blocked BOOLEAN NOT NULL DEFAULT false`);

  // Two new columns on driver_wallets
  await client.query(`ALTER TABLE driver_wallets
    ADD COLUMN IF NOT EXISTS cash_commission_debt      DECIMAL(10,2) NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE driver_wallets
    ADD COLUMN IF NOT EXISTS unpaid_cash_deliveries    INTEGER       NOT NULL DEFAULT 0`);

  // Commission debt ledger — one row per cash delivery
  await client.query(`CREATE TABLE IF NOT EXISTS driver_commission_debts (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id         UUID          NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    order_id          UUID          NOT NULL REFERENCES orders(id)  ON DELETE CASCADE UNIQUE,
    commission_amount DECIMAL(10,2) NOT NULL DEFAULT 20.00,
    status            VARCHAR(20)   NOT NULL DEFAULT 'outstanding'
                      CHECK (status IN ('outstanding','collected_wallet','collected_payout','waived')),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    settled_at        TIMESTAMPTZ
  )`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_commission_debts_driver
    ON driver_commission_debts(driver_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_commission_debts_order
    ON driver_commission_debts(order_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_commission_debts_status
    ON driver_commission_debts(status) WHERE status = 'outstanding'`);

  await client.query('COMMIT');
  console.log('Flash database migration v8 completed: driver cash commission debt system');
  console.log('   New column:  drivers.commission_blocked');
  console.log('   New columns: driver_wallets.cash_commission_debt, driver_wallets.unpaid_cash_deliveries');
  console.log('   New table:   driver_commission_debts');
}

// ─── Main migration runner ─────────────────────────────────────────────────────
async function migrate() {
  const client = await pool.connect();
  try {
    // ── v1–v4: Core schema ───────────────────────────────────────────────────
    await client.query('BEGIN');

    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      address TEXT,
      terms_accepted BOOLEAN DEFAULT false,
      terms_accepted_at TIMESTAMP,
      paystack_customer_code VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS drivers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      vehicle_type VARCHAR(100),
      vehicle_plate VARCHAR(50),
      profile_photo_url TEXT,
      status VARCHAR(50) DEFAULT 'pending_documents',
      is_online BOOLEAN DEFAULT false,
      current_lat DECIMAL(10,8),
      current_lng DECIMAL(11,8),
      paystack_customer_code VARCHAR(255),
      rating DECIMAL(3,2) DEFAULT 5.00,
      total_deliveries INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
      document_type VARCHAR(100) NOT NULL,
      file_url TEXT NOT NULL,
      file_name VARCHAR(255),
      verified BOOLEAN DEFAULT false,
      verified_at TIMESTAMP,
      verified_by UUID,
      notes TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(driver_id, document_type)
    )`);

    // Access-security audit (2026-07-11): documents were stored and served
    // via a permanently-valid Cloudinary URL (file_url) instead of a
    // short-lived signed one. Fixing that means generating the signed URL
    // on demand from public_id + resource_type instead of storing/returning
    // a permanent one — file_url is no longer written for new uploads, so
    // it can no longer be NOT NULL. Existing rows keep their historical
    // (permanent) file_url untouched; only new uploads populate public_id/
    // resource_type going forward.
    await client.query(`ALTER TABLE driver_documents ALTER COLUMN file_url DROP NOT NULL`);
    await client.query(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS public_id VARCHAR(500)`);
    await client.query(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS resource_type VARCHAR(20)`);

    await client.query(`CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number VARCHAR(50) UNIQUE NOT NULL,
      user_id UUID REFERENCES users(id),
      driver_id UUID REFERENCES drivers(id),
      store_id VARCHAR(100),
      preferred_driver_id UUID REFERENCES drivers(id),
      status VARCHAR(50) DEFAULT 'created',
      delivery_mode VARCHAR(20) DEFAULT 'fleet',
      time_slot VARCHAR(50),
      subtotal DECIMAL(10,2) NOT NULL,
      delivery_fee DECIMAL(10,2) NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      driver_payout DECIMAL(10,2),
      payment_method VARCHAR(50),
      payment_status VARCHAR(50) DEFAULT 'pending',
      delivery_payment_method VARCHAR(20),
      delivery_payment_status VARCHAR(30),
      store_paid BOOLEAN DEFAULT false,
      driver_paid BOOLEAN DEFAULT false,
      cash_to_collect DECIMAL(10,2),
      cash_received_at TIMESTAMPTZ,
      is_return_order BOOLEAN DEFAULT false,
      parent_order_id UUID REFERENCES orders(id),
      is_cash_delivery BOOLEAN DEFAULT false,
      paystack_reference VARCHAR(255),
      payflex_order_id VARCHAR(255),
      pickup_address TEXT,
      dropoff_address TEXT,
      pickup_lat DECIMAL(10,8),
      pickup_lng DECIMAL(11,8),
      dropoff_lat DECIMAL(10,8),
      dropoff_lng DECIMAL(11,8),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      product_id VARCHAR(100) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      size VARCHAR(20),
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      total_price DECIMAL(10,2) NOT NULL
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS return_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID REFERENCES orders(id),
      user_id UUID REFERENCES users(id),
      driver_id UUID REFERENCES drivers(id),
      reason TEXT,
      status VARCHAR(50) DEFAULT 'requested',
      credit_issued BOOLEAN DEFAULT false,
      credit_amount DECIMAL(10,2),
      pickup_scheduled_at TIMESTAMP,
      picked_up_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(order_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS driver_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
      order_id UUID REFERENCES orders(id),
      lat DECIMAL(10,8) NOT NULL,
      lng DECIMAL(11,8) NOT NULL,
      recorded_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID REFERENCES orders(id),
      user_id UUID REFERENCES users(id),
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'ZAR',
      method VARCHAR(50),
      provider VARCHAR(50),
      provider_transaction_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      type VARCHAR(20) DEFAULT 'store',
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    // Idempotent unique constraint on provider_transaction_id. Previously ran
    // as a single DO $$ block whose DELETE was silent — no record anywhere of
    // which rows (or how many) were removed from a financial-transactions
    // table. Split into separate statements so the deleted rows can be
    // logged before the constraint is added.
    const constraintExists = await client.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'payments_provider_transaction_id_key'
    `);
    if (!constraintExists.rows.length) {
      const deleted = await client.query(`
        DELETE FROM payments p
        USING payments p2
        WHERE p.provider_transaction_id IS NOT NULL
          AND p.provider_transaction_id = p2.provider_transaction_id
          AND p.ctid > p2.ctid
        RETURNING p.id, p.provider_transaction_id
      `);
      if (deleted.rows.length) {
        console.warn(
          `[Migration] Removed ${deleted.rows.length} duplicate payments row(s) before adding unique constraint on provider_transaction_id:`,
          deleted.rows.map((r) => ({ id: r.id, provider_transaction_id: r.provider_transaction_id })),
        );
      }
      await client.query(`
        ALTER TABLE payments
          ADD CONSTRAINT payments_provider_transaction_id_key
          UNIQUE (provider_transaction_id)
      `);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paystack_event_id VARCHAR(255) NOT NULL UNIQUE,
      event_type VARCHAR(100) NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS saved_cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      paystack_authorization_code VARCHAR(255) UNIQUE,
      last4 VARCHAR(4) NOT NULL,
      card_type VARCHAR(50),
      bank VARCHAR(100),
      exp_month INTEGER NOT NULL,
      exp_year INTEGER NOT NULL,
      nickname VARCHAR(100),
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

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

    await client.query(`CREATE TABLE IF NOT EXISTS driver_payout_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'requested',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

    await client.query(`CREATE TABLE IF NOT EXISTS driver_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      plan_type VARCHAR(20) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      deliveries_limit INTEGER,
      deliveries_used INTEGER DEFAULT 0,
      starts_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      paystack_reference VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS size_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      height_cm INTEGER, weight_kg DECIMAL(5,1),
      chest_cm DECIMAL(5,1), waist_cm DECIMAL(5,1), hips_cm DECIMAL(5,1),
      shoulder_cm DECIMAL(5,1), inseam_cm DECIMAL(5,1),
      reference_brand_1 VARCHAR(100), reference_size_1 VARCHAR(20),
      reference_brand_2 VARCHAR(100), reference_size_2 VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS brand_size_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id VARCHAR(100) NOT NULL, brand_name VARCHAR(100) NOT NULL,
      category VARCHAR(50) NOT NULL, size_label VARCHAR(20) NOT NULL,
      chest_min DECIMAL(5,1), chest_max DECIMAL(5,1),
      waist_min DECIMAL(5,1), waist_max DECIMAL(5,1),
      hips_min DECIMAL(5,1), hips_max DECIMAL(5,1),
      height_min INTEGER, height_max INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS feed_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL, caption TEXT,
      likes_count INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS feed_post_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
      product_id VARCHAR(100) NOT NULL, product_name VARCHAR(255), price DECIMAL(10,2),
      store_id VARCHAR(100), tap_x DECIMAL(5,4), tap_y DECIMAL(5,4)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS feed_likes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(post_id, user_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS feed_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS store_boosts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id VARCHAR(100) NOT NULL, store_name VARCHAR(255),
      boost_type VARCHAR(50) NOT NULL, price_paid DECIMAL(10,2) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS store_promotions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id VARCHAR(100) NOT NULL, title VARCHAR(255) NOT NULL, description TEXT,
      discount_percent INTEGER,
      starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS premium_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      price DECIMAL(10,2) DEFAULT 99.00, status VARCHAR(20) DEFAULT 'active',
      paystack_reference VARCHAR(255),
      starts_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS store_credits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      return_id UUID REFERENCES return_requests(id),
      amount DECIMAL(10,2) NOT NULL, balance DECIMAL(10,2) NOT NULL,
      reason TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS flash_inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_name VARCHAR(255) NOT NULL, category VARCHAR(100), brand VARCHAR(100),
      price DECIMAL(10,2) NOT NULL, cost_price DECIMAL(10,2),
      sizes JSONB DEFAULT '[]', stock_by_size JSONB DEFAULT '{}',
      image_url TEXT, description TEXT, is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS browsing_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      product_id VARCHAR(100), category VARCHAR(100),
      lat DECIMAL(10,8), lng DECIMAL(11,8), city VARCHAR(100),
      duration_seconds INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL,
      sender_role VARCHAR(10) NOT NULL CHECK (sender_role IN ('user','driver')),
      content TEXT NOT NULL, read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS trusted_drivers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, driver_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS transfer_recipients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      recipient_code VARCHAR(100) NOT NULL,
      account_number VARCHAR(20) NOT NULL,
      bank_code VARCHAR(10) NOT NULL,
      account_name VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(driver_id, account_number, bank_code)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payout_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payout_request_id UUID REFERENCES driver_payout_requests(id) ON DELETE SET NULL,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'initiated',
      reference VARCHAR(255) NOT NULL UNIQUE,
      recipient_code VARCHAR(100), transfer_code VARCHAR(100),
      provider_response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payflex_webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payflex_event_id VARCHAR(255) NOT NULL UNIQUE,
      order_id VARCHAR(255), event_status VARCHAR(50),
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ADD COLUMNs (idempotent)
    await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS push_token TEXT`);
    await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS push_token TEXT`);
    await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS paystack_recipient_code TEXT`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS preferred_driver_id UUID REFERENCES drivers(id)`);
    // FIXED (trusted driver exclusivity): powers the time-boxed exclusivity
    // window — while in the future, only preferred_driver_id may see/accept
    // this order. See Driver.js / orderStateMachineService.js.
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS preferred_driver_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS store_paid BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS driver_paid BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_to_collect DECIMAL(10,2)`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_received_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_hash VARCHAR(255)`);
    // Plaintext code, time-boxed alongside cash_otp_expires_at and cleared on
    // use/expiry — the hash alone can't be reversed to show the customer
    // their code on demand, which is what the fetch-on-demand screen needs.
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_plain VARCHAR(6)`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_sent_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_verified_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cash_otp_attempts INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS is_return_order BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS parent_order_id UUID REFERENCES orders(id)`);
    await client.query(`ALTER TABLE orders   ADD COLUMN IF NOT EXISTS cancellation_penalty DECIMAL(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS cancel_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE drivers  ADD COLUMN IF NOT EXISTS suspension_reason TEXT`);
    await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS cash_refusal_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS flagged_for_cash_abuse BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS approved_by UUID`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS return_order_id UUID REFERENCES orders(id)`);

    // Migrate saved_cards → payment_methods
    await client.query(`
      INSERT INTO payment_methods
        (user_id, provider, authorization_code, last4, brand, exp_month, exp_year, is_default, created_at)
      SELECT sc.user_id, 'paystack', sc.paystack_authorization_code,
             sc.last4, sc.card_type, sc.exp_month, sc.exp_year, sc.is_default, sc.created_at
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

    // ── v5: scheduled_for + email_tokens ─────────────────────────────────────
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ`);

    await client.query(`CREATE TABLE IF NOT EXISTS email_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(128) NOT NULL UNIQUE,
      type VARCHAR(30) NOT NULL CHECK (type IN ('email_verification', 'password_reset')),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`);

    // ── Indexes ───────────────────────────────────────────────────────────────
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
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_browsing_events_user_id ON browsing_events(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_order_id ON messages(order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(order_id, created_at ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_drivers_user ON trusted_drivers(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_drivers_driver ON trusted_drivers(driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded ON driver_locations(recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, created_at ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(order_id, sender_role, read_at)`,
      `CREATE INDEX IF NOT EXISTS idx_trusted_status ON trusted_drivers(driver_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_preferred_driver ON orders(preferred_driver_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_preferred_driver_expiry ON orders(preferred_driver_expires_at) WHERE preferred_driver_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id, is_default)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_wallet_ledger_driver ON driver_wallet_ledger(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_penalties_driver ON driver_penalties(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_order_cancellations_order ON order_cancellations(order_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(order_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_driver_payouts_driver ON driver_payouts(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_transfer_recipients_driver ON transfer_recipients(driver_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_payout_transactions_driver ON payout_transactions(driver_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_payout_transactions_request ON payout_transactions(payout_request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payflex_webhook_events_id ON payflex_webhook_events(payflex_event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_scheduled ON orders(scheduled_for) WHERE scheduled_for IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_tokens(token)`,
      `CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, type)`,
      // Inventory.getProducts() is the highest-traffic read in the app (every
      // product-listing page load) and had no supporting index at all beyond
      // the primary key — every call was a full sequential scan + sort.
      // Two indexes because the query has two shapes: with a category filter
      // and without. Leading is_active on both matches the WHERE clause both
      // queries always include.
      `CREATE INDEX IF NOT EXISTS idx_flash_inventory_active_created ON flash_inventory(is_active, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_flash_inventory_active_category_created ON flash_inventory(is_active, category, created_at DESC)`,
      // Trends.getCityTrends/getCategoryTrends and Fleet.getClusters all
      // filter primarily on `created_at > NOW() - INTERVAL '...'` — the
      // existing browsing_events indexes lead with lat/lng or category, so
      // none of them actually match this shape. This one does.
      `CREATE INDEX IF NOT EXISTS idx_browsing_events_created_at ON browsing_events(created_at DESC)`,
    ];

    for (const idx of indexes) {
      await client.query(idx);
    }

    await client.query('COMMIT');
    console.log('Flash database migration v1–v6 completed successfully');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v1–v6 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }

  // ── v7 ─────────────────────────────────────────────────────────────────────
  // Each version gets its own client + transaction to prevent a single-version
  // failure from rolling back the entire migration history.
  const client7 = await pool.connect();
  try {
    await migrateV7(client7);
  } catch (err) {
    console.error('Migration v7 failed:', err.message);
    throw err;
  } finally {
    client7.release();
  }

  // ── v8 ─────────────────────────────────────────────────────────────────────
  const client8 = await pool.connect();
  try {
    await migrateV8(client8);
  } catch (err) {
    console.error('Migration v8 failed:', err.message);
    throw err;
  } finally {
    client8.release();
  }

  // ── v9 ─────────────────────────────────────────────────────────────────────
  const client9 = await pool.connect();
  try {
    await migrateV9(client9);
  } catch (err) {
    console.error('Migration v9 failed:', err.message);
    throw err;
  } finally {
    client9.release();
  }

  // ── v10 ────────────────────────────────────────────────────────────────────
  const client10 = await pool.connect();
  try {
    await migrateV10(client10);
  } catch (err) {
    console.error('Migration v10 failed:', err.message);
    throw err;
  } finally {
    client10.release();
  }

  // ── v11 ────────────────────────────────────────────────────────────────────
  const client11 = await pool.connect();
  try {
    await migrateV11(client11);
  } catch (err) {
    console.error('Migration v11 failed:', err.message);
    throw err;
  } finally {
    client11.release();
  }

  // ── v12 ────────────────────────────────────────────────────────────────────
  const client12 = await pool.connect();
  try {
    await migrateV12(client12);
  } catch (err) {
    console.error('Migration v12 failed:', err.message);
    throw err;
  } finally {
    client12.release();
  }

  // ── v13 ────────────────────────────────────────────────────────────────────
  const client13 = await pool.connect();
  try {
    await migrateV13(client13);
  } catch (err) {
    console.error('Migration v13 failed:', err.message);
    throw err;
  } finally {
    client13.release();
  }

  // ── v14 ────────────────────────────────────────────────────────────────────
  const client14 = await pool.connect();
  try {
    await migrateV14(client14);
  } catch (err) {
    console.error('Migration v14 failed:', err.message);
    throw err;
  } finally {
    client14.release();
  }

  // ── v15 ────────────────────────────────────────────────────────────────────
  const client15 = await pool.connect();
  try {
    await migrateV15(client15);
  } catch (err) {
    console.error('Migration v15 failed:', err.message);
    throw err;
  } finally {
    client15.release();
  }

  // ── v16 ────────────────────────────────────────────────────────────────────
  const client16 = await pool.connect();
  try {
    await migrateV16(client16);
  } catch (err) {
    console.error('Migration v16 failed:', err.message);
    throw err;
  } finally {
    client16.release();
  }

  // ── v17 ────────────────────────────────────────────────────────────────────
  const client17 = await pool.connect();
  try {
    await migrateV17(client17);
  } catch (err) {
    console.error('Migration v17 failed:', err.message);
    throw err;
  } finally {
    client17.release();
    await pool.end();
  }

  console.log('All Flash database migrations completed successfully.');
}

migrate().catch((err) => {
  console.error('Fatal migration error:', err.message);
  process.exit(1);
});

// ─── v9: order_stops table (multi-mall / multi-shop support) ─────────────────
async function migrateV9(client) {
  await client.query('BEGIN');
  try {
    // order_stops tracks each pickup location in a multi-store order.
    // Each row = one pickup stop for the driver.
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_stops (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        stop_number     INTEGER NOT NULL,           -- 1 = first pickup, 2 = second, etc.
        store_name      VARCHAR(255),
        pickup_address  TEXT NOT NULL,
        pickup_lat      DOUBLE PRECISION,
        pickup_lng      DOUBLE PRECISION,
        items_json      JSONB DEFAULT '[]',         -- line items at this stop
        status          VARCHAR(50) DEFAULT 'pending',  -- pending | arrived | picked_up
        arrived_at      TIMESTAMPTZ,
        picked_up_at    TIMESTAMPTZ,
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_id, stop_number)
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_order_stops_order_id ON order_stops(order_id)`
    );

    // Add pickup_lat/lng to orders table for single-stop distance pricing
    await client.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS pickup_lat    DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS pickup_lng    DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS dropoff_lat   DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS dropoff_lng   DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS extra_stops   INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS has_heavy_items BOOLEAN DEFAULT false
    `);

    await client.query('COMMIT');
    console.log('Flash database migration v9 completed: order_stops table + lat/lng columns');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v9 failed:', err.message);
    throw err;
  }
}

async function migrateV10(client) {
  await client.query('BEGIN');
  try {
    // Item 4 (Phase 4 audit): drivers.rating had no submission flow at all —
    // it was a static DEFAULT 5.00 column nothing ever wrote to. This table
    // stores one rating per completed order; the driver's aggregate rating
    // is recomputed from these rows (see Rating.js) rather than being a
    // manually-set field.
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_ratings (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        driver_id  UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
        rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_id)
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_driver_ratings_driver_id ON driver_ratings(driver_id)`
    );

    // Separate from driver_ratings — rating Flash itself, not a specific
    // delivery. No UNIQUE constraint (kept simple; the client only prompts
    // once per device via AsyncStorage, this doesn't need to enforce it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_ratings (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('Flash database migration v10 completed: driver_ratings table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v10 failed:', err.message);
    throw err;
  }
}

async function migrateV11(client) {
  await client.query('BEGIN');
  try {
    // Item 5 (Phase 4 audit): one-tap SOS/safety action, available to both
    // customer and driver during an active delivery. Kept deliberately
    // simple — one row per trigger, no separate workflow/status machine —
    // since this needs to work reliably under stress, not be feature-rich.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sos_alerts (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        triggered_by_role VARCHAR(10) NOT NULL CHECK (triggered_by_role IN ('user','driver')),
        triggered_by_id   UUID NOT NULL,
        lat               DOUBLE PRECISION,
        lng               DOUBLE PRECISION,
        acknowledged_at   TIMESTAMPTZ,
        acknowledged_by   UUID,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sos_alerts_order_id ON sos_alerts(order_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sos_alerts_unacknowledged ON sos_alerts(created_at) WHERE acknowledged_at IS NULL`
    );

    await client.query('COMMIT');
    console.log('Flash database migration v11 completed: sos_alerts table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v11 failed:', err.message);
    throw err;
  }
}

// ─── v12: addresses table (saved address book) ────────────────────────────────
async function migrateV12(client) {
  await client.query('BEGIN');
  try {
    // AddressScreen.js (flash-user-app) was already fully built against this
    // exact shape - label/street/apartment/suburb/city/gate_code/landmark/
    // is_default - with no backend behind it at all (every action 404'd).
    // Matching the existing frontend contract exactly rather than inventing
    // a new one.
    await client.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label         VARCHAR(50) NOT NULL DEFAULT 'Home',
        street        TEXT NOT NULL,
        apartment     TEXT,
        suburb        TEXT,
        city          TEXT,
        gate_code     TEXT,
        landmark      TEXT,
        full_address  TEXT,
        is_default    BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Nullable — existing addresses saved before this fix just fall back to
    // live GPS at checkout, same as they always have, until re-saved.
    await client.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
    await client.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id)`
    );

    await client.query('COMMIT');
    console.log('Flash database migration v12 completed: addresses table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v12 failed:', err.message);
    throw err;
  }
}

// ─── v13: drivers.terms_accepted (driver app had no terms-acceptance
// mechanism of any kind - no column, no gate, no screen) ──────────────────────
async function migrateV13(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`);

    await client.query('COMMIT');
    console.log('Flash database migration v13 completed: drivers.terms_accepted');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v13 failed:', err.message);
    throw err;
  }
}

// ─── v14: users.date_of_birth / drivers.date_of_birth (both live legal
// pages claim 18+, but nothing enforced it at registration) ──────────────────
async function migrateV14(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS date_of_birth DATE`);

    await client.query('COMMIT');
    console.log('Flash database migration v14 completed: users/drivers.date_of_birth');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v14 failed:', err.message);
    throw err;
  }
}

// ─── v15: orders.delivered_at (no immutable "when did this actually arrive"
// timestamp existed anywhere — only updated_at, which gets overwritten on
// every subsequent status transition. Standalone from the returns rebuild
// since it's generally useful, not returns-specific) ──────────────────────────
async function migrateV15(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);

    await client.query('COMMIT');
    console.log('Flash database migration v15 completed: orders.delivered_at');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v15 failed:', err.message);
    throw err;
  }
}

// ─── v16: returns rebuild — item-level selection, real fee, card refunds
// instead of store credit. New columns on return_requests (old store-credit
// columns left untouched — never dropped, just unused by the new flow) plus
// a new return_request_items line-item table. Also closes the
// docs/audits/RETURNS_AND_LEGAL_AUDIT.md MEDIUM finding (return_requests.user_id
// had no supporting index, confirmed live Seq Scan) while this table is
// already being touched. ────────────────────────────────────────────────────
async function migrateV16(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(10,2)`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10,2)`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS rejected_by UUID`);
    await client.query(`ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_return_requests_user_id ON return_requests(user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS return_request_items (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        return_id           UUID NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
        order_item_id       UUID NOT NULL REFERENCES order_items(id),
        quantity_returned   INTEGER NOT NULL,
        unit_price          DECIMAL(10,2) NOT NULL,
        line_refund_amount  DECIMAL(10,2) NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (return_id, order_item_id)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_return_request_items_return_id ON return_request_items(return_id)`);

    await client.query('COMMIT');
    console.log('Flash database migration v16 completed: return_requests columns + return_request_items table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v16 failed:', err.message);
    throw err;
  }
}

// ─── v17: pickup/drop-off photo proof, and the pre-pickup cancellation
// split's own audit columns. order_cancellation_store_shares is the explicit
// multi-store extension point — one row per store today (store_id is always
// NULL until multi-store orders exist), one row per store later, without
// changing how a cancellation is recorded. ────────────────────────────────
async function migrateV17(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo_public_id VARCHAR(255)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo_resource_type VARCHAR(20)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_photo_public_id VARCHAR(255)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_photo_resource_type VARCHAR(20)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_photo_at TIMESTAMPTZ`);

    await client.query(`ALTER TABLE order_cancellations ADD COLUMN IF NOT EXISTS item_value_at_cancellation DECIMAL(10,2) NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE order_cancellations ADD COLUMN IF NOT EXISTS store_amount DECIMAL(10,2) NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE order_cancellations ADD COLUMN IF NOT EXISTS driver_amount DECIMAL(10,2) NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE order_cancellations ADD COLUMN IF NOT EXISTS customer_item_refund DECIMAL(10,2) NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE order_cancellations ADD COLUMN IF NOT EXISTS delivery_fee_refunded DECIMAL(10,2) NOT NULL DEFAULT 0`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_cancellation_store_shares (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_cancellation_id  UUID NOT NULL REFERENCES order_cancellations(id) ON DELETE CASCADE,
        store_id               UUID,
        amount                 DECIMAL(10,2) NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cancellation_store_shares_cancellation_id ON order_cancellation_store_shares(order_cancellation_id)`);

    await client.query('COMMIT');
    console.log('Flash database migration v17 completed: pickup/dropoff photo columns, cancellation split columns + order_cancellation_store_shares');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v17 failed:', err.message);
    throw err;
  }
}

module.exports = { migrateV7, migrateV8, migrateV9, migrateV10, migrateV11, migrateV12, migrateV13, migrateV14, migrateV15, migrateV16, migrateV17 };
