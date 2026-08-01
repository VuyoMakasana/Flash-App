# Flash — Business Domain Map

**Scope:** Business-domain analysis only. No code, no schema changes. Every claim grounded in Flash's real, existing code and business logic, or explicitly flagged as a business decision the founder needs to make. This is the domain layer beneath the ownership matrix, store-admin design, and multi-tenant blueprint already produced this engagement (`FLASH_STORE_ADMIN_DESIGN.md`, `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`) — it doesn't repeat their technical detail, it grounds the business concepts those documents already assumed.

**Reconciliation note, added deliberately, not an oversight:** the founder has since described the domain map using a different, second organizing principle — five functional domains (Identity, Commerce, Logistics, Finance, Platform Services) — distinct from the entity-based tree already below (Platform → Stores/Customers/Drivers/Administrators). §0 immediately below resolves this explicitly, presenting both structures and how they relate, before the entity tree (kept, corrected, and now cross-referenced against the functional domains) continues as originally written.

---

## 0. Reconciling two taxonomies — the functional domains and the entity tree are not competing, they answer different questions

**The functional domains answer "how is the system organized" — the top-level architectural categories a codebase, a team, or a service boundary would be structured around.** **The entity tree answers "who and what are the real things in Flash's business" — the actual nouns (Store, Customer, Driver, Order, Payment) that populate those architectural categories.** They're two different, compatible cuts through the same reality: a functional domain contains multiple entities, and a single entity can have real facets in more than one functional domain simultaneously — Store is the clearest case (it has an Identity facet via its Employees, a Commerce facet via its Products, a Logistics facet via fulfilling Orders, and a Finance facet via Commission/Settlement, all at once). Neither structure is picked over the other; this section is the explicit map between them.

### 0.1 The five functional domains, defined against real entities

| Functional domain | What it actually contains | Real entities/sub-domains from the tree below |
|---|---|---|
| **Identity** | Every real account type and how it authenticates — the cross-cutting layer every other domain depends on to know *who* is acting | Customer (`users`), Driver (`drivers`), Store User (`store_users`, designed), Flash Administrator (`admins`) |
| **Commerce** | The actual retail transaction domain — what's for sale, in what quantity, at what price, and how it's marketed | Store (as a business), Product, Inventory, Promotion |
| **Logistics** | The delivery execution domain — how an accepted order actually gets from a store to a customer | Order's full state machine (`ORDER_AUTHORITY_MATRIX.md`), Driver Assignment, the shared driver pool |
| **Finance** | Every money-movement concept, each with its own audit trail (`FINANCIAL_DOMAIN_SPECIFICATION.md`) | Customer Payment, Store Commission, Store Settlement, Delivery Fee, Driver Earnings, Driver Payout, Refunds, Commission/Financial Adjustments, Taxes |
| **Platform Services** | The cross-cutting, Flash-operated layer that supports every domain above without itself being a customer-facing business concern | The internal AdminJS panel, `admin_actions` audit logging, notification infrastructure (`notificationService.js`), platform-wide moderation/support actions |

### 0.2 The one clear, consistent final structure — functional domains as the top-level, the entity tree nested within

Going forward, this is the definitive combined structure: the five functional domains are the primary architectural categories; the entity tree in §1 below is retained exactly, now understood as describing the real business actors that live *within* Commerce and Logistics specifically (with Identity, Finance, and Platform Services cutting across it, per §0.1's table, rather than being separate branches of the same tree). No entity or table listed anywhere in this document set needs to move or be renamed — this section is a lens applied on top of the existing structure, not a restructuring of it.

---

## The entity tree, as the founder originally sketched it, with each node resolved against real code

```
Platform (Flash)
├── Stores
│     ├── Employees      → NOT YET BUILT (designed: store_users, FLASH_STORE_ADMIN_DESIGN.md §3)
│     ├── Products       → flash_inventory (exists, no store_id yet)
│     ├── Inventory      → flash_inventory.stock_by_size (exists, single-store today)
│     ├── Orders         → orders + orderStateMachineService.js (exists, fully built)
│     ├── Payouts        → renamed Store Commission + Store Settlement (§2 below) — DESIGNED, not yet built (FINANCIAL_DOMAIN_SPECIFICATION.md §2-3)
│     ├── Promotions     → store_boosts, store_promotions (exist, single-store today)
│     └── Settings       → NOT YET BUILT (no stores table exists at all yet)
├── Customers            → users (exists, fully built)
├── Drivers               → drivers, driver_wallets, driver_wallet_ledger, driver_payout_requests, payout_transactions (exists, fully built, already audited)
└── Flash Administrators → admins, admin_actions (exists, fully built — the internal AdminJS panel)
```

---

## 1. Platform (Flash)

**What it actually is:** Flash itself — the company that owns the delivery network, the driver pool, the backend, and (today) the single real store. Flash is simultaneously the *platform operator* (drivers, delivery logistics, payments infrastructure) and, today, the *only store* (`"flash_closet"`, per `store_boosts`/`store_promotions`'s literal string tag). These are two conceptually distinct roles Flash happens to occupy at once right now — a fact with real financial consequences, see §4 (Financial Domain Specification, Store Settlements) for why this distinction matters the moment a second, independently-owned store exists.

**Real code:** No single "Platform" table — it's the implicit root everything else in this codebase already assumes (there being no `stores` table means "the platform" and "the store" are currently the same undifferentiated thing).

---

## 2. Stores

**What a Store actually is in Flash's real business:** a physical clothing retailer whose inventory Flash's drivers deliver same-day. Not a warehouse Flash itself stocks — a real, independent retail business with its own product range, its own staff, and its own commercial relationship with Flash (a cut of each sale, in exchange for Flash handling discovery, payment, and delivery).

**Confirmed, explicit architectural principle — stated once here, binding on every document in this initiative:** Flash is architected for genuinely independent merchants as the primary case, from day one, with no exceptions. Every Store gets independent ownership, authentication, employees, permissions, products, inventory, analytics, reports, and settlements (`FINANCIAL_DOMAIN_SPECIFICATION.md` §3, §6). A future Flash-owned second location is not a separate, simpler design path — it is the same real architecture, degenerately applied to a case where Flash happens to also own the store. Today's single, implicit `"flash_closet"` store is the *current state*, not the *design target* — every document in this initiative is checked against this principle, not against what happens to be true today.

**Real code today:** no `stores` table exists (confirmed: `SELECT to_regclass('public.stores')` returns `NULL` against production). Every table that references a store today (`orders.store_id`, `store_boosts.store_id`, `store_promotions.store_id`, `brand_size_mappings.store_id`) either sits `NULL` (`orders`) or holds the single literal string `"flash_closet"` (`store_boosts`/`store_promotions`) — there has only ever been one, implicit, unmodeled store.

### 2.1 Employees

**What it is:** the real people who work for a store — an owner, managers, staff who pack orders, staff who manage stock. Not Flash's own team (that's the separate Flash Administrators domain, §5).

**Real code:** none. This is the `store_users` table designed but not yet built in `FLASH_STORE_ADMIN_DESIGN.md` §3 — six roles (Owner, Store Manager, Inventory Staff, Sales Staff, Finance, Marketing), its own auth domain, deliberately never the `admins` table.

### 2.2 Products

**What it is:** the actual clothing items a store sells — a shirt, a pair of jeans, a specific size and price.

**Real code:** `flash_inventory` (`id`, `product_name`, `category`, `brand`, `price`, `cost_price`, `sizes`, `stock_by_size` JSONB, `image_url`, `description`, `is_active`) — real, live, no `store_id` column today.

**The genuinely unresolved business question, resolved as far as the evidence supports, flagged for explicit founder confirmation:** does Flash's business model ever have two different stores selling the *same underlying product listing* — a shared catalog item two stores both draw stock from — or is every product row always uniquely and permanently one store's own item?

The evidence in this codebase points strongly toward **every product belongs to exactly one store, permanently — no shared listings**:
- `CLAUDE.md` describes Flash as a "two-sided **marketplace**," not a single-inventory retailer — the standard real-world shape of a delivery marketplace (the same shape as a food-delivery platform, where "Burger X from Restaurant A" and "an identical-sounding Burger X from Restaurant B" are always two separate menu items, never one shared listing two restaurants draw from) is that each store's catalog is independently owned and never overlaps with another store's, even for superficially identical items.
- Nothing in the current schema, `Order.create()`'s stock-decrement logic, or any existing document anywhere in `docs/audits/` describes or even gestures at a "multiple sellers, one listing" concept — no SKU-sharing table, no "which store fulfilled this specific unit" disambiguation logic exists or was ever designed for.
- `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.2's `store_stock` design (a join table for *one* store's stock across *multiple physical locations of that same store*) is a genuinely different question from this one, and shouldn't be conflated with it: that table exists to answer "does Store A's own second branch have independent stock from Store A's first branch," not "do Store A and Store B share a listing."

**If this reading is correct** (every product permanently one store's own item, never shared), the technical consequence is exactly as the founder's own framing anticipated: a single, non-nullable `store_id` column directly on `flash_inventory` is sufficient — no separate cross-store stock-sharing table is ever needed for the *ownership* question (the *multi-location* question, §2.3 below, is separate and already scoped in the multi-tenant blueprint).

**This is presented as a business decision requiring explicit confirmation, not a technical one this document decides** — the evidence is one-directional and the real-world delivery-marketplace precedent is strong, but "does Flash ever want two stores to co-list the same physical product" is a genuine commercial-model question (e.g., could two boutiques both stock and jointly list the same designer brand's identical item?) that only the founder can answer with certainty.

### 2.3 Inventory

**What it is:** how many units of a given product, in a given size, a store actually has on hand right now — distinct from the Product itself (the *listing*: name, price, description) which doesn't change per unit sold.

**Real code:** today, collapsed into `flash_inventory.stock_by_size` — one JSONB column per product, store-wide (implicitly, since there's only one store). `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.2 already correctly identifies this as the one place a real *structural* change (a `store_stock` join table: `store_id` × `product_id` × `size` × `quantity`) is needed, not just an additive column — but that need is about a single store operating multiple physical *locations*, a separate question from §2.2's ownership question above. If §2.2 is confirmed (no shared listings), Inventory's per-store scoping is trivial (`store_id` directly on `flash_inventory`); the *multi-location-per-store* refinement remains exactly as already scoped in the multi-tenant blueprint, independent of this document's finding.

### 2.4 Orders

**What it is:** a customer's real purchase — items, delivery details, payment, and its full lifecycle from creation through delivery.

**Real code:** `orders` + `order_items`, and the full state machine in `orderStateMachineService.js` — the most mature, most heavily audited domain in this entire codebase. See `ORDER_AUTHORITY_MATRIX.md` for the complete, state-by-state authority breakdown.

### 2.5 Payouts → resolved into two distinct, named concepts

**What it is, and the real ambiguity the founder flagged and has since resolved:** the phrase "Payout" caused real confusion because it was used for two genuinely different real-world events — Flash paying a *driver* for a completed delivery (real, built, audited: `driver_wallets`/`driver_wallet_ledger`/`driver_payout_requests`/`payout_transactions`), and Flash paying a *store* its share of what customers bought (confirmed: zero code anywhere computed or paid this for a normal, completed order — the actual finding that prompted the founder's ten business decisions). This sub-domain of "Stores" refers specifically to the second concept, now split into two precisely-named, separately-designed pieces: **Store Commission** (Flash's configurable cut of item value, `FINANCIAL_DOMAIN_SPECIFICATION.md` §2 — 10% launch rate, never hardcoded) and **Store Settlement** (the actual weekly-by-default disbursement to the store, §3 of the same document). Both are designed, real architecture; neither is built yet.

### 2.6 Promotions

**What it is:** a store's own marketing — boosted visibility in the app, discount vouchers.

**Real code:** `store_boosts` (paid visibility boost, real Paystack charge, `purchaseBoost`) and `store_promotions` (discount codes, `createPromotion`) — both real, both currently only ever created against the single `"flash_closet"` store tag. Confirmed via `Admin.getFinancials()`'s own comment: boost/promotion purchase prices are **excluded from revenue** because `purchaseBoost`/`createPromotion` only insert a DB row and never actually charge anything through Paystack today — a real, already-flagged gap (not new to this document) worth restating precisely here: today, "Promotions" is a real feature with no real payment collection behind it yet.

### 2.7 Settings

**What it is:** a store's own profile — name, address, operating hours, and (once `store_users` exists) who its Owner/staff are.

**Real code:** none — doesn't exist because the `stores` table itself doesn't exist yet. Scoped conceptually in `FLASH_STORE_ADMIN_DESIGN.md` §6.2.

---

## 3. Customers

**What it is:** the people who buy clothes through Flash — same-day delivery shoppers.

**Real code:** `users` table — name, email, phone, addresses, cash-refusal tracking, Flash Premium subscription status. Fully built, fully audited (`ACCESS_SECURITY_AUDIT.md`, ownership checks throughout `orderController.js`/`paymentController.js`). A customer is never store-scoped — they simply place an order that happens to be fulfilled by one store, the same way `SALEOR_ARCHITECTURE_STUDY.md` §1.4 confirms a Saleor customer isn't "a member of" one Channel.

---

## 4. Drivers

**What it is:** the people who physically collect items from a store and deliver them to a customer — Flash's own logistics workforce, shared city-wide across every store, not dedicated to any one store.

**Real code:** `drivers`, `driver_wallets`, `driver_wallet_ledger`, `driver_payout_requests`, `payout_transactions`, `driver_documents`, `driver_ratings`, `driver_subscriptions`, `driver_commission_debts` — the most mature financial domain in this codebase (see `FINANCIAL_DOMAIN_SPECIFICATION.md` §2). Confirmed, not assumed, by `autoMatchService.js`'s real nearest-driver query (`autoMatchService.js:36-56`): zero store filtering — any online driver can be matched to any store's order, by design, matching Flash's actual shared-fleet business model (`MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.3's own confirmed finding).

---

## 5. Flash Administrators

**What it is:** Flash's own internal team — today, just the founder — who operate the platform itself: approving drivers, handling disputes, viewing platform-wide financials, managing the one real store's orders directly (since Flash currently *is* the store).

**Real code:** `admins`, `admin_actions`, the AdminJS panel (`backend/src/adminPanel.js`, mounted at `/admin-panel`) — fully built, fully live, and explicitly **not** to be extended for store-facing use (`FLASH_STORE_ADMIN_DESIGN.md`'s core correction). A Flash Administrator is platform-wide by definition — never store-scoped, never confined to one store's data.

---

## 6. Cross-domain relationships worth stating explicitly

- **A Store's Order is the same real row as a Customer's Order** — `orders` is a single shared table, not duplicated per domain, matching the Channel-as-shared-table pattern `SALEOR_ARCHITECTURE_STUDY.md` §1.4 confirms is how a mature platform actually does this (an additive `store_id` scoping column, not a separate per-tenant table or database).
- **A Driver serves every Store, never one** — confirmed structural fact (§4 above), not a default — the multi-tenant blueprint's explicit recommendation is to keep this unchanged even once multiple stores exist.
- **Today, "Store" and "Platform" are the same entity** — every business rule currently encoded anywhere in this codebase (commission formulas, the cancellation split, promotions) implicitly assumes this. The moment a genuinely independent third-party store exists, every one of those rules needs to be re-examined for which entity (Flash-the-platform or Store-the-merchant) it actually applies to — this is the precise reason `FINANCIAL_DOMAIN_SPECIFICATION.md`'s Store Settlements section exists as its own, explicit, currently-unbuilt concept rather than an assumed extension of something that already works.

---

## What this document is not

Business-domain analysis only. No code was written, no schema was changed. §2.2's shared-catalog-vs-per-store question is presented as a business decision for the founder to explicitly confirm, not decided here — everything downstream (`store_id` placement, whether a cross-store stock-sharing mechanism is ever needed) depends on that answer.
