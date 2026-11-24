# Flash — Production Schema Baseline (fixing N-18)

**Status:** v41 is in `migrate.js`, approved, and proven locally (§11). **v41 has NOT been run on production. `migrate.js` must never be run against production; see §6.** Running anything on production is a separate decision.

**As of:** 2026-11-19. Production schema dumped by the founder (read-only, Postgres 17.6, Session pooler). The comparison was built locally in a throwaway `postgres:17` container (17.12; no volume; bound to 127.0.0.1).

> **Rule, in force until a separate process is approved:** `migrate.js` must never be run against production, from a laptop or anywhere else. See §8.

---

## 1. How migrations work today (from reading `migrate.js` in full)

- **There is no migration-tracking table,** and there never has been on any branch (`main`, `production-readiness-audit`, `admin-platform`, `multi-tenant-stage*`). Every run of `node src/db/migrate.js` re-executes **all** of v1–v40 in order, each version on its own client in its own transaction (`migrate.js:114-1147`). "Versions" are only function names, and nothing records which have run.
- Idempotency rests entirely on `IF NOT EXISTS` and `DO $$` existence guards. Some statements are **not** no-ops on re-run (§6).
- **Version numbers collide across three branch lines:**
  - `multi-tenant-stage*` and `production-readiness-audit` (PRA) used v29–v35 for the store schema.
  - PRA's v36–v40 are main's v29–v33, renumbered (`migrate.js:1006-1065` documents this).
  - `admin-platform` used v34–v39 for different objects again.
  - **v41 is unused on every branch and in production's Supabase history,** so it is the next safe number.

## 2. Production's own migration history (`supabase_migrations.schema_migrations`)

Production has a Supabase migration-history table holding **10 rows applied through Supabase tooling** (dashboard SQL editor / MCP / CLI), outside `migrate.js`. The first column is a UTC timestamp, taken from the `version` field.

| # | Applied (UTC) | Supabase name | Main version | Commit that added it to main (UTC) | PR merged (UTC) |
|---|---|---|---|---|---|
| 1 | 2026-09-05 17:45 | `v29_marketing_leads` | v29 | `565ccdf` 09-05 17:43 | #10, 09-19 16:05 |
| 2 | 2026-09-23 10:53 | `v34_store_portal_schema_reconciliation` | v34 | `03e1c56` 09-23 10:52 | #11, 09-24 20:56 |
| 3 | 2026-09-23 11:09 | `v35_orders_store_created_composite_index` | v35 | `03e1c56` 09-23 10:52 | #11, 09-24 20:56 |
| 4 | 2026-09-25 10:44 | `add_stores_status_and_review_fields` | v36 | `23c2b0c` 09-25 10:24 | #12, 09-25 10:48 |
| 5 | 2026-09-25 18:48 | `add_email_events_and_store_user_email_status` | v37 | `6199dca` 09-25 18:17 | #19, 09-25 18:51 |
| 6 | 2026-09-26 11:00 | `v38_store_transfer_recipients` | v38 | `af02f68` 09-25 23:05 | #23, 09-26 11:06 |
| 7 | 2026-09-26 14:56 | `v39_commission_computation` | v39 | `172e26d` 09-26 11:40 | #24, 09-26 15:06 |
| 8 | 2026-09-30 20:58 | `v40_flash_inventory_price_constraints` | v40 | `96658c6` 09-30 20:55 | #27, 09-30 21:02 |
| 9 | 2026-10-02 22:00 | `flash_site_marketing_tables` | **none** (not in this repo) | — | (nearest: #33 at 23:31, unrelated) |
| 10 | 2026-10-02 22:46 | `drop_flash_site_marketing_tables` | **none** (a **DROP**) | — | — |

**Render deploys were not checked.** Dashboards are off-limits to this work, and Render's deploy IDs can't be read here. Per `OPEN_FOLLOWUPS` #16, the service auto-deploys `main` on merge, so each "PR merged" time above is also approximately when that code went live. In rows 1–8 the schema change was applied **before** the PR merged (minutes to days earlier), which is the expand-then-migrate order #16 describes.

### Which of production's objects came through which route

| Objects in production | Route |
|---|---|
| main v29, v34, v35, v36, v37, v38, v39, v40 | **Supabase tooling** (rows 1–8) |
| main v30 (`user_blocks`, `chat_reports`), v31–v33 (indexes, escalation columns) | **Not in the Supabase history.** These are identical to PRA's v37–v40, so they came from a **`migrate.js` run of the PRA line against production** (or of main with the same SQL). The date can't be determined from the repo. |
| `stores` (+ seeded store row), `store_users`, `store_actions`, `commission_rates`, `settlement_config`, `store_settlements`, `store_settlement_line_items`, the five `*_store_id_fkey` FKs, the `uuid` type on `store_boosts`/`store_promotions`/`brand_size_mappings.store_id`, and `flash_inventory.store_id NOT NULL DEFAULT <store>` | **Not in the Supabase history.** They match PRA v29–v35 exactly (`git show production-readiness-audit:backend/src/db/migrate.js`), so they came from a **`migrate.js` run of the PRA line against production.** Main's v34 comment says the same: "reached production via an earlier deploy of a different branch". |
| v1–v28 | `migrate.js` runs (before 2026-09-05) |
| Anything from `admin-platform` (`onboarding_verified_by`, `admin_password_tokens`, `admins.force_password_reset`) | **Not in production.** Absent from the dump. |

### Plain statement

**Production schema changes have been made through Supabase tooling, outside git and outside code review, including at least one `DROP` (row 10).** Other production schema changes came from `migrate.js` runs of an unmerged branch. **Production's schema history is therefore only partly recorded in this repo.** This document, and the committed baseline it describes, are the record from here on.

## 3. Do we need the SQL text of rows 9–10?

**Not for the baseline or the migration.** The public-schema diff (§4) has **no unexplained objects**: every production-only object traces to PRA v29–v35. So nothing created by row 9 survives in `public`, and nothing in `public` that main needs is missing. Every main table, including `marketing_waitlist`, `marketing_contact_messages` and `marketing_applications`, is present in production.

**It would matter for one other question:** whether row 10's `DROP` removed tables that held real data, or touched anything outside `public` (the dump is public-only). That is a data-loss and audit question for FOUND_ISSUES, not a schema-baseline one. If you want it answered, `scripts/schema-baseline/prod_supabase_marketing_statements.sh` reads the `statements` column of exactly those two rows, read-only. **Optional; not required for anything in this document.**

## 4. The drift, both directions

The comparison was **fresh** (an empty DB with `migrate.js` v1–v40 run) against **prod-copy** (an empty DB with the production dump restored). Both were dumped with the same `pg_dump` 17.12 and identical flags, then normalized (§7) and diffed.

**Totals:** **IN MIGRATE ONLY: 0. IN PROD ONLY: 22 statements. DIFFERENT DEFINITION: 6 real and 12 cosmetic.** Column order differs on 2 tables.

### 4.1 IN MIGRATE ONLY

**None.** Nothing `migrate.js` creates is missing from production, so there are no URGENT items.

### 4.2 IN PROD ONLY

| Object | Origin | Main code depending on it | Recommendation |
|---|---|---|---|
| FK `orders_store_id_fkey` → `stores(id)` | PRA v30 | `Order.create` writes `store_id` (`Order.js:166-175,288`); store-portal queries filter on it | **Adopt** (v41) |
| FK `store_boosts_store_id_fkey` | PRA v30 | `Boost.activateBoost` (`Boost.js:105-107`) | **Adopt** (v41) |
| FK `store_promotions_store_id_fkey` | PRA v30 | `Boost.createPromotion` (`Boost.js:124`) | **Adopt** (v41) |
| FK `brand_size_mappings_store_id_fkey` | PRA v30 | `Sizing.js:152,255` | **Adopt** (v41) |
| FK `order_cancellation_store_shares_store_id_fkey` | PRA v30 | `orderController.js:481`; `Admin.js:82-89` | **Adopt** (v41) |
| Index `idx_orders_store_id` | PRA v30 | store-portal order queries (also covered by v35's composite) | **Adopt** (v41) |
| Tables `settlement_config`, `store_settlements`, `store_settlement_line_items` (+ 3 primary keys, 4 FKs, 6 indexes: 16 dump statements) | `e022cfa` (Stage 1) / PRA v32, an **unmerged branch** | **Unused** (`git grep` on main finds no reference outside comments) | **ACCEPTED production-only orphans (founder decision, 2026-11-19).** Not adopted into v41. Their design predates, and is superseded by, the confirmed payment model (`PAYMENT_MODEL_AND_PORTAL_AUDIT.md` §4). Whether to remove them from production is a separate future decision. |

### 4.3 DIFFERENT DEFINITION, real (6)

| Object | Fresh DB | Production | Origin of prod form | Main code | Recommendation |
|---|---|---|---|---|---|
| `store_users_store_id_fkey` | `ON DELETE CASCADE` | no `ON DELETE` (NO ACTION) | PRA v33 | none deletes stores | **Adopt prod form** via a guarded drop-and-recreate (v41 item D1). Whether it *should* cascade is a product decision, recorded for FOUND_ISSUES. |
| `store_actions_store_id_fkey` | `ON DELETE CASCADE` | no `ON DELETE` | PRA v33 | none | **Adopt prod form** (v41 item D2) |
| `store_boosts.store_id` | `varchar(100) NOT NULL` | `uuid NOT NULL` | PRA v30 | `Boost.js:105-107` inserts **`'flash_closet'`** | **Adopt prod form** (v41 item T1). ⚠ This exposes a **live latent bug**: in production that insert fails on the `uuid` type, after Paystack has charged (once card goes live). For FOUND_ISSUES; not fixed here. |
| `store_promotions.store_id` | `varchar(100) NOT NULL` | `uuid NOT NULL` | PRA v30 | `Boost.js:124` (caller-supplied) | **Adopt prod form** (T2) |
| `brand_size_mappings.store_id` | `varchar(100) NOT NULL` | `uuid NOT NULL` | PRA v30 | `Sizing.js:152` filters on a URL param, so a non-UUID `:storeId` returns a 500 in prod | **Adopt prod form** (T3). Also for FOUND_ISSUES. |
| `flash_inventory.store_id` | `uuid` nullable, no default | `uuid NOT NULL DEFAULT '91fff27c-c2bb-4f06-8147-c72cb9f8db7a'::uuid` | PRA v34 | `Inventory.addProduct` sets no `store_id` (N-4) | **Adopt (founder decision): v41 item S1.** S1 seeds the "Flash Closet" store row under that exact UUID (values from `e022cfa`, `migrate.js:1813-1820`), then sets the default and `NOT NULL`. It is v41's **only data change**. In production the default settles N-4, but it silently assigns every store-less product to the first store once a second store exists (§8a). |

### 4.4 DIFFERENT DEFINITION, cosmetic (accepted differences)

**These are the ONLY accepted differences** (founder decision (a), 2026-11-19), together with the §4.2 settlement orphans. **Any other difference fails the comparison** (`normalize_schema.py --compare`).

**A. CHECK-constraint spelling: 16 constraints on 12 tables** (earlier counted as "12 constraints"; corrected):

| Table | Constraint |
|---|---|
| `chat_reports` | `chat_reports_reported_role_check`, `chat_reports_reporter_role_check`, `chat_reports_status_check` |
| `commission_rates` | `commission_rates_scope_store_check`, `commission_rates_scope_type_check` |
| `driver_commission_debts` | `driver_commission_debts_status_check` |
| `email_tokens` | `email_tokens_type_check` |
| `marketing_applications` | `marketing_applications_applicant_type_check` |
| `marketing_waitlist` | `marketing_waitlist_role_check` |
| `messages` | `messages_sender_role_check` |
| `sos_alerts` | `sos_alerts_triggered_by_role_check` |
| `store_users` | `store_users_role_check` |
| `stores` | `stores_status_check` |
| `trusted_drivers` | `trusted_drivers_status_check` |
| `user_blocks` | `user_blocks_blocked_role_check`, `user_blocks_blocker_role_check` |

- **The two spellings:** fresh prints `((col)::text = ANY ((ARRAY['a'::character varying, ...])::text[]))`; production prints `((col)::text = ANY (ARRAY[('a'::character varying)::text, ...]))`. The difference comes from how the stored expression was created, not from what it accepts.
- **Semantic test** (local container): both forms evaluated for `'user'`, `'driver'`, `'admin'` and `NULL` against `ARRAY['user','driver']` returned identical results: `t`, `t`, `f`, `NULL`.
- **Handled by rule N8 (§7)** only. N8 applies to these 16 names alone, and only when the column and values are carried through unchanged. Its self-test proves that a changed value, an extra value, a different column, or an unlisted constraint still fails.

**B. Column position: 2 tables.** `public.orders` (`preferred_driver_expires_at` and `cash_otp_plain` sit at different positions) and `public.stores` (`logo_url`, `banner_url`, `description`). These come from `ADD COLUMN` history, and changing them would require rewriting the table. Only position is ignored: each column's name, type, collation, default and nullability must still match exactly, and do. A position difference on any other table fails.

### 4.5 Facts this settles for `PROJECT_STATE.md`

- **N-4:** production has `flash_inventory.store_id NOT NULL DEFAULT <store>`, so **N-4 does not occur in production.** It does occur in fresh/test DBs. It's replaced in production by the "silently first store" risk above.
- **H-16:** production has `return_request_items_return_id_order_item_id_key UNIQUE (return_id, order_item_id)` (dump line 1801), so the duplicate-refund half is definitively wrong in production too.
- **N-18:** the drift is now fully enumerated. It's fixed for fresh DBs only once v41 is approved and merged.

## 5. Extensions

Production has `hypopg`, `index_advisor`, `pg_net`, `pg_stat_statements`, `pgcrypto 1.3` and `uuid-ossp 1.1` (schema `extensions`); `pg_graphql` (`graphql`); `supabase_vault` (`vault`); and `plpgsql` (`pg_catalog`).

**The public schema depends on none of them.** The dump makes zero references to the `extensions` schema, and all 65 UUID defaults use built-in `gen_random_uuid()`. Local fresh and prod-copy DBs therefore need no extensions, and restoring the dump produced only the expected `schema "public" already exists` error.

## 6. Statements that change data, lock, or can fail on existing data — CONFIRMED (B6)

There is no tracking table, so **every** run of `migrate.js` re-executes v1–v41. Line numbers are current (after v41 was added).

The B6 evidence, in two databases restored from production's schema:
- `pc_realistic`: production-like rows, with an active global rate and every saved card mirrored.
- `pc_trigger`: rows built to trigger each statement below.

Each table's row count, an MD5 over all rows, and its `relfilenode` were taken before and after. The lock behaviour was tested with `lock_timeout` while another session held a lock verified in `pg_locks`. Full outputs are in §11.

| Location | Statement | Guard | Measured result on a production-shaped DB |
|---|---|---|---|
| `migrate.js:176` | `ALTER driver_documents.file_url DROP NOT NULL` | none | Already nullable in prod: no change measured |
| `migrate.js:274-297` | `DELETE` duplicate `payments` rows | only if `payments_provider_transaction_id_key` is absent | Constraint present in prod, so **skipped**. A duplicate row cannot even be created there (`duplicate key value violates unique constraint`). |
| `migrate.js:645-658` | **`INSERT INTO payment_methods ... FROM saved_cards`** | `NOT EXISTS` + `ON CONFLICT`; runs **every time** | ⚠ **DATA CHANGED** in `pc_trigger`: `payment_methods` went from 1 to 2 rows. The card `AUTH_DELETED_BY_USER`, deleted by its user, was **resurrected**. No change in `pc_realistic`, where every card is mirrored. |
| `migrate.js:1852` (v27) | `ALTER orders.store_id TYPE UUID USING store_id::uuid` | none | **No table rewrite** (the `orders` relfilenode was unchanged). But it **needs ACCESS EXCLUSIVE**: blocked by a plain reader (`canceling statement due to lock timeout`). It also **rebuilds `orders`' store_id indexes and drops and recreates `orders_store_id_fkey`** (new OIDs). |
| `migrate.js:1901-1903` (v28) | `DROP DEFAULT`; `ALTER status TYPE order_status_enum`; `SET DEFAULT` | none | No table rewrite. `DROP DEFAULT` and `ALTER TYPE` each **need ACCESS EXCLUSIVE** (both timed out behind a reader), and the status indexes are rebuilt (new OIDs). |
| `migrate.js:2380` (v36) | `UPDATE stores SET status='approved' WHERE status IS NULL` | `WHERE status IS NULL` | `status` is NOT NULL in prod (a NULL is refused), so 0 rows |
| `migrate.js:2381-2382` (v36) | `SET DEFAULT` / `SET NOT NULL` on `stores.status` | none | No data change measured |
| `migrate.js:2635-2641` (v39) | **Seed `INSERT` of a 10% active global commission rate** | only if no active global exists | ⚠ **DATA CHANGED** in `pc_trigger`: `commission_rates` went from 1 to 2 rows. Next to a *deactivated* 15% global, a new **active 10%** global appeared. No change in `pc_realistic`. |
| v1–v40 `ADD CONSTRAINT` / `CREATE ... IF NOT EXISTS` | guarded | name guards | skipped (present in prod) |
| `migrate.js:20-111` (v7, v8) | `BEGIN` without `try/ROLLBACK` | — | not data-changing |
| **v41** (all items) | §9 | every item checks the catalog first | **Zero change**: on the prod-copy and on both data DBs, v41 alone left 66/66 tables unchanged (count, checksum, relfilenode) and all 494 catalog OIDs identical. **Zero DDL.** Its only lock on an application table is S1's `AccessShareLock` on `stores` (Proof 8). |

### Conclusion: running `migrate.js` on production is NOT safe

The following statements make it unsafe, each measured:
1. **`migrate.js:645-658` writes data.** It resurrects cards users deleted.
2. **v39 (`migrate.js:2635-2641`) writes data.** It inserts an active 10% global commission rate whenever none is active.
3. **v27 / v28 (`migrate.js:1852`, `:1901-1903`) take an `ACCESS EXCLUSIVE` lock on `orders` three times per run.** They also rebuild its `store_id`/`status` indexes and drop and recreate `orders_store_id_fkey`. While live, every order read and write would block behind them. There is no table rewrite.

v41 itself is not a cause: run alone, it is proven to do nothing on production's schema.

> **Rule: `migrate.js` must never be run against production** — from a laptop, an AI session, a Render shell or anywhere else. That holds until the statements above are fixed (or migrations become tracked and run-once) **and** a backup-first process (§8) is approved. **v41 has NOT been run on production.**

## 7. Normalization used for every comparison (`scripts/schema-baseline/normalize_schema.py`)

| # | Step |
|---|---|
| N1 | Drop SQL comment lines (`-- ...`) |
| N2 | Drop `\restrict` / `\unrestrict` lines (pg_dump ≥ 17.6 writes a random nonce) |
| N3 | Drop `SET ...;` and `SELECT pg_catalog.set_config(...)` session lines |
| N4 | Drop blank lines and trailing whitespace |
| N5 | Split into statements on lines ending in `;` |
| N6 | Inside each `CREATE TABLE`, sort column and constraint lines. Every line keeps the column's full definition (type, collation, default, nullability), so **only position** is ignored. Position is checked separately: it may differ only on `public.orders` and `public.stores`. |
| N7 | Sort all statements |
| N8 | **Narrow** CHECK-spelling rule: only for the 16 constraint names in §4.4 A, it rewrites the fresh spelling into production's, carrying the column and every value through unchanged. `--self-test` proves that a changed value list, an extra value, a different column, or an unlisted constraint is still reported, and that the production-only rule matches a statement's **own** table only (9/9 PASS, 2026-11-19). |

## 8. Future process (proposals, for the founder to decide)

**Rules proposed now:**
1. **`migrate.js` is never run against production from a laptop**, or by an AI session, ever.
2. **No production schema change except through the approved backup-first process below.** That includes the Supabase SQL editor, the Supabase MCP server and the Supabase CLI.
3. **Open decision (recommended): remove or disable the Supabase MCP server in `.vscode/mcp.json`,** or later point it at a staging project. Today it points at production (FOUND_ISSUES item, from the Phase 1 condition 5 list). Together with §2, this is the route by which unreviewed production DDL, including a `DROP`, has already happened. **To be logged in FOUND_ISSUES as High.**

**Superseded (2026-11-20):** the approved process is **`docs/PROD_MIGRATIONS.md`** (L0.2, #71): standalone migration files from v42 on, BEFORE/AFTER fingerprints, ledger, founder steps A–E. The draft below is kept for history.

**Proposed backup-first process** (draft, superseded):
1. A PR containing the migration is reviewed and merged, and CI passes, including the schema check (§10).
2. **Backup:** take a Supabase on-demand backup or a `pg_dump` of the full database, verified restorable, **before** anything runs.
3. Founder runs `prod_dump_schema.sh` (the before-dump).
4. The migration is run **once**, in a controlled one-off, ideally a single-version runner rather than all of `migrate.js`, given §6.
5. The founder takes the after-dump, and the diff between before and after must equal exactly what the PR said.
6. The baseline file is refreshed and committed (§10).

Prerequisite: fix §6's unsafe re-run statements, or move to tracked, run-once migrations. That's a separate, approved change.

## 8a. Items for `docs/FOUND_ISSUES.md`

`FOUND_ISSUES.md` does not exist yet; it is created in Phase 2. Listed here so none is lost.

| Sev | Item | Evidence |
|---|---|---|
| **High** | Production schema changed through Supabase tooling outside git and review, including a `DROP`. The Supabase MCP server in `.vscode/mcp.json` points at production. Decision: remove or disable it (or repoint to staging), and adopt the "no production schema change except the backup-first process" rule. | §2, §8 |
| **High** | **`migrate.js` is unsafe on production (CONFIRMED in B6).** It re-inserts deleted saved cards (`migrate.js:645-658`), takes an ACCESS EXCLUSIVE lock on `orders` three times per run and rebuilds its indexes and `orders_store_id_fkey` (v27 `:1852`, v28 `:1901-1903`; no table rewrite), and re-seeds a 10% commission rate when none is active (v39 `:2635-2641`). **Rule: never run `migrate.js` against production until these are fixed and a backup-first process is approved.** | §6, §11 |
| **High** | Production schema changes were applied through Supabase tooling **before their PRs merged**, i.e. before review (§2, rows 1–8: minutes to days ahead of merge). The written rule in §8 must cover the dashboard SQL editor, MCP and CLI, not only `migrate.js`. | §2, §8 |
| **High** (latent until card payments go live) | `Boost.activateBoost` inserts `'flash_closet'` into a `uuid` column (`Boost.js:105-107`), so it fails in production **after Paystack has charged**. | §4.3, `Boost.js:4,105-107` |
| Medium | `flash_inventory.store_id` defaults to the first store. Once a second store exists, products created without a store are silently assigned to it. | §4.3 |
| Info (corrects `PROJECT_STATE.md`) | **N-4 applies to fresh/test databases only, not production. H-16's duplicate-refund half is disproven** by `return_request_items_return_id_order_item_id_key UNIQUE` in production. | §4.5 |
| Medium (latent) | `brand_size_mappings.store_id` is `uuid` in prod, so `GET /api/sizing/recommend/:storeId/...` with a non-UUID `storeId` returns a 500. | §4.3, `Sizing.js:152` |
| Medium (decision) | Should `store_users` / `store_actions` cascade-delete with their store? Production: no; fresh: yes. v41 copies production. | §4.3 |
| Low (decision) | Settlement tables exist only in production: accepted as documented orphans; whether to remove them is a future decision. | §4.2 |
| Info | Whether row 10's `DROP` removed real data (optional read-only check). | §3 |

## 9. Migration v41 (in `migrate.js`, approved; **NOT run on production**)

`backend/src/db/migrate.js`: `async function migrateV41`, plus its runner block. `pool.end()` moved from v40's `finally` to v41's, per the rule at `migrate.js:1146`.

Everything runs in one transaction. Every item checks the catalog (`pg_attribute`, `pg_constraint`, `pg_class`/`pg_index`) and acts only on the exact fresh shape. On production's shape it does nothing. Anything else raises a `NOTICE 'v41: …'` and changes nothing.

| Item | Approved | Fresh DB → production definition | Guard on production |
|---|---|---|---|
| T1–T3 | ✔ | `store_boosts` / `store_promotions` / `brand_size_mappings.store_id` go from `varchar(100)` to `uuid` (only if every value is a UUID) | the column is already `uuid NOT NULL` |
| F1–F5 | ✔ | adds `orders` / `store_boosts` / `store_promotions` / `brand_size_mappings` / `order_cancellation_store_shares` `_store_id_fkey` → `stores(id)` (only if there are no orphan rows) | each FK exists with production's definition |
| I1 | ✔ (revised) | `CREATE INDEX idx_orders_store_id ON public.orders USING btree (store_id)`, after a `pg_class` check (not `IF NOT EXISTS`, which would lock `orders`) | the index exists |
| D1–D2 | ✔ | `store_users` / `store_actions` `_store_id_fkey`: guarded drop and recreate from `ON DELETE CASCADE` to production's NO ACTION | the delete rule is already `a` |
| S1 | ✔ | seeds the "Flash Closet" store (`91fff27c-…`, values from `e022cfa:backend/src/db/migrate.js:1813-1820`, `status='approved'`); then `flash_inventory.store_id SET DEFAULT '91fff27c-…'::uuid`, `SET NOT NULL` (only if there are no NULLs) | row exists (founder's read-only check: `seed_store_row_exists = 1`); the column is already `NOT NULL` with a default |

**Changes made after the independent review** (§11, Proof 6):
- Skips are now printed, through a `client.on('notice')` listener for the duration of v41, and the final line becomes `completed WITH N SKIP(S)`.
- S1 is now `IF NOT EXISTS … THEN INSERT`.
- Every check uses `to_regclass` and `pg_attribute`, never `information_schema`. `information_schema.columns.column_default` calls `pg_get_expr()`, which **locks the table**; Proof 8 caught this.
- Every item raises a NOTICE for a shape that is neither fresh nor production.
- A PL/pgSQL variable named `found` shadowed `FOUND` and broke D1/D2's guard. The new skip listener caught it, and it is now fixed (`hit`).

**Accepted exception (founder-approved "fix anything the review finds"):** S1's `IF NOT EXISTS (SELECT … FROM stores …)` takes an **`AccessShareLock` on `stores`**. It is the only application-table lock v41 takes on production's shape (Proof 8). An `AccessShareLock` conflicts only with `ACCESS EXCLUSIVE`.

**Not in v41:** the settlement orphans (§4.2), the cosmetic differences (§4.4), and the production-only `uuid-ossp` / `pgcrypto` extensions, which the public schema does not use (§5).

**Not proven by v41's own guards:** for S1 on production's shape, the guard checks "uuid, NOT NULL, has a default", not the default's exact value, because reading the value needs the locking `pg_get_expr()`. The exact value is enforced by the schema check's dump comparison (§10).

## 10. Repeatability: the schema check (B7)

**`scripts/schema-baseline/schema_check.sh`** (run from the repo root: `bash scripts/schema-baseline/schema_check.sh`):
1. Starts a throwaway `postgres:17` container: in-memory, bound to `127.0.0.1`, random password.
2. Refuses if `backend/.env` exists, or if the URL it built is not `127.0.0.1` / `localhost`.
3. Runs `migrate.js` (v1–v42) and **fails on any v41 skip** or if v41 or v42 does not report completion.
4. Dumps the schema and **fails unless both the dump and the baseline are non-empty and the CREATE TABLE counts are as expected**: fresh = baseline − 3 settlement orphans (64 = 67 − 3 since v42; 63 = 66 − 3 before). "Identical because empty" can never pass.
5. Runs `normalize_schema.py --self-test` (9 cases) and `--compare` against the committed **`scripts/schema-baseline/production_schema_baseline.sql`**, and fails on any unaccepted difference.

The committed baseline is production's `pg_dump` with comments, nonce lines and session `SET`s removed and statements sorted; column order is kept. **Since v42 it is the expected production schema _after_ the latest migration** (`docs/PROD_MIGRATIONS.md` §3). **v42 was applied to production on 2026-11-21 (07:55 SAST), and step E verified production == the v42 baseline** (`PROD_MIGRATIONS.md` §9). **On the v43 branch, the committed baseline is v43's AFTER: `689f03b4…`, 77,270 bytes, 67 tables, plus 67 `ENABLE ROW LEVEL SECURITY` statements. It equals production only once v43 is applied.** (**v43 was applied on 2026-11-21 at 11:09 SAST, and step E verified production == this baseline**, `PROD_MIGRATIONS.md` §9.) **On the v44 branch, the committed baseline is v44's AFTER: `83a42d48…`, 77,854 bytes, 68 tables (adds `feature_switches`). It equals production only once v44 is applied.** (**v44 was applied on 2026-11-21 at 14:17 SAST**, `PROD_MIGRATIONS.md` §9.) **On the v45 branch, the committed baseline is v45's AFTER: `aefbc6af…ce91ccd9`, 79,132 bytes, 69 tables (adds `admin_mfa_recovery_codes` and three TOTP columns plus `admins_totp_check` on `admins`). It equals production only once v45 is applied.** (**v45 was applied on 2026-11-24 at 01:35 SAST, and step E verified production == this baseline**, `PROD_MIGRATIONS.md` §9.) (**v44 was applied on 2026-11-21 at 14:17 SAST, and step E verified production == this baseline**, `PROD_MIGRATIONS.md` §9.) 73,021 bytes, 67 CREATE TABLEs, sha256 `4355621a…951cd3` (v42's AFTER fingerprint). Before v42 it was 72,732 bytes, 66 CREATE TABLEs, and passed the secret scan: the only quoted literals on `password`/`token` lines are the enum values `'email_verification'` and `'password_reset'`. **The raw dumps in `schema-baseline-input/` are git-ignored and never committed.**

**Negative tests run (2026-11-19):**
- Baseline with one CHECK value changed (`'approved'` → `'approvedX'` in `stores_status_check`, an N8-accepted constraint) → `RESULT: FAIL (2 unaccepted difference(s))`.
- Empty baseline → `SCHEMA CHECK FAILED: a dump is (near-)empty`.

**Refreshing the baseline (founder only; never Claude Code).** A migration PR updates the baseline itself (`PROD_MIGRATIONS.md` §4); a refresh from production is only needed to investigate drift, and step A of the next migration detects drift anyway:
1. In your own PowerShell window, set `FLASH_PROD_DB_URL` (Session pooler) with `Read-Host -AsSecureString`, as in B2.
2. `docker run --rm -e FLASH_PROD_DB_URL -v "${PWD}\scripts\schema-baseline:/s:ro" postgres:17 sh /s/prod_check.sh`, then check the database name and `session_read_only = on`.
3. `docker run --rm -e FLASH_PROD_DB_URL -v "${PWD}\scripts\schema-baseline:/s:ro" -v "${PWD}\schema-baseline-input:/out" postgres:17 sh /s/prod_dump_schema.sh`
4. `python -I scripts/schema-baseline/normalize_schema.py --baseline schema-baseline-input/prod_schema_public.sql > scripts/schema-baseline/production_schema_baseline.sql`
5. Secret-scan it, review the diff in a PR, and run `schema_check.sh`. `Remove-Item Env:FLASH_PROD_DB_URL`.

**Phase 6 (CI/CD) items added by this work:**
- Run `schema_check.sh` (or its CI equivalent) on every PR, so drift can't come back unnoticed.
- **Move CI's database from `postgres:15` to `postgres:17`** to match production (17.6). Today CI runs migrations and tests on 15. This PR's CI is the 15 check; local proofs ran on 17.12.

## 11. B6 proof results (local throwaway container `postgres:17` 17.12 only; never production)

Every dump is listed with its hash, size and CREATE TABLE count. Dumps were taken with `--restrict-key=flashbaselineproof`, so identical schemas give byte-identical files.

| Proof | What | Result |
|---|---|---|
| 1 | Empty DB + `migrate.js` v1–v41, compared with the committed baseline | `a2f98441…6bcc91`, 102,583 B, 63 tables; v41 skips 0; **`RESULT: PASS (0 unaccepted difference(s))`** (baseline `697134af…2a6962d`, 72,732 B, 66 tables) |
| 2 | Same DB, full `migrate.js` again | before = after = `a2f98441…6bcc91`, 102,583 B, 63 tables, **raw byte-identical**; `stores` rows 1 → 1; skips 0 |
| 2b | Same DB, v41 alone again | all 469 catalog OIDs and relfilenodes **identical** (the full run's new OIDs come from v27/v28, §6) |
| 3a | Prod-copy + seeded store, full `migrate.js` | before = after = `150fbd50…a8b33ef11`, 108,210 B, 66 tables, **raw byte-identical**; skips 0 (11 objects got new OIDs from v27/v28) |
| 3b | Prod-copy + seeded store, v41 alone | `150fbd50…`, 108,210 B, 66 tables, byte-identical; **all 494 OIDs identical, so zero DDL**; `stores` 1 → 1; skips 0 |
| 4 | Data-aware: `pc_realistic` and `pc_trigger`, v41 alone, then full run | v41 alone: **66/66 tables unchanged** in both. Full run: `pc_realistic` 66/66 unchanged; `pc_trigger` changed `commission_rates` 1→2 (v39 re-seed) and `payment_methods` 1→2 (deleted card resurrected). No `orders` rewrite. |
| 5 | Backend suite, `NODE_ENV=test`, placeholder secrets, local DB only | before v41 (v1–v40 DB): unit 623/623 (43 suites), integration 7/7 (2 suites). After v41: **identical** |
| 6 | Independent subagent review | **APPROVE WITH CHANGES** → all 7 required and 3 optional changes made (§9); proofs re-run on the final code |
| 7 | v41's acting and skip branches with data (v1–v40 DBs) | `acting_ok`: T1–T3 rewrote tables with **data unchanged**, `stores` +1 (S1), D1/D2 delete rule now `a`, schema = `a2f98441…` (**PASS** vs baseline); skips 0. `acting_skip`: **exactly 4 NOTICEs printed** (T1 `'flash_closet'`, F1 orphan order, F2 not-uuid, S1 NULL), final line "completed WITH 4 SKIP(S)", skipped tables unchanged, compare correctly **FAIL**s |
| 8 | Lock test (prod-copy, v41 alone, `lock_timeout=3s`) | another session holds ACCESS EXCLUSIVE on 8 app tables (all v41 touches except `stores`): **v41 completes**. With `stores` locked too: `lock timeout`, so S1's read of `stores` is the only app-table lock |
| — | `schema_check.sh` on the final code | `SCHEMA CHECK PASSED` (fresh 102,579 B / 63 tables; baseline 72,732 B / 66 tables). Negative tests fail as designed (§10) |

**Measurement errors caught during B6** (recorded so the method is trustworthy):
- An invalid byte comparison: a broken `grep` filter emptied both files, which is why their hashes matched. Redone with `--restrict-key`. This is why sizes and table counts are now always printed.
- A lock test whose background reader had already ended. Redone with the lock verified in `pg_locks` at the moment of the test.
- A path bug in the proof driver. Every result above comes from the re-runs.
