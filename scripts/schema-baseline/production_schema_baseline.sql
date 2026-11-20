ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_email_key UNIQUE (email);

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_ratings
    ADD CONSTRAINT app_ratings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_ratings
    ADD CONSTRAINT app_ratings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.brand_size_mappings
    ADD CONSTRAINT brand_size_mappings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.brand_size_mappings
    ADD CONSTRAINT brand_size_mappings_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.browsing_events
    ADD CONSTRAINT browsing_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.browsing_events
    ADD CONSTRAINT browsing_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.chat_reports
    ADD CONSTRAINT chat_reports_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.chat_reports
    ADD CONSTRAINT chat_reports_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_reports
    ADD CONSTRAINT chat_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_reports
    ADD CONSTRAINT chat_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id);

ALTER TABLE ONLY public.commission_rates
    ADD CONSTRAINT commission_rates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id);

ALTER TABLE ONLY public.commission_rates
    ADD CONSTRAINT commission_rates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commission_rates
    ADD CONSTRAINT commission_rates_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.driver_commission_debts
    ADD CONSTRAINT driver_commission_debts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_commission_debts
    ADD CONSTRAINT driver_commission_debts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_commission_debts
    ADD CONSTRAINT driver_commission_debts_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.driver_commission_debts
    ADD CONSTRAINT driver_commission_debts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_driver_id_document_type_key UNIQUE (driver_id, document_type);

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_payout_requests
    ADD CONSTRAINT driver_payout_requests_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_payout_requests
    ADD CONSTRAINT driver_payout_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_payouts
    ADD CONSTRAINT driver_payouts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_payouts
    ADD CONSTRAINT driver_payouts_payout_request_id_fkey FOREIGN KEY (payout_request_id) REFERENCES public.driver_payout_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.driver_payouts
    ADD CONSTRAINT driver_payouts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_penalties
    ADD CONSTRAINT driver_penalties_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_penalties
    ADD CONSTRAINT driver_penalties_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.driver_penalties
    ADD CONSTRAINT driver_penalties_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_ratings
    ADD CONSTRAINT driver_ratings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_ratings
    ADD CONSTRAINT driver_ratings_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_ratings
    ADD CONSTRAINT driver_ratings_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.driver_ratings
    ADD CONSTRAINT driver_ratings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_ratings
    ADD CONSTRAINT driver_ratings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT driver_subscriptions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT driver_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_wallet_ledger
    ADD CONSTRAINT driver_wallet_ledger_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_wallet_ledger
    ADD CONSTRAINT driver_wallet_ledger_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.driver_wallet_ledger
    ADD CONSTRAINT driver_wallet_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_wallets
    ADD CONSTRAINT driver_wallets_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_wallets
    ADD CONSTRAINT driver_wallets_driver_id_key UNIQUE (driver_id);

ALTER TABLE ONLY public.driver_wallets
    ADD CONSTRAINT driver_wallets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_email_key UNIQUE (email);

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_svix_id_key UNIQUE (svix_id);

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_token_key UNIQUE (token);

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_comments
    ADD CONSTRAINT feed_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feed_comments
    ADD CONSTRAINT feed_comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.feed_posts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_comments
    ADD CONSTRAINT feed_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_likes
    ADD CONSTRAINT feed_likes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feed_likes
    ADD CONSTRAINT feed_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.feed_posts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_likes
    ADD CONSTRAINT feed_likes_post_id_user_id_key UNIQUE (post_id, user_id);

ALTER TABLE ONLY public.feed_likes
    ADD CONSTRAINT feed_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_post_products
    ADD CONSTRAINT feed_post_products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feed_post_products
    ADD CONSTRAINT feed_post_products_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.feed_posts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feed_posts
    ADD CONSTRAINT feed_posts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feed_posts
    ADD CONSTRAINT feed_posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.flagged_accounts
    ADD CONSTRAINT flagged_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flagged_accounts
    ADD CONSTRAINT flagged_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.flagged_accounts
    ADD CONSTRAINT flagged_accounts_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.flash_inventory
    ADD CONSTRAINT flash_inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flash_inventory
    ADD CONSTRAINT flash_inventory_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.marketing_applications
    ADD CONSTRAINT marketing_applications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marketing_contact_messages
    ADD CONSTRAINT marketing_contact_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marketing_waitlist
    ADD CONSTRAINT marketing_waitlist_email_key UNIQUE (email);

ALTER TABLE ONLY public.marketing_waitlist
    ADD CONSTRAINT marketing_waitlist_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_cancellation_store_shares
    ADD CONSTRAINT order_cancellation_store_shares_order_cancellation_id_fkey FOREIGN KEY (order_cancellation_id) REFERENCES public.order_cancellations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_cancellation_store_shares
    ADD CONSTRAINT order_cancellation_store_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_cancellation_store_shares
    ADD CONSTRAINT order_cancellation_store_shares_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.order_cancellations
    ADD CONSTRAINT order_cancellations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_cancellations
    ADD CONSTRAINT order_cancellations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_stops
    ADD CONSTRAINT order_stops_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_stops
    ADD CONSTRAINT order_stops_order_id_stop_number_key UNIQUE (order_id, stop_number);

ALTER TABLE ONLY public.order_stops
    ADD CONSTRAINT order_stops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_commission_rate_id_fkey FOREIGN KEY (commission_rate_id) REFERENCES public.commission_rates(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_parent_order_id_fkey FOREIGN KEY (parent_order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_preferred_driver_id_fkey FOREIGN KEY (preferred_driver_id) REFERENCES public.drivers(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.payflex_webhook_events
    ADD CONSTRAINT payflex_webhook_events_payflex_event_id_key UNIQUE (payflex_event_id);

ALTER TABLE ONLY public.payflex_webhook_events
    ADD CONSTRAINT payflex_webhook_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_provider_transaction_id_key UNIQUE (provider_transaction_id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.payout_transactions
    ADD CONSTRAINT payout_transactions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payout_transactions
    ADD CONSTRAINT payout_transactions_payout_request_id_fkey FOREIGN KEY (payout_request_id) REFERENCES public.driver_payout_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payout_transactions
    ADD CONSTRAINT payout_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payout_transactions
    ADD CONSTRAINT payout_transactions_reference_key UNIQUE (reference);

ALTER TABLE ONLY public.premium_subscription_payments
    ADD CONSTRAINT premium_subscription_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.premium_subscription_payments
    ADD CONSTRAINT premium_subscription_payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.premium_subscriptions
    ADD CONSTRAINT premium_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.premium_subscriptions
    ADD CONSTRAINT premium_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.premium_subscriptions
    ADD CONSTRAINT premium_subscriptions_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_key UNIQUE (token);

ALTER TABLE ONLY public.return_request_items
    ADD CONSTRAINT return_request_items_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id);

ALTER TABLE ONLY public.return_request_items
    ADD CONSTRAINT return_request_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.return_request_items
    ADD CONSTRAINT return_request_items_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.return_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.return_request_items
    ADD CONSTRAINT return_request_items_return_id_order_item_id_key UNIQUE (return_id, order_item_id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_return_order_id_fkey FOREIGN KEY (return_order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.return_requests
    ADD CONSTRAINT return_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.revoked_tokens
    ADD CONSTRAINT revoked_tokens_pkey PRIMARY KEY (jti);

ALTER TABLE ONLY public.saved_cards
    ADD CONSTRAINT saved_cards_paystack_authorization_code_key UNIQUE (paystack_authorization_code);

ALTER TABLE ONLY public.saved_cards
    ADD CONSTRAINT saved_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.saved_cards
    ADD CONSTRAINT saved_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.schema_migrations_ledger
    ADD CONSTRAINT schema_migrations_ledger_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.settlement_config
    ADD CONSTRAINT settlement_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settlement_config
    ADD CONSTRAINT settlement_config_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.size_profiles
    ADD CONSTRAINT size_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.size_profiles
    ADD CONSTRAINT size_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.size_profiles
    ADD CONSTRAINT size_profiles_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.sos_alerts
    ADD CONSTRAINT sos_alerts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sos_alerts
    ADD CONSTRAINT sos_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_actions
    ADD CONSTRAINT store_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_actions
    ADD CONSTRAINT store_actions_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.store_actions
    ADD CONSTRAINT store_actions_store_user_id_fkey FOREIGN KEY (store_user_id) REFERENCES public.store_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.store_boosts
    ADD CONSTRAINT store_boosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_boosts
    ADD CONSTRAINT store_boosts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.flash_inventory(id);

ALTER TABLE ONLY public.store_boosts
    ADD CONSTRAINT store_boosts_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.store_credits
    ADD CONSTRAINT store_credits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_credits
    ADD CONSTRAINT store_credits_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.return_requests(id);

ALTER TABLE ONLY public.store_credits
    ADD CONSTRAINT store_credits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.store_password_tokens
    ADD CONSTRAINT store_password_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_password_tokens
    ADD CONSTRAINT store_password_tokens_store_user_id_fkey FOREIGN KEY (store_user_id) REFERENCES public.store_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.store_password_tokens
    ADD CONSTRAINT store_password_tokens_token_key UNIQUE (token);

ALTER TABLE ONLY public.store_promotions
    ADD CONSTRAINT store_promotions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_promotions
    ADD CONSTRAINT store_promotions_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.store_settlement_line_items
    ADD CONSTRAINT store_settlement_line_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.store_settlement_line_items
    ADD CONSTRAINT store_settlement_line_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_settlement_line_items
    ADD CONSTRAINT store_settlement_line_items_store_settlement_id_fkey FOREIGN KEY (store_settlement_id) REFERENCES public.store_settlements(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.store_settlements
    ADD CONSTRAINT store_settlements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_settlements
    ADD CONSTRAINT store_settlements_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.store_transfer_recipients
    ADD CONSTRAINT store_transfer_recipients_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.store_users(id);

ALTER TABLE ONLY public.store_transfer_recipients
    ADD CONSTRAINT store_transfer_recipients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_transfer_recipients
    ADD CONSTRAINT store_transfer_recipients_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.store_users
    ADD CONSTRAINT store_users_email_key UNIQUE (email);

ALTER TABLE ONLY public.store_users
    ADD CONSTRAINT store_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_users
    ADD CONSTRAINT store_users_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id);

ALTER TABLE ONLY public.transfer_recipients
    ADD CONSTRAINT transfer_recipients_driver_id_account_number_bank_code_key UNIQUE (driver_id, account_number, bank_code);

ALTER TABLE ONLY public.transfer_recipients
    ADD CONSTRAINT transfer_recipients_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transfer_recipients
    ADD CONSTRAINT transfer_recipients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.trusted_drivers
    ADD CONSTRAINT trusted_drivers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.trusted_drivers
    ADD CONSTRAINT trusted_drivers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.trusted_drivers
    ADD CONSTRAINT trusted_drivers_user_id_driver_id_key UNIQUE (user_id, driver_id);

ALTER TABLE ONLY public.trusted_drivers
    ADD CONSTRAINT trusted_drivers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id);

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_paystack_event_id_key UNIQUE (paystack_event_id);

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);

COMMENT ON SCHEMA public IS 'standard public schema';

CREATE INDEX idx_addresses_user ON public.addresses USING btree (user_id);

CREATE INDEX idx_admin_actions_admin_id ON public.admin_actions USING btree (admin_id, created_at DESC);

CREATE INDEX idx_admin_actions_created_at ON public.admin_actions USING btree (created_at DESC);

CREATE INDEX idx_browsing_category ON public.browsing_events USING btree (category, created_at DESC);

CREATE INDEX idx_browsing_events_created_at ON public.browsing_events USING btree (created_at DESC);

CREATE INDEX idx_browsing_events_location ON public.browsing_events USING btree (lat, lng, created_at);

CREATE INDEX idx_browsing_events_user_id ON public.browsing_events USING btree (user_id);

CREATE INDEX idx_cancellation_store_shares_cancellation_id ON public.order_cancellation_store_shares USING btree (order_cancellation_id);

CREATE INDEX idx_chat_reports_order ON public.chat_reports USING btree (order_id);

CREATE INDEX idx_chat_reports_reported ON public.chat_reports USING btree (reported_id);

CREATE INDEX idx_chat_reports_reporter ON public.chat_reports USING btree (reporter_id);

CREATE INDEX idx_chat_reports_status ON public.chat_reports USING btree (status, created_at DESC);

CREATE INDEX idx_commission_debts_driver ON public.driver_commission_debts USING btree (driver_id, status);

CREATE INDEX idx_commission_debts_order ON public.driver_commission_debts USING btree (order_id);

CREATE INDEX idx_commission_debts_status ON public.driver_commission_debts USING btree (status) WHERE ((status)::text = 'outstanding'::text);

CREATE INDEX idx_commission_rates_store_id ON public.commission_rates USING btree (store_id) WHERE (store_id IS NOT NULL);

CREATE INDEX idx_driver_commission_debts_created_at ON public.driver_commission_debts USING btree (created_at DESC);

CREATE INDEX idx_driver_documents_driver_id ON public.driver_documents USING btree (driver_id);

CREATE INDEX idx_driver_locations_driver_id ON public.driver_locations USING btree (driver_id);

CREATE INDEX idx_driver_locations_recorded ON public.driver_locations USING btree (recorded_at DESC);

CREATE INDEX idx_driver_payout_requests_created_at ON public.driver_payout_requests USING btree (created_at DESC);

CREATE INDEX idx_driver_payouts_driver ON public.driver_payouts USING btree (driver_id, created_at DESC);

CREATE INDEX idx_driver_penalties_created_at ON public.driver_penalties USING btree (created_at DESC);

CREATE INDEX idx_driver_penalties_driver ON public.driver_penalties USING btree (driver_id, created_at DESC);

CREATE INDEX idx_driver_ratings_driver_id ON public.driver_ratings USING btree (driver_id);

CREATE INDEX idx_driver_subs_driver ON public.driver_subscriptions USING btree (driver_id);

CREATE INDEX idx_driver_subs_status ON public.driver_subscriptions USING btree (status, expires_at);

CREATE INDEX idx_driver_subscriptions_updated_at ON public.driver_subscriptions USING btree (updated_at DESC);

CREATE INDEX idx_driver_wallet_ledger_created_at ON public.driver_wallet_ledger USING btree (created_at DESC);

CREATE INDEX idx_driver_wallet_ledger_driver ON public.driver_wallet_ledger USING btree (driver_id, created_at DESC);

CREATE INDEX idx_driver_wallets_updated_at ON public.driver_wallets USING btree (updated_at DESC);

CREATE INDEX idx_drivers_created_at ON public.drivers USING btree (created_at DESC);

CREATE INDEX idx_drivers_online ON public.drivers USING btree (is_online, status) WHERE (is_online = true);

CREATE INDEX idx_email_events_recipient_created ON public.email_events USING btree (recipient, created_at DESC);

CREATE INDEX idx_email_events_type_created ON public.email_events USING btree (event_type, created_at DESC);

CREATE INDEX idx_email_tokens_token ON public.email_tokens USING btree (token);

CREATE INDEX idx_email_tokens_user ON public.email_tokens USING btree (user_id, type);

CREATE INDEX idx_feed_comments_post ON public.feed_comments USING btree (post_id, created_at);

CREATE INDEX idx_feed_posts_active ON public.feed_posts USING btree (is_active, created_at DESC);

CREATE INDEX idx_flagged_accounts_synced_at ON public.flagged_accounts USING btree (synced_at DESC);

CREATE INDEX idx_flash_inventory_active_category_created ON public.flash_inventory USING btree (is_active, category, created_at DESC);

CREATE INDEX idx_flash_inventory_active_created ON public.flash_inventory USING btree (is_active, created_at DESC);

CREATE INDEX idx_flash_inventory_created_at ON public.flash_inventory USING btree (created_at DESC);

CREATE INDEX idx_flash_inventory_store_id ON public.flash_inventory USING btree (store_id);

CREATE INDEX idx_marketing_applications_created ON public.marketing_applications USING btree (created_at DESC);

CREATE INDEX idx_marketing_applications_type ON public.marketing_applications USING btree (applicant_type, created_at DESC);

CREATE INDEX idx_marketing_contact_created ON public.marketing_contact_messages USING btree (created_at DESC);

CREATE INDEX idx_marketing_waitlist_created ON public.marketing_waitlist USING btree (created_at DESC);

CREATE INDEX idx_messages_created_at ON public.messages USING btree (order_id, created_at);

CREATE INDEX idx_messages_order_id ON public.messages USING btree (order_id);

CREATE INDEX idx_messages_unread ON public.messages USING btree (order_id, sender_role, read_at);

CREATE INDEX idx_order_cancellations_created_at ON public.order_cancellations USING btree (created_at DESC);

CREATE INDEX idx_order_cancellations_order ON public.order_cancellations USING btree (order_id, created_at DESC);

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);

CREATE INDEX idx_order_stops_order_id ON public.order_stops USING btree (order_id);

CREATE INDEX idx_orders_acceptance_escalation_check ON public.orders USING btree (status, updated_at) WHERE (acceptance_escalated_at IS NULL);

CREATE INDEX idx_orders_created_at ON public.orders USING btree (created_at DESC);

CREATE INDEX idx_orders_driver_connection_check ON public.orders USING btree (status, driver_id) WHERE (driver_connection_flagged_at IS NULL);

CREATE INDEX idx_orders_driver_id ON public.orders USING btree (driver_id);

CREATE INDEX idx_orders_parent_order_id ON public.orders USING btree (parent_order_id) WHERE (parent_order_id IS NOT NULL);

CREATE INDEX idx_orders_preferred_driver ON public.orders USING btree (preferred_driver_id);

CREATE INDEX idx_orders_preferred_driver_expiry ON public.orders USING btree (preferred_driver_expires_at) WHERE (preferred_driver_id IS NOT NULL);

CREATE INDEX idx_orders_preparation_escalation_check ON public.orders USING btree (status, updated_at) WHERE (preparation_escalated_at IS NULL);

CREATE INDEX idx_orders_scheduled ON public.orders USING btree (scheduled_for) WHERE (scheduled_for IS NOT NULL);

CREATE INDEX idx_orders_status ON public.orders USING btree (status);

CREATE INDEX idx_orders_status_created ON public.orders USING btree (status, created_at DESC);

CREATE INDEX idx_orders_status_updated ON public.orders USING btree (status, updated_at);

CREATE INDEX idx_orders_store_commission_pending ON public.orders USING btree (store_id, delivered_at) WHERE (store_commission IS NOT NULL);

CREATE INDEX idx_orders_store_id ON public.orders USING btree (store_id);

CREATE INDEX idx_orders_store_id_created_at ON public.orders USING btree (store_id, created_at DESC);

CREATE INDEX idx_orders_stuck_delivery_check ON public.orders USING btree (status, delivered_at) WHERE (stuck_delivery_flagged_at IS NULL);

CREATE INDEX idx_orders_updated_at ON public.orders USING btree (updated_at);

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);

CREATE INDEX idx_payflex_webhook_events_id ON public.payflex_webhook_events USING btree (payflex_event_id);

CREATE INDEX idx_payment_methods_user ON public.payment_methods USING btree (user_id, is_default);

CREATE INDEX idx_payment_refunds_order ON public.payment_refunds USING btree (order_id, created_at DESC);

CREATE INDEX idx_payments_order_id ON public.payments USING btree (order_id);

CREATE INDEX idx_payout_transactions_created_at ON public.payout_transactions USING btree (created_at DESC);

CREATE INDEX idx_payout_transactions_driver ON public.payout_transactions USING btree (driver_id, created_at DESC);

CREATE INDEX idx_payout_transactions_request ON public.payout_transactions USING btree (payout_request_id);

CREATE INDEX idx_premium_subs_user ON public.premium_subscriptions USING btree (user_id);

CREATE INDEX idx_premium_subscription_payments_user_id ON public.premium_subscription_payments USING btree (user_id);

CREATE INDEX idx_premium_subscriptions_updated_at ON public.premium_subscriptions USING btree (updated_at DESC);

CREATE INDEX idx_refresh_tokens_token ON public.refresh_tokens USING btree (token);

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);

CREATE INDEX idx_return_request_items_return_id ON public.return_request_items USING btree (return_id);

CREATE INDEX idx_return_requests_created_at ON public.return_requests USING btree (created_at DESC);

CREATE INDEX idx_return_requests_user_id ON public.return_requests USING btree (user_id);

CREATE INDEX idx_revoked_tokens_expires ON public.revoked_tokens USING btree (expires_at);

CREATE INDEX idx_revoked_tokens_jti ON public.revoked_tokens USING btree (jti);

CREATE INDEX idx_saved_cards_user ON public.saved_cards USING btree (user_id);

CREATE INDEX idx_settlement_config_store_id ON public.settlement_config USING btree (store_id) WHERE (store_id IS NOT NULL);

CREATE INDEX idx_sos_alerts_created_at ON public.sos_alerts USING btree (created_at DESC);

CREATE INDEX idx_sos_alerts_order_id ON public.sos_alerts USING btree (order_id);

CREATE INDEX idx_sos_alerts_unacknowledged ON public.sos_alerts USING btree (created_at) WHERE (acknowledged_at IS NULL);

CREATE INDEX idx_store_actions_store_id ON public.store_actions USING btree (store_id, created_at DESC);

CREATE INDEX idx_store_actions_store_user_id ON public.store_actions USING btree (store_user_id, created_at DESC);

CREATE INDEX idx_store_boosts_active ON public.store_boosts USING btree (status, expires_at);

CREATE INDEX idx_store_boosts_product_active ON public.store_boosts USING btree (product_id, status, expires_at);

CREATE INDEX idx_store_credits_user ON public.store_credits USING btree (user_id);

CREATE INDEX idx_store_password_tokens_store_user_id ON public.store_password_tokens USING btree (store_user_id);

CREATE INDEX idx_store_settlement_line_items_settlement_id ON public.store_settlement_line_items USING btree (store_settlement_id);

CREATE INDEX idx_store_settlements_status ON public.store_settlements USING btree (status);

CREATE INDEX idx_store_settlements_store_id ON public.store_settlements USING btree (store_id);

CREATE INDEX idx_store_transfer_recipients_store_created ON public.store_transfer_recipients USING btree (store_id, created_at DESC);

CREATE INDEX idx_store_users_store_id ON public.store_users USING btree (store_id);

CREATE INDEX idx_stores_status_created ON public.stores USING btree (status, created_at DESC);

CREATE INDEX idx_transfer_recipients_driver ON public.transfer_recipients USING btree (driver_id, is_active);

CREATE INDEX idx_trusted_drivers_driver ON public.trusted_drivers USING btree (driver_id);

CREATE INDEX idx_trusted_drivers_user ON public.trusted_drivers USING btree (user_id);

CREATE INDEX idx_trusted_status ON public.trusted_drivers USING btree (driver_id, status);

CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_id, blocker_role);

CREATE INDEX idx_user_blocks_blocker ON public.user_blocks USING btree (blocker_id, blocked_role);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE SCHEMA public;

CREATE TABLE public.addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label character varying(50) DEFAULT 'Home'::character varying NOT NULL,
    street text NOT NULL,
    apartment text,
    suburb text,
    city text,
    gate_code text,
    landmark text,
    full_address text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision,
    lng double precision
);

CREATE TABLE public.admin_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action_type character varying(50) NOT NULL,
    target_table character varying(50),
    target_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    phone character varying(50),
    role character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.app_ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    rating smallint NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_ratings_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

CREATE TABLE public.brand_size_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    brand_name character varying(100) NOT NULL,
    category character varying(50) NOT NULL,
    size_label character varying(20) NOT NULL,
    chest_min numeric(5,1),
    chest_max numeric(5,1),
    waist_min numeric(5,1),
    waist_max numeric(5,1),
    hips_min numeric(5,1),
    hips_max numeric(5,1),
    height_min integer,
    height_max integer,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.browsing_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    product_id character varying(100),
    category character varying(100),
    lat numeric(10,8),
    lng numeric(11,8),
    city character varying(100),
    duration_seconds integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.chat_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    reporter_id uuid NOT NULL,
    reporter_role character varying(10) NOT NULL,
    reported_id uuid NOT NULL,
    reported_role character varying(10) NOT NULL,
    message_id uuid,
    reason text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    admin_notes text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_reports_reported_role_check CHECK (((reported_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text]))),
    CONSTRAINT chat_reports_reporter_role_check CHECK (((reporter_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text]))),
    CONSTRAINT chat_reports_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('reviewed'::character varying)::text, ('actioned'::character varying)::text, ('dismissed'::character varying)::text])))
);

CREATE TABLE public.commission_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope_type character varying(20) NOT NULL,
    store_id uuid,
    rate numeric(5,4) NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rates_promotional_window_check CHECK ((((scope_type)::text <> 'promotional'::text) OR ((starts_at IS NOT NULL) AND (ends_at IS NOT NULL) AND (ends_at > starts_at)))),
    CONSTRAINT commission_rates_rate_check CHECK (((rate >= (0)::numeric) AND (rate <= (1)::numeric))),
    CONSTRAINT commission_rates_scope_store_check CHECK (((((scope_type)::text = 'global'::text) AND (store_id IS NULL)) OR (((scope_type)::text = ANY (ARRAY[('store'::character varying)::text, ('promotional'::character varying)::text])) AND (store_id IS NOT NULL)))),
    CONSTRAINT commission_rates_scope_type_check CHECK (((scope_type)::text = ANY (ARRAY[('global'::character varying)::text, ('store'::character varying)::text, ('promotional'::character varying)::text])))
);

CREATE TABLE public.driver_commission_debts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    order_id uuid NOT NULL,
    commission_amount numeric(10,2) DEFAULT 20.00 NOT NULL,
    status character varying(20) DEFAULT 'outstanding'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT driver_commission_debts_status_check CHECK (((status)::text = ANY (ARRAY[('outstanding'::character varying)::text, ('collected_wallet'::character varying)::text, ('collected_payout'::character varying)::text, ('waived'::character varying)::text])))
);

CREATE TABLE public.driver_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid,
    document_type character varying(100) NOT NULL,
    file_url text,
    file_name character varying(255),
    verified boolean DEFAULT false,
    verified_at timestamp without time zone,
    verified_by uuid,
    notes text,
    uploaded_at timestamp without time zone DEFAULT now(),
    public_id character varying(500),
    resource_type character varying(20)
);

CREATE TABLE public.driver_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid,
    order_id uuid,
    lat numeric(10,8) NOT NULL,
    lng numeric(11,8) NOT NULL,
    recorded_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public.driver_payout_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    status character varying(30) DEFAULT 'requested'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_request_id uuid,
    driver_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    status character varying(30) DEFAULT 'processing'::character varying NOT NULL,
    reference character varying(255),
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);

CREATE TABLE public.driver_penalties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    order_id uuid,
    amount numeric(10,2) DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    status character varying(30) DEFAULT 'applied'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    rating smallint NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT driver_ratings_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

CREATE TABLE public.driver_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    plan_type character varying(20) NOT NULL,
    price numeric(10,2) NOT NULL,
    deliveries_limit integer,
    deliveries_used integer DEFAULT 0,
    starts_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    paystack_reference character varying(255),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cancelled_at timestamp with time zone
);

CREATE TABLE public.driver_wallet_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    order_id uuid,
    amount numeric(12,2) NOT NULL,
    entry_type character varying(30) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_wallets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    wallet_balance numeric(12,2) DEFAULT 0 NOT NULL,
    pending_balance numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cash_commission_debt numeric(10,2) DEFAULT 0 NOT NULL,
    unpaid_cash_deliveries integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    phone character varying(50),
    vehicle_type character varying(100),
    vehicle_plate character varying(50),
    profile_photo_url text,
    status character varying(50) DEFAULT 'pending_documents'::character varying,
    is_online boolean DEFAULT false,
    current_lat numeric(10,8),
    current_lng numeric(11,8),
    paystack_customer_code character varying(255),
    rating numeric(3,2) DEFAULT 5.00,
    total_deliveries integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    push_token text,
    paystack_recipient_code text,
    cancel_count integer DEFAULT 0,
    suspended_at timestamp with time zone,
    suspension_reason text,
    apple_id text,
    google_id text,
    commission_blocked boolean DEFAULT false NOT NULL,
    terms_accepted boolean DEFAULT false NOT NULL,
    terms_accepted_at timestamp with time zone,
    date_of_birth date
);

CREATE TABLE public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    svix_id character varying(255),
    resend_email_id character varying(255),
    event_type character varying(64) NOT NULL,
    recipient character varying(255),
    subject text,
    reason text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.email_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token character varying(128) NOT NULL,
    type character varying(30) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT email_tokens_type_check CHECK (((type)::text = ANY (ARRAY[('email_verification'::character varying)::text, ('password_reset'::character varying)::text])))
);

CREATE TABLE public.feed_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.feed_likes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.feed_post_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    product_id character varying(100) NOT NULL,
    product_name character varying(255),
    price numeric(10,2),
    store_id character varying(100),
    tap_x numeric(5,4),
    tap_y numeric(5,4)
);

CREATE TABLE public.feed_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    image_url text NOT NULL,
    caption text,
    likes_count integer DEFAULT 0,
    comments_count integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.flagged_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    flagged_for_cash_abuse boolean DEFAULT false NOT NULL,
    cash_refusal_count integer DEFAULT 0 NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.flash_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_name character varying(255) NOT NULL,
    category character varying(100),
    brand character varying(100),
    price numeric(10,2) NOT NULL,
    cost_price numeric(10,2),
    sizes jsonb DEFAULT '[]'::jsonb,
    stock_by_size jsonb DEFAULT '{}'::jsonb,
    image_url text,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    store_id uuid DEFAULT '91fff27c-c2bb-4f06-8147-c72cb9f8db7a'::uuid NOT NULL,
    CONSTRAINT flash_inventory_cost_price_non_negative CHECK (((cost_price IS NULL) OR (cost_price >= (0)::numeric))),
    CONSTRAINT flash_inventory_price_positive CHECK ((price > (0)::numeric))
);

CREATE TABLE public.marketing_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    applicant_type character varying(10) NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    city character varying(100),
    message text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT marketing_applications_applicant_type_check CHECK (((applicant_type)::text = ANY (ARRAY[('driver'::character varying)::text, ('seller'::character varying)::text])))
);

CREATE TABLE public.marketing_contact_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    subject character varying(100) NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.marketing_waitlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(20) DEFAULT 'customer'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT marketing_waitlist_role_check CHECK (((role)::text = ANY (ARRAY[('customer'::character varying)::text, ('seller'::character varying)::text, ('driver'::character varying)::text])))
);

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    sender_role character varying(10) NOT NULL,
    content text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT messages_sender_role_check CHECK (((sender_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text])))
);

CREATE TABLE public.order_cancellation_store_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_cancellation_id uuid NOT NULL,
    store_id uuid,
    amount numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.order_cancellations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    cancelled_by_id uuid,
    cancelled_by_role character varying(20) NOT NULL,
    reason text,
    refund_mode character varying(30),
    created_at timestamp with time zone DEFAULT now(),
    item_value_at_cancellation numeric(10,2) DEFAULT 0 NOT NULL,
    store_amount numeric(10,2) DEFAULT 0 NOT NULL,
    driver_amount numeric(10,2) DEFAULT 0 NOT NULL,
    customer_item_refund numeric(10,2) DEFAULT 0 NOT NULL,
    delivery_fee_refunded numeric(10,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid,
    product_id character varying(100) NOT NULL,
    product_name character varying(255) NOT NULL,
    size character varying(20),
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    total_price numeric(10,2) NOT NULL
);

CREATE TABLE public.order_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    stop_number integer NOT NULL,
    store_name character varying(255),
    pickup_address text NOT NULL,
    pickup_lat double precision,
    pickup_lng double precision,
    items_json jsonb DEFAULT '[]'::jsonb,
    status character varying(50) DEFAULT 'pending'::character varying,
    arrived_at timestamp with time zone,
    picked_up_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number character varying(50) NOT NULL,
    user_id uuid,
    driver_id uuid,
    store_id uuid,
    preferred_driver_id uuid,
    status public.order_status_enum DEFAULT 'created'::public.order_status_enum,
    delivery_mode character varying(20) DEFAULT 'fleet'::character varying,
    time_slot character varying(50),
    subtotal numeric(10,2) NOT NULL,
    delivery_fee numeric(10,2) NOT NULL,
    total numeric(10,2) NOT NULL,
    driver_payout numeric(10,2),
    payment_method character varying(50),
    payment_status character varying(50) DEFAULT 'pending'::character varying,
    delivery_payment_method character varying(20),
    delivery_payment_status character varying(30),
    store_paid boolean DEFAULT false,
    driver_paid boolean DEFAULT false,
    cash_to_collect numeric(10,2),
    cash_received_at timestamp with time zone,
    is_return_order boolean DEFAULT false,
    parent_order_id uuid,
    is_cash_delivery boolean DEFAULT false,
    paystack_reference character varying(255),
    payflex_order_id character varying(255),
    pickup_address text,
    dropoff_address text,
    pickup_lat numeric(10,8),
    pickup_lng numeric(11,8),
    dropoff_lat numeric(10,8),
    dropoff_lng numeric(11,8),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    cash_otp_hash character varying(255),
    cash_otp_expires_at timestamp with time zone,
    cash_otp_sent_at timestamp with time zone,
    cash_otp_verified_at timestamp with time zone,
    cash_otp_attempts integer DEFAULT 0,
    cancellation_penalty numeric(10,2) DEFAULT 0,
    scheduled_for timestamp with time zone,
    preferred_driver_expires_at timestamp with time zone,
    extra_stops integer DEFAULT 0,
    has_heavy_items boolean DEFAULT false,
    delivered_at timestamp with time zone,
    cash_otp_plain character varying(6),
    pickup_photo_public_id character varying(255),
    pickup_photo_resource_type character varying(20),
    pickup_photo_at timestamp with time zone,
    dropoff_photo_public_id character varying(255),
    dropoff_photo_resource_type character varying(20),
    dropoff_photo_at timestamp with time zone,
    stuck_delivery_flagged_at timestamp with time zone,
    driver_connection_flagged_at timestamp with time zone,
    premium_discount_applied numeric(10,2) DEFAULT 0 NOT NULL,
    acceptance_escalated_at timestamp with time zone,
    preparation_escalated_at timestamp with time zone,
    store_commission numeric(10,2),
    commission_rate_applied numeric(5,4),
    commission_rate_id uuid
);

CREATE TABLE public.payflex_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payflex_event_id character varying(255) NOT NULL,
    order_id character varying(255),
    event_status character varying(50),
    processed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.payment_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(50) NOT NULL,
    authorization_code text NOT NULL,
    auth_fingerprint character varying(64),
    last4 character varying(4) NOT NULL,
    brand character varying(50),
    exp_month integer NOT NULL,
    exp_year integer NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.payment_refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    payment_id uuid,
    amount numeric(10,2) NOT NULL,
    provider character varying(50),
    refund_reference character varying(255),
    status character varying(30) DEFAULT 'processing'::character varying NOT NULL,
    reason text,
    provider_response jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid,
    user_id uuid,
    amount numeric(10,2) NOT NULL,
    currency character varying(10) DEFAULT 'ZAR'::character varying,
    method character varying(50),
    provider character varying(50),
    provider_transaction_id character varying(255),
    status character varying(50) DEFAULT 'pending'::character varying,
    type character varying(20) DEFAULT 'store'::character varying,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public.payout_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payout_request_id uuid,
    driver_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    status character varying(30) DEFAULT 'initiated'::character varying NOT NULL,
    reference character varying(255) NOT NULL,
    recipient_code character varying(100),
    transfer_code character varying(100),
    provider_response jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);

CREATE TABLE public.premium_subscription_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    paystack_reference character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.premium_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    price numeric(10,2) DEFAULT 99.00,
    status character varying(20) DEFAULT 'active'::character varying,
    paystack_reference character varying(255),
    starts_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cancelled_at timestamp with time zone
);

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role character varying(20) DEFAULT 'user'::character varying NOT NULL,
    token character varying(200) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.return_request_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    return_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    quantity_returned integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    line_refund_amount numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.return_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid,
    user_id uuid,
    driver_id uuid,
    reason text,
    status character varying(50) DEFAULT 'requested'::character varying,
    credit_issued boolean DEFAULT false,
    credit_amount numeric(10,2),
    pickup_scheduled_at timestamp without time zone,
    picked_up_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    approved_at timestamp with time zone,
    approved_by uuid,
    return_order_id uuid,
    fee_amount numeric(10,2),
    refund_amount numeric(10,2),
    rejected_at timestamp with time zone,
    rejected_by uuid,
    rejection_reason text
);

CREATE TABLE public.revoked_tokens (
    jti character varying(200) NOT NULL,
    revoked_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    expires_at timestamp with time zone
);

CREATE TABLE public.saved_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    paystack_authorization_code character varying(255),
    last4 character varying(4) NOT NULL,
    card_type character varying(50),
    bank character varying(100),
    exp_month integer NOT NULL,
    exp_year integer NOT NULL,
    nickname character varying(100),
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.schema_migrations_ledger (
    version text NOT NULL,
    sha256 text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.settlement_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope_type character varying(20) NOT NULL,
    store_id uuid,
    cycle_days integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_config_cycle_days_check CHECK ((cycle_days > 0)),
    CONSTRAINT settlement_config_scope_store_check CHECK (((((scope_type)::text = 'global'::text) AND (store_id IS NULL)) OR (((scope_type)::text = 'store'::text) AND (store_id IS NOT NULL)))),
    CONSTRAINT settlement_config_scope_type_check CHECK (((scope_type)::text = ANY ((ARRAY['global'::character varying, 'store'::character varying])::text[])))
);

CREATE TABLE public.size_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    height_cm integer,
    weight_kg numeric(5,1),
    chest_cm numeric(5,1),
    waist_cm numeric(5,1),
    hips_cm numeric(5,1),
    shoulder_cm numeric(5,1),
    inseam_cm numeric(5,1),
    reference_brand_1 character varying(100),
    reference_size_1 character varying(20),
    reference_brand_2 character varying(100),
    reference_size_2 character varying(20),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.sos_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    triggered_by_role character varying(10) NOT NULL,
    triggered_by_id uuid NOT NULL,
    lat double precision,
    lng double precision,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sos_alerts_triggered_by_role_check CHECK (((triggered_by_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text])))
);

CREATE TABLE public.store_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_user_id uuid NOT NULL,
    store_id uuid NOT NULL,
    action_type character varying(50) NOT NULL,
    target_table character varying(50),
    target_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.store_boosts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    store_name character varying(255),
    boost_type character varying(50) NOT NULL,
    price_paid numeric(10,2) NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    product_id uuid,
    paystack_reference character varying(255)
);

CREATE TABLE public.store_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    return_id uuid,
    amount numeric(10,2) NOT NULL,
    balance numeric(10,2) NOT NULL,
    reason text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.store_password_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_user_id uuid NOT NULL,
    token character varying(128) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.store_promotions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    discount_percent integer,
    starts_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.store_settlement_line_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_settlement_id uuid NOT NULL,
    order_id uuid NOT NULL,
    item_value numeric(10,2) NOT NULL,
    store_commission numeric(10,2) NOT NULL,
    store_earnings numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_settlement_line_items_earnings_check CHECK ((store_earnings = (item_value - store_commission)))
);

CREATE TABLE public.store_settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    status character varying(20) NOT NULL,
    cycle_start timestamp with time zone NOT NULL,
    cycle_end timestamp with time zone NOT NULL,
    total_amount numeric(12,2),
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_settlements_cycle_check CHECK ((cycle_end > cycle_start)),
    CONSTRAINT store_settlements_status_check CHECK (((status)::text = ANY ((ARRAY['accruing'::character varying, 'under_review'::character varying, 'finalized'::character varying, 'paid'::character varying, 'adjusted'::character varying])::text[])))
);

CREATE TABLE public.store_transfer_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    recipient_code character varying(255) NOT NULL,
    bank_code character varying(20) NOT NULL,
    bank_name character varying(255),
    account_last4 character varying(4) NOT NULL,
    account_name character varying(255) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.store_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(20) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    force_password_reset boolean DEFAULT false NOT NULL,
    password_changed_at timestamp with time zone,
    welcome_email_status character varying(32),
    welcome_email_status_at timestamp with time zone,
    reset_email_status character varying(32),
    reset_email_status_at timestamp with time zone,
    CONSTRAINT store_users_role_check CHECK (((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('store_manager'::character varying)::text, ('inventory_staff'::character varying)::text, ('sales_staff'::character varying)::text, ('finance'::character varying)::text, ('marketing'::character varying)::text])))
);

CREATE TABLE public.stores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    address text,
    lat double precision,
    lng double precision,
    service_area_bounds jsonb,
    owner_name character varying(200),
    owner_email character varying(255),
    owner_phone character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    logo_url text,
    banner_url text,
    description text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    rejection_reason text,
    CONSTRAINT stores_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('under_review'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('suspended'::character varying)::text])))
);

CREATE TABLE public.transfer_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    recipient_code character varying(100) NOT NULL,
    account_number character varying(20) NOT NULL,
    bank_code character varying(10) NOT NULL,
    account_name character varying(255) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.trusted_drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trusted_drivers_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('declined'::character varying)::text])))
);

CREATE TABLE public.user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    blocker_id uuid NOT NULL,
    blocker_role character varying(10) NOT NULL,
    blocked_id uuid NOT NULL,
    blocked_role character varying(10) NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_blocks_blocked_role_check CHECK (((blocked_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text]))),
    CONSTRAINT user_blocks_blocker_role_check CHECK (((blocker_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text])))
);

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    phone character varying(50),
    address text,
    terms_accepted boolean DEFAULT false,
    terms_accepted_at timestamp without time zone,
    paystack_customer_code character varying(255),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    push_token text,
    cash_refusal_count integer DEFAULT 0,
    flagged_for_cash_abuse boolean DEFAULT false,
    email_verified boolean DEFAULT false,
    email_verified_at timestamp with time zone,
    apple_id text,
    google_id text,
    date_of_birth date
);

CREATE TABLE public.webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    paystack_event_id character varying(255) NOT NULL,
    event_type character varying(100) NOT NULL,
    processed_at timestamp with time zone DEFAULT now()
);

CREATE TYPE public.order_status_enum AS ENUM (
    'created',
    'payment_pending',
    'paid',
    'scheduled_for_morning',
    'pending_store_acceptance',
    'preparing',
    'waiting_for_driver',
    'driver_assigned',
    'driver_arrived_store',
    'picked_up',
    'in_transit',
    'delivered',
    'completed',
    'cancelled',
    'en_route'
);

CREATE UNIQUE INDEX idx_commission_rates_one_active_global ON public.commission_rates USING btree (scope_type) WHERE (((scope_type)::text = 'global'::text) AND (is_active = true));

CREATE UNIQUE INDEX idx_drivers_apple_id ON public.drivers USING btree (apple_id) WHERE (apple_id IS NOT NULL);

CREATE UNIQUE INDEX idx_drivers_google_id ON public.drivers USING btree (google_id) WHERE (google_id IS NOT NULL);

CREATE UNIQUE INDEX idx_payment_methods_user_provider_auth ON public.payment_methods USING btree (user_id, provider, authorization_code);

CREATE UNIQUE INDEX idx_payment_methods_user_provider_fingerprint ON public.payment_methods USING btree (user_id, provider, auth_fingerprint);

CREATE UNIQUE INDEX idx_settlement_config_one_active_global ON public.settlement_config USING btree (scope_type) WHERE (((scope_type)::text = 'global'::text) AND (is_active = true));

CREATE UNIQUE INDEX idx_store_settlement_line_items_order_id ON public.store_settlement_line_items USING btree (order_id);

CREATE UNIQUE INDEX idx_store_transfer_recipients_one_active ON public.store_transfer_recipients USING btree (store_id) WHERE (is_active = true);

CREATE UNIQUE INDEX idx_users_apple_id ON public.users USING btree (apple_id) WHERE (apple_id IS NOT NULL);

CREATE UNIQUE INDEX idx_users_google_id ON public.users USING btree (google_id) WHERE (google_id IS NOT NULL);
