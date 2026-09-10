# Flash — Domain Ownership & Authority Specification

**Scope:** Business-domain analysis only. No code, no schema changes. Builds directly on `BUSINESS_DOMAIN_MAP.md`; doesn't re-derive it. Real citations throughout; every genuine business-policy gap (not yet decided anywhere in this codebase) is named as such, not silently assumed.

**Standing rule, confirmed by the founder — binding on all future implementation work, not just this initiative:** this document is the primary source of truth every API authorization rule, database ownership relationship, query filter, RBAC permission, and frontend visibility rule must trace back to. No permission decision gets implemented ad hoc during the eventual build — if a future engineer (human or AI) needs to decide who can do what to a given entity, the answer starts here, not in a fresh judgment call made in the middle of writing a route handler. If this document doesn't yet cover a case the build needs, the correct order of operations is to update this document first, get it reviewed, then implement — never the reverse.

**The seven authority types, defined precisely once, applied consistently below:**

| Authority type | Question it answers |
|---|---|
| **Owned by** | Whose data is this, fundamentally — who does it belong to? |
| **Can read** | Who may view it at all? |
| **Can modify** | Who may change its non-status fields (name, price, address, etc.)? |
| **Can approve** | Who may move it through a real workflow gate (e.g. accept an order, approve a driver)? Distinct from ordinary modify. |
| **Can override** | Who may bypass the normal rule in an exceptional case (e.g. force-cancel, force-complete)? Distinct from ordinary approve — an override exists specifically to break the normal flow. |
| **Can delete** | Who may remove it entirely? (Flash's own standing rule — `CLAUDE.md` — is "never delete data unless explicitly requested," so for most entities this is "nobody, in practice," stated precisely rather than left implicit.) |
| **Is audited by** | What real, existing (or needed) log captures who did what to this entity? |
| **Triggers notification to** | Who is told, automatically, when this entity changes? |

---

## 1. Store

*(`stores` table — designed, not yet built; `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §2)*

| Authority | Answer |
|---|---|
| **Owned by** | Itself, as a business entity — no other domain owns a Store. Flash (the platform) hosts it; a Store's Owner-role staff run it. |
| **Can read** | Its own Owner/staff (`store_users` scoped to that `store_id`); Flash Administrators (platform-wide visibility, per `BUSINESS_DOMAIN_MAP.md` §5); **not** other stores, ever — the exact tenant-isolation boundary `FLASH_STORE_ADMIN_DESIGN.md` §5.1 treats as CRITICAL. |
| **Can modify** | Store Owner (name, address, hours — its own Settings, §2.7 of the domain map); Flash Administrators (platform-level correction/support). |
| **Can approve** | Flash Administrators approve a Store's *existence* (onboarding a new store is an internal Flash decision, per `FLASH_STORE_ADMIN_DESIGN.md` §7's explicit scope note — no self-service signup exists or is designed). |
| **Can override** | Flash Administrators — e.g. deactivating a store (`is_active = false`) regardless of the Owner's wishes, for a real business/compliance reason. |
| **Can delete** | Nobody, in practice — `is_active = false` (a real, already-established pattern, e.g. `flash_inventory.is_active`) is the correct mechanism, never a hard delete, matching the standing "never delete data" rule and preserving every historical order's real `store_id` reference. |
| **Is audited by** | Not yet designed — needs a Flash-internal audit trail for store-level admin actions (activate/deactivate, onboard), most naturally the existing `admin_actions` log (this action is Flash-internal, not store-internal, so it belongs there, not in the new `store_actions` log). |
| **Triggers notification to** | The Store's Owner, on any Flash-initiated change to their own store (e.g. deactivation) — not yet built, since Stores don't exist yet. |

---

## 2. Store User (Employee)

*(`store_users` — designed, not yet built; `FLASH_STORE_ADMIN_DESIGN.md` §3.2)*

| Authority | Answer |
|---|---|
| **Owned by** | The Store they belong to (`store_id`, non-nullable by design). |
| **Can read** | The Store's own Owner (all staff); a Store Manager (per `FLASH_STORE_ADMIN_DESIGN.md` §5.3's RBAC table, likely their own peer staff, not decided precisely here — a real, small open question, see below); Flash Administrators (platform-wide, for support). A store user can always read their own record. |
| **Can modify** | The Store's Owner (add/remove staff, change roles — `FLASH_STORE_ADMIN_DESIGN.md` §6.2's Settings screen); a Store User can modify their own non-role fields (name, password) but never their own role (a real, necessary self-escalation guard — not yet built, flagged here so it isn't missed). |
| **Can approve** | The Store's Owner approves a new staff member's account (creation) — no public self-signup, matching §1's Store onboarding note. |
| **Can override** | Flash Administrators — e.g. disabling a rogue/compromised store account platform-wide, a real incident-response capability that must exist even though it's Flash acting outside a store's own hierarchy. |
| **Can delete** | Nobody, in practice — deactivate (`is_active = false`), never hard-delete, same reasoning as Store, and because a deleted `store_user_id` would break the `store_actions` audit trail's ability to attribute historical actions. |
| **Is audited by** | The new `store_actions` log (`FLASH_STORE_ADMIN_DESIGN.md` §5.4) for what a store user *does*; a separate, not-yet-designed record of role/staff changes themselves (who added/removed/promoted whom) — a real gap worth naming, since `store_actions` as designed logs actions *on orders/inventory*, not necessarily staff-management actions on `store_users` itself. |
| **Triggers notification to** | The affected Store User, on their own account changes (role change, deactivation) — a real, standard security notification pattern (matching how `notificationService.js` already notifies users/drivers of account-level events), not yet built. |

**Real open question, not decided here:** can a Store Manager see/manage other staff, or is that Owner-only? `FLASH_STORE_ADMIN_DESIGN.md` §5.3's RBAC table doesn't explicitly grant Store Manager staff-visibility — worth the founder's explicit confirmation before `store_users`'s own `isAccessible`-equivalent rules are written.

---

## 3. Product

*(`flash_inventory` — real, live, no `store_id` yet)*

| Authority | Answer |
|---|---|
| **Owned by** | The Store that lists it (per `BUSINESS_DOMAIN_MAP.md` §2.2's finding — pending founder confirmation — permanently one store's own item, never shared). |
| **Can read** | Everyone — customers browse the catalog publicly (the whole point of a product listing); the owning store's staff see full detail (cost price, etc.) other stores never should. |
| **Can modify** | The owning store's Inventory Staff/Store Manager/Owner (`FLASH_STORE_ADMIN_DESIGN.md` §5.3); Flash Administrators (platform support/moderation — e.g. removing a listing that violates policy). |
| **Can approve** | Not applicable today — a product goes live the moment a store creates it, no Flash review gate exists or is designed. A real, open business question: should Flash ever moderate/approve a new listing before it's publicly visible, the way a real marketplace often does? Not decided here — flagged as a genuine policy choice, not a technical one. |
| **Can override** | Flash Administrators — delist a product platform-wide regardless of the store's wishes (policy violation, counterfeit concern, etc.). |
| **Can delete** | Nobody in the sense of a hard delete of a product with real order history (would corrupt `order_items.product_id`'s historical record) — `is_active = false` is the real, already-existing mechanism. A genuinely new, never-ordered product could arguably be hard-deleted safely, but the current codebase doesn't distinguish this case anywhere, so the safe default is "never," matching `flash_inventory`'s existing pattern. |
| **Is audited by** | Not yet designed for store-initiated changes (needs `store_actions`); Flash-initiated overrides belong in `admin_actions`. |
| **Triggers notification to** | Nobody automatically today (no "your product was delisted" notification exists) — a real gap worth naming if Flash ever exercises the override above; not yet built. |

---

## 4. Variant (Flash's real equivalent: size + per-size stock, not a separate table)

**Named precisely because Flash's real data model differs from a generic e-commerce "Product → Variant" split**, per `SALEOR_ARCHITECTURE_STUDY.md` §1.4's own finding: Saleor's `ProductVariant` is a real, separate row (its own SKU, its own price override, its own stock). Flash's `flash_inventory` instead holds `sizes` (an array) and `stock_by_size` (a JSONB map) as two columns *on the product row itself* — there is no separate Variant entity in the current schema. The authority answers below are therefore identical to Product's (§3) in practice, since a size is a field within the same row, not an independently-owned entity:

| Authority | Answer |
|---|---|
| **Owned by** | Same as Product — the size/stock fields aren't independently owned. |
| **Can read / modify / approve / override / delete / audited by / notifies** | Identical to Product (§3) — there is no independent authority boundary for "this specific size" versus "this product," because they're the same database row. |

**Worth naming as a real, deliberate design question for the eventual Store Admin Portal's Inventory screen (not decided here):** if per-size stock adjustment ever needs its *own* granular audit trail (e.g. "who marked size M as out of stock, separately from who changed the price"), that would require Flash to introduce a real, separate variant-level table — a genuine structural change, not yet needed and not recommended pre-emptively, matching this engagement's own "don't build for a need that doesn't exist yet" standard.

---

## 5. Inventory (stock level, distinct from the Product listing itself)

*(`flash_inventory.stock_by_size` today; `store_stock` if `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.2's multi-location need ever materializes)*

| Authority | Answer |
|---|---|
| **Owned by** | The owning store (same as Product). |
| **Can read** | Publicly, an aggregate "in stock / out of stock" signal (customers checking out); the owning store's staff see exact counts. |
| **Can modify** | Inventory Staff/Store Manager/Owner (manual adjustment); the **system itself** modifies it automatically on every order (`Order.create()`'s stock-decrement logic, `Order.js:142-212`) — this automatic, order-driven modification is the dominant real-world case, worth stating explicitly since it's easy to design a permission model that only considers human actors. |
| **Can approve** | Not applicable — stock changes take effect immediately, no approval gate exists or is designed. |
| **Can override** | Flash Administrators — a real, already-necessary capability for correcting a stock-count bug or dispute, though no dedicated admin action for this exists yet (today it would require a direct DB correction). |
| **Can delete** | Not applicable — stock is a quantity, not a record to delete; setting it to zero is a modification, not a deletion. |
| **Is audited by** | **Not built at all today** — a real, precise gap worth naming plainly: there is no ledger of stock changes anywhere in this codebase (unlike `driver_wallet_ledger`'s real, append-only pattern for money). A stock discrepancy today is undebuggable after the fact — you can see the current count, never the history of how it got there. Worth flagging for the eventual Store Admin Portal's Inventory screen, not decided here whether it's in scope for a first build. |
| **Triggers notification to** | Nobody automatically today — a real, plausible future need ("notify Inventory Staff when a size drops to zero") that doesn't exist yet. |

---

## 6. Order

*(`orders`, `order_items`, `orderStateMachineService.js` — real, live, fully audited; full state-by-state breakdown in `ORDER_AUTHORITY_MATRIX.md`, this section is the entity-level summary)*

| Authority | Answer |
|---|---|
| **Owned by** | The Customer who placed it (`orders.user_id`) — an order is fundamentally the customer's transaction, fulfilled by a store and a driver, not owned by either of those. |
| **Can read** | The owning Customer; the fulfilling Store's staff (once `store_id` is real and populated, per `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` §1.3); the assigned Driver (their own active delivery only — confirmed real pattern, `driverController.js`'s `String(order.driver_id) !== String(req.userId)` checks throughout); Flash Administrators (platform-wide). |
| **Can modify** | Nobody modifies an order's core content (items, price) after creation — Flash's real model has no "edit an order" concept, only state transitions and cancellation. This is itself a real, deliberate finding worth stating: unlike Saleor's `order_line_update.py` (`SALEOR_ARCHITECTURE_STUDY.md` §1.2), Flash has no order-line-editing mutation anywhere in this codebase. |
| **Can approve** | The Store (Accept, `pending_store_acceptance` → `preparing`); the assigned Driver (implicitly, by acting through each subsequent state); see `ORDER_AUTHORITY_MATRIX.md` for the complete per-state breakdown. |
| **Can override** | Flash Administrators, via the internal AdminJS panel's existing actions (`acceptOrder`/`rejectOrder`/`markReadyForPickup`, usable regardless of which store the order belongs to, since Flash Administrators are platform-wide by definition) — and the **system** itself, via the 15-minute timeout cron's automatic cancel-and-refund (`server.js`), which is a real, automated override of the normal "store must act" flow. |
| **Can delete** | Nobody, ever — an order is a permanent financial/legal record. No delete path exists anywhere in this codebase for a real order; only `cancelled` as a terminal state. |
| **Is audited by** | `orderStateMachineService.js`'s own `logTransition` (every state change, who, when — currently console-logged, not persisted to a queryable table, a real, pre-existing gap worth naming: today this history is only reconstructable from `updated_at`/`delivered_at` timestamps and the separate `order_cancellations` table, not a single unified event log). |
| **Triggers notification to** | The Customer (every state change, `notifyOrderStatusChange` → `notificationService.js`); the Driver (assignment, per `notifyDriversNewOrder`-equivalent logic in `markReadyForPickup`); Flash Administrators, only for exceptional events (SOS, stuck-order flags — not routine state changes). |

---

## 7. Driver Assignment

*(the real, transient relationship between an Order and a Driver — not a separate table, expressed via `orders.driver_id` + the wallet-crediting side effects in `orderStateMachineService.js`)*

| Authority | Answer |
|---|---|
| **Owned by** | Jointly the Order and the Driver — neither the Store nor the Customer has direct authority over *which* driver serves an order; this is deliberately Flash's own logistics decision (§4 of the domain map, the shared city-wide pool). |
| **Can read** | The assigned Driver (their own assignment); the Customer (who's delivering their order — real-time tracking); the fulfilling Store (which driver is collecting from them); Flash Administrators. |
| **Can modify** | Not directly modifiable — an assignment is created (`assignDriver`) or ended (cancellation/requeue), never edited in place. |
| **Can approve** | The Driver approves by accepting an available order (`DriverController.acceptOrder`, `waiting_for_driver` → `driver_assigned`) — a real, driver-initiated action, not something pushed onto them. |
| **Can override** | Flash Administrators — reassigning a stuck order (the existing 45-minute stuck-`driver_assigned`/`driver_arrived_store` reassignment cron, `server.js`, already a real, automated override); a Customer can select a specific (trusted) driver at checkout (`selectDriver`), a real, different kind of override of the default nearest-match logic. |
| **Can delete** | Not applicable — ended via `requeueOrderForDriverSearch` (clears `driver_id`, returns the order to `waiting_for_driver`), never deleted as a record since it was never a standalone record. |
| **Is audited by** | `orderStateMachineService.js`'s transition log (§6 above) plus `DriverWallet`'s own ledger (`driver_wallet_ledger`, a real, append-only, audited record of every pending/released/reversed credit tied to a specific `order_id`). |
| **Triggers notification to** | The Customer (a driver was assigned, with real-time tracking); the Driver (a new assignment, push notification, confirmed pattern in `notificationService.js`). |

---

## 8. Driver Payout

*(`driver_wallets`, `driver_wallet_ledger`, `driver_payout_requests`, `payout_transactions` — real, live, already audited. Named precisely as "Driver Payout," not just "Payout," per the founder's own instruction — see `FINANCIAL_DOMAIN_SPECIFICATION.md` §2 for full mechanics.)*

| Authority | Answer |
|---|---|
| **Owned by** | The Driver (`driver_wallets.driver_id`) — their own earned money. |
| **Can read** | The owning Driver (their own wallet/ledger/payout history — `driverController.js`'s `getWallet`/`getEarnings`); Flash Administrators (platform-wide, for support/dispute resolution and the real financial reporting in `Admin.getFinancials()`). |
| **Can modify** | Nobody modifies a wallet balance directly — every change flows through `DriverWallet`'s own methods (`addPending`/`releasePending`/`creditAvailable`/`reversePending`), each triggered by a real, specific order-lifecycle event, never a free-form edit. |
| **Can approve** | Flash (implicitly, via Paystack transfer success/failure) approves a payout request's actual disbursement — `DriverWallet.createPayoutRequest` creates the request; the real money movement is a separate, Paystack-mediated step. |
| **Can override** | Flash Administrators — the existing `driver_payout_requests`/`payout_transactions` resources in the internal AdminJS panel presumably allow manual correction (worth confirming precisely against `adminPanel.js`'s exact `isAccessible` rules for these two resources in a future pass — not re-verified line-by-line for this document). |
| **Can delete** | Nobody, ever — same "permanent financial record" reasoning as Order. |
| **Is audited by** | `driver_wallet_ledger` — a real, already-existing, append-only ledger, the correct model every other financial entity in this document should be compared against. |
| **Triggers notification to** | The Driver (payout processed/failed — a real, existing notification pattern). |

---

## 8a. Store Commission

*(new — added because `FINANCIAL_DOMAIN_SPECIFICATION.md` §1's hard separation rule requires Store Commission to be treated as fully distinct from Store Settlement, never folded together; this document should mirror that separation at the authority level too.)*

| Authority | Answer |
|---|---|
| **Owned by** | Flash — this is Flash's own earned revenue, not the store's. |
| **Can read** | Flash Administrators (platform-wide, all rates and all resolved per-order amounts); a Store's own Finance-role staff (their own store's applicable rate and their own resolved amounts — never another store's rate, which is itself a real, non-obvious tenant-isolation boundary worth naming, since commission rates are commercially sensitive). |
| **Can modify** | Flash Administrators only — setting a global default, a store-specific override, or a promotional rate (`commission_rates`, `FINANCIAL_DOMAIN_SPECIFICATION.md` §2.2) is exclusively a Flash-side commercial decision; no Store role can ever set or negotiate their own rate directly. |
| **Can approve** | Not applicable — a new rate takes effect immediately per its precedence tier and active window; no separate approval gate exists or is designed. |
| **Can override** | Not applicable in the usual sense — the precedence rule itself (promotional > store-specific > global) *is* the override mechanism, not a separate authority acting outside it. |
| **Can delete** | Nobody — per `commission_rates`' own append-only design (§2.4), a rate is never deleted or edited in place, only superseded by a new row with a later `created_at`. |
| **Is audited by** | The `commission_rates` table's own row history is the audit trail by construction — every rate that was ever active, when, and (via `created_by`/`reason`) why. |
| **Triggers notification to** | The affected Store's Owner/Finance staff, when their applicable rate changes — a real, plausible need not yet built. |

---

## 9. Store Settlement

*(the entity the founder's "Payouts" sub-domain under Stores actually refers to. Updated: the founder has since made the underlying business decisions, and `FINANCIAL_DOMAIN_SPECIFICATION.md` §2-3 now contains a real, concrete architecture — a configurable `commission_rates` table and a weekly-by-default `store_settlements`/`store_settlement_line_items` lifecycle. Still not yet built, but no longer an open design question — this section's authority answers are updated to reference the real design rather than a placeholder.)*

| Authority | Answer |
|---|---|
| **Owned by** | The Store (its own earned revenue share — `FINANCIAL_DOMAIN_SPECIFICATION.md` §6 confirms this is designed identically whether the store is independent or Flash-owned). |
| **Can read** | The Store's own Owner/Finance-role staff (their own settlement history and line items); Flash Administrators (platform-wide). |
| **Can modify** | Nobody directly — a settlement moves only through its defined status lifecycle (`accruing` → `under_review` → `finalized` → `paid`, `FINANCIAL_DOMAIN_SPECIFICATION.md` §3.3), never a free-form edit, same principle as Driver Payout. |
| **Can approve** | Flash approves/executes the actual `finalized` → `paid` disbursement (the real Paystack transfer, reusing `payout_transactions`' proven infrastructure). |
| **Can override** | Flash Administrators — applying a post-finalization correction (the `adjusted` status, §3.3) for dispute resolution or a late return (§3.4). |
| **Can delete** | Nobody, ever — same permanent-financial-record reasoning as every other entity in this section. |
| **Is audited by** | `store_settlement_line_items`' own real, per-order traceability (§3.3) is the audit trail by construction — every settled amount traces to the specific orders that composed it. |
| **Triggers notification to** | The Store's Owner/Finance staff, at each real lifecycle transition (settlement finalized, settlement paid) — matching the same event-driven notification pattern already used for orders. |

---

## 10. Customer

*(`users` — real, live, fully audited via `ACCESS_SECURITY_AUDIT.md` and every ownership check throughout `orderController.js`/`paymentController.js`)*

| Authority | Answer |
|---|---|
| **Owned by** | Itself — a customer's account is their own. |
| **Can read** | The Customer themselves (their own full profile); a Store or Driver sees only what an active order requires (name, delivery address, phone — never full account detail); Flash Administrators (support, via `Admin.searchUsers`/`getUserProfile` — deliberately a search-then-view pattern, never a browsable full-user-list, per `Admin.js`'s own documented reasoning). |
| **Can modify** | The Customer themselves (profile, addresses); Flash Administrators (support corrections, flag/unflag for cash abuse). |
| **Can approve** | Not applicable — no approval gate exists for a customer account (registration is immediate, email-verification-gated, not admin-approval-gated, unlike Drivers below). |
| **Can override** | Flash Administrators — flagging an account for cash-refusal abuse (`flagged_for_cash_abuse`, real, existing column and mechanism). |
| **Can delete** | The Customer themselves (real, existing self-service account deletion — confirmed by the `deleted-<uuid>@flash.invalid` anonymization pattern found live in production tonight during an unrelated verification pass) — the account is anonymized, not hard-deleted, preserving real order-history integrity. |
| **Is audited by** | Not a dedicated log — account-level changes rely on `updated_at` and the flag columns themselves, no separate audit table. |
| **Triggers notification to** | Nobody automatically on their own account changes today (no "your account was flagged" customer-facing notification confirmed) — real gap, not decided here whether it should exist. |

---

## 11. Driver

*(`drivers` — real, live, fully built onboarding/approval flow)*

| Authority | Answer |
|---|---|
| **Owned by** | Itself. |
| **Can read** | The Driver themselves (own profile, documents, wallet); Flash Administrators (the full driver-approval queue and document review, `requireApprovedDriver`'s real, existing status-gating logic). **Never** a Store — a driver is never store-scoped (§4 of the domain map). |
| **Can modify** | The Driver themselves (profile, bank details, online/offline status); Flash Administrators (approval status, suspension). |
| **Can approve** | **Flash Administrators only** — the real, existing document-review/approval gate (`pending_documents` → `documents_submitted` → `under_review` → `approved`/`rejected`, `requireApprovedDriver`'s middleware). |
| **Can override** | Flash Administrators — suspend a driver regardless of their current approval status (real, existing `suspended` state, and the automated cancel-count-based auto-suspension in the stuck-order reassignment cron). |
| **Can delete** | The Driver themselves (self-service account deletion, same real anonymization pattern as Customer, confirmed live in `driverRoutes.js`'s `DELETE /account`). |
| **Is audited by** | `admin_actions` for Flash-initiated approval/suspension decisions. |
| **Triggers notification to** | The Driver (approval/rejection/suspension — real, existing role-specific messages in `requireApprovedDriver`). |

---

## 12. Flash Administrator

*(`admins`, `admin_actions` — real, live)*

| Authority | Answer |
|---|---|
| **Owned by** | Flash itself — an internal team account, not a customer/store/driver-facing entity at all. |
| **Can read** | Other Flash Administrators (platform-wide, no store/customer/driver ever sees this). |
| **Can modify** | Themselves (own profile); a higher-privileged admin role, if one is ever introduced (today: `admins.role` is a flat column, no admin-managing-admin hierarchy is built, confirmed — the founder is currently the only real row). |
| **Can approve** | Not applicable today — no admin-onboarding-approval workflow exists (a real admin account is created directly, not self-service). |
| **Can override** | Nobody within the current model — Flash Administrators are the top of Flash's own internal authority chain by definition. |
| **Can delete** | Not applicable today — no admin account has ever been deleted, no deletion path is built. |
| **Is audited by** | `admin_actions` — every consequential action an admin takes (order reject, return approval, etc.) is already logged here, real and live. |
| **Triggers notification to** | Nobody automatically — internal team, no customer-facing notification concept applies. |

---

## 13. Promotion

*(`store_boosts`, `store_promotions` — real, live, single-store today)*

| Authority | Answer |
|---|---|
| **Owned by** | The Store that created it. |
| **Can read** | Publicly (a promotion's whole purpose is customer visibility); the owning Store's Marketing-role staff (full detail); Flash Administrators. |
| **Can modify** | The owning Store's Marketing/Owner staff; Flash Administrators (moderation). |
| **Can approve** | Not applicable today — a promotion goes live immediately on creation, no Flash review gate exists, matching Product's own finding (§3) — the same open policy question (should Flash ever moderate a promotion before it's live?) applies here too, not decided in this document. |
| **Can override** | Flash Administrators — remove a promotion that violates policy. |
| **Can delete** | The creating Store (before it's ever been active/paid for); Flash Administrators (moderation) — unlike Product/Order, a promotion that was never actually charged (per `Admin.getFinancials()`'s own confirmed finding that boost/promotion purchases never actually charge Paystack today) arguably *can* be safely hard-deleted, since there's no real payment record tied to it yet — a genuinely different case from every other "never delete" entity above, worth naming precisely rather than defaulting to the same blanket rule. |
| **Is audited by** | Not yet designed for store-initiated changes (`store_actions`, once built); Flash overrides in `admin_actions`. |
| **Triggers notification to** | Nobody automatically today. |

---

## What this document is not

Business-domain analysis only. No code was written, no schema was changed. Several real, precise gaps are named above rather than assumed away (no stock-change ledger, no unified order-transition-history table, no product/promotion moderation gate, no admin-hierarchy model) — these are observations about the current state, not recommendations to build all of them; each would need its own explicit scoping and founder approval, matching this engagement's consistent "don't build for a need that doesn't exist yet" discipline.
