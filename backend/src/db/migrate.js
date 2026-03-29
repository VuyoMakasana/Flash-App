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
    await client.query(`CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_number VARCHAR(50) UNIQUE NOT NULL, user_id UUID REFERENCES users(id), driver_id UUID REFERENCES drivers(id), store_id VARCHAR(100), status VARCHAR(50) DEFAULT 'created', delivery_mode VARCHAR(20) DEFAULT 'fleet', time_slot VARCHAR(50), subtotal DECIMAL(10,2) NOT NULL, delivery_fee DECIMAL(10,2) NOT NULL, total DECIMAL(10,2) NOT NULL, driver_payout DECIMAL(10,2), payment_method VARCHAR(50), payment_status VARCHAR(50) DEFAULT 'pending', delivery_payment_method VARCHAR(20), delivery_payment_status VARCHAR(30), is_cash_delivery BOOLEAN DEFAULT false, paystack_reference VARCHAR(255), payflex_order_id VARCHAR(255), pickup_address TEXT, dropoff_address TEXT, pickup_lat DECIMAL(10,8), pickup_lng DECIMAL(11,8), dropoff_lat DECIMAL(10,8), dropoff_lng DECIMAL(11,8), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id) ON DELETE CASCADE, product_id VARCHAR(100) NOT NULL, product_name VARCHAR(255) NOT NULL, size VARCHAR(20), quantity INTEGER NOT NULL, unit_price DECIMAL(10,2) NOT NULL, total_price DECIMAL(10,2) NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS return_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id), user_id UUID REFERENCES users(id), driver_id UUID REFERENCES drivers(id), reason TEXT, status VARCHAR(50) DEFAULT 'requested', credit_issued BOOLEAN DEFAULT false, credit_amount DECIMAL(10,2), pickup_scheduled_at TIMESTAMP, picked_up_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(order_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_locations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE, order_id UUID REFERENCES orders(id), lat DECIMAL(10,8) NOT NULL, lng DECIMAL(11,8) NOT NULL, recorded_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id), user_id UUID REFERENCES users(id), amount DECIMAL(10,2) NOT NULL, currency VARCHAR(10) DEFAULT 'ZAR', method VARCHAR(50), provider VARCHAR(50), provider_transaction_id VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', type VARCHAR(20) DEFAULT 'store', metadata JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);


    
    // Phase 1 Fix 1: Add UNIQUE constraint on provider_transaction_id if it does not exist yet.
    // This prevents two payment records being inserted for the same Paystack transaction ID.
    // The DO NOTHING handles the case where the constraint already exists on a live database.
    await client.query(`
      DO $$
      BEGIN
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
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON webhook_events(paystack_event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_provider_txn ON payments(provider_transaction_id)`,
    ];
    for (const idx of indexes) await client.query(idx);

    await client.query('COMMIT');
    console.log('Flash database migration v3 completed successfully');
    console.log('   Tables created: 25 (+ messages, trusted_drivers)');
    console.log('   Indexes: 22 (+ 4 performance fixes + 4 new table indexes)');
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
