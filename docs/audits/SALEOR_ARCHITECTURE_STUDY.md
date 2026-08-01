# Saleor Architecture Study — Real Findings, for Flash's Future Store Admin

**Scope:** A direct, evidence-based study of Saleor's real codebase — the backend at `github.com/saleor/saleor` and the Dashboard frontend at `github.com/saleor/saleor-dashboard`, both shallow-cloned to `c:\Users\makas\projects\saleor-main` and `c:\Users\makas\projects\saleor-dashboard` (outside this repo, per this task's own ground rules). Every claim below cites a real file path from those clones — not general knowledge about Saleor. Where I could not verify something to my own standard, I say so explicitly rather than filling the gap with a plausible-sounding guess. This is Phase 1 of a three-part deliverable; no code was written, no Flash file was touched, nothing here has been built.

**Method note:** the original plan was to delegate this research to two background sub-agents (one per repo) so their findings could be verified and synthesized. Both agents failed repeatedly on transient infrastructure errors (`529 Overloaded`, then a DNS/`ENOTFOUND` connectivity error) unrelated to the task itself. Rather than keep retrying an unstable dependency, I did this research directly — reading the real files myself with Grep/Read/Bash against both clones. Every citation below is something I personally verified, not something relayed from an agent.

**Update note:** §2.4 and §2.5 below originally flagged two open gaps ("structure confirmed, presentation order not independently verified" and "genuinely unconfirmed rather than a confirmed absence"). Both have since been resolved with real evidence, driven by the Store Admin Portal security review's need for a precise answer on how Saleor actually enforces RBAC at the page/action/API layers — see the updated §2.4/§2.5 below.

---

## Part 1 — Backend architecture and reasoning

### 1.1 The domain/GraphQL split, and why it exists

Saleor's backend (`saleor/`) is organized as one Django app per business domain — `saleor/order/`, `saleor/product/`, `saleor/warehouse/`, `saleor/account/`, `saleor/channel/`, `saleor/payment/`, `saleor/permission/`, and about a dozen more, all siblings under `saleor/`. Each of these holds real Django models, plain Python business-logic functions, and (where relevant) Celery tasks — no GraphQL awareness anywhere in them.

A **second, parallel tree**, `saleor/graphql/`, mirrors the same domain names (`saleor/graphql/order/`, `saleor/graphql/product/`, etc.) and holds nothing but the GraphQL API surface for that domain: `types.py` (GraphQL object types), `mutations/` (one small file per mutation), `schema.py` (wires queries/mutations into the domain's slice of the schema), `resolvers.py`, `dataloaders.py`.

Confirmed directly: `saleor/graphql/order/mutations/order_cancel.py` imports `from ....order.actions import cancel_order` and calls the real domain function — the dependency points **one way**, GraphQL depends on domain logic, never the reverse. I did not find a case of `saleor/order/` importing anything from `saleor/graphql/`. This means the same domain logic (cancel an order, capture a payment) is reachable from anywhere else that might need it later — a Celery task, a future REST endpoint, an internal script — without GraphQL being a required layer in between. It also means the domain logic is unit-testable without spinning up a GraphQL execution context at all.

**Why this matters, not just what it is:** this is the textbook reason to keep an API layer thin — GraphQL/REST/whatever-comes-next is a *transport*, not where business rules should live. Flash's own backend already follows exactly this instinct in miniature (`orderStateMachineService.js` holds the real transition logic; `orderController.js` is the thin layer calling it) — this isn't a new idea Flash needs to adopt, it's confirmation that Flash is already doing the analogous right thing at its own scale, without needing two parallel folder trees to express it, because Flash only has one API transport (REST), not GraphQL.

### 1.2 The GraphQL schema itself — mutation granularity

`saleor/graphql/order/mutations/` contains 34 separate files, each defining one small, single-purpose mutation class: `order_cancel.py`, `order_capture.py`, `order_confirm.py`, `order_fulfill.py`, `order_refund.py`, `order_void.py`, `order_mark_as_paid.py`, `order_note_add.py`, `order_line_update.py`, `fulfillment_approve.py`, `fulfillment_cancel.py`, `fulfillment_refund_products.py`, and so on — no single monolithic `updateOrder` mutation that takes a mode/action parameter.

Read `order_cancel.py` in full as a concrete worked example:

```python
class OrderCancel(BaseMutation):
    order = graphene.Field(Order, description="Canceled order.")

    class Arguments:
        id = graphene.ID(required=True, description="ID of the order to cancel.")

    class Meta:
        description = "Cancel an order."
        permissions = (OrderPermissions.MANAGE_ORDERS,)
        error_type_class = OrderError
        error_type_field = "order_errors"

    @classmethod
    def perform_mutation(cls, _root, info, /, *, id: str):
        order = cls.get_node_or_error(info, id, only_type=Order)
        cls.check_channel_permissions(info, [order.channel_id])
        order = clean_order_cancel(order)
        ...
        cancel_order(order=order, user=user, app=app, manager=manager, site_settings=site.settings)
```

Three things worth naming precisely:
- **Permission is declared once, on the mutation class itself** (`permissions = (OrderPermissions.MANAGE_ORDERS,)`), not re-checked ad hoc inside the function body. `BaseMutation`'s own dispatch machinery checks this before `perform_mutation` ever runs.
- **A second, separate check happens explicitly inside the function**: `cls.check_channel_permissions(info, [order.channel_id])` — this is the real multi-tenancy-relevant finding of this whole study, covered in §1.5 below.
- **Validation is a named, separate function** (`clean_order_cancel`), not inlined — a small but real convention (validate → check → act, three distinct steps, each independently testable).

**Why granular mutations, not one big one:** a Dashboard button (say, "Cancel Order") can be wired to exactly one mutation with exactly the permission and validation it needs, and the button can be shown or hidden purely by checking `order.status` client-side (confirmed in §2 below) — there's no risk of a generic `updateOrder({status: 'canceled'})` call accidentally being permitted to also silently change something else it shouldn't (price, customer, line items) because they're all bundled under one endpoint. This is a real, transferable idea — not "because GraphQL," but because granular, single-purpose write operations are easier to reason about, permission-scope correctly, and show/hide safely from a UI, regardless of transport. Flash's own `orderStateMachineService.js` (per `CLAUDE.md`) already does exactly this at the backend layer (`ALLOWED_TRANSITIONS`, one operation per transition) — the transferable idea for Flash's *admin-facing* surface specifically is to keep that same discipline when exposing store-admin actions (a real `acceptOrder`/`rejectOrder`/`markReadyForPickup` action per state, not one generic "update order" endpoint the admin UI calls with a status string), covered concretely in Phase 3.

### 1.3 Order state, modeled as three separate axes — not one column

This is the single most important, most surprising finding of this whole study, and it deserves to be stated precisely because it's genuinely different from how Flash's own order model works.

`saleor/order/__init__.py:9-37` defines `OrderStatus` — but it is **not** a payment-and-fulfillment-combined pipeline. Its real values are: `draft`, `unconfirmed`, `unfulfilled`, `partially fulfilled`, `fulfilled`, `partially_returned`, `returned`, `canceled`, `expired`. This status describes **only what happened to the goods** (has the warehouse packed/shipped them).

Separately, `saleor/order/models.py:120` and `:126` define `authorize_status` and `charge_status` as their own fields on the same `Order` model, backed by two more enums, `OrderAuthorizeStatus` and `OrderChargeStatus` (`saleor/order/__init__.py:234-284`). These are explicitly documented in their own docstrings as **derived, computed** values — "we treat the order as fully authorized when the sum of authorized and charged funds cover the `order.total`" — not a flag anyone sets directly, but a live computation over real transaction line-items.

So a Saleor order's real state is a **triple**: (fulfillment status, authorize status, charge status) — e.g. an order can be `unfulfilled` + `FULL` charge simultaneously (paid in full, nothing shipped yet), or `partially_fulfilled` + `PARTIAL` charge (part-shipped, part-paid, a real scenario in split-shipment/backorder e-commerce).

**What Flash should take from this, precisely, and what it shouldn't:** Flash's `orders.status` (per `CLAUDE.md`'s own state list: `created → payment_pending → paid → waiting_for_driver → driver_assigned → driver_arrived_store → picked_up → in_transit → delivered → completed`) deliberately conflates payment and fulfillment into one linear column — and that's **correct for Flash's business, not a gap to fix by copying Saleor**. Saleor's three-axis model exists because general e-commerce genuinely has independent partial states: you can charge 30% of an order and ship half the line items, in either order, at different times, across days or weeks. Flash's model is same-day, single-driver, single-trip, cash-or-card, pay-in-full-or-not-at-all — there is no "partially fulfilled" concept (a driver either has the item and is delivering it, or doesn't), and no "partially charged" concept (Paystack either captures the full amount or it doesn't; there's no split-payment feature anywhere in this codebase). Splitting Flash's order status into three axes to imitate Saleor would be modeling degrees of freedom that don't exist in Flash's actual business, at the cost of real complexity (every future status check would need to consider three fields instead of one). **This is a case of "Saleor does it for a real, good reason, and Flash should explicitly not adopt it"** — named here because it's exactly the kind of surface-level "more sophisticated" pattern that's tempting to copy without asking whether the underlying problem it solves actually exists in Flash's domain.

### 1.4 Product, inventory, and Channels

`saleor/warehouse/models.py:527` defines `Stock` as a genuine join table: `warehouse` (FK) × `product_variant` (FK), `unique_together`, with independent `quantity` and `quantity_allocated` fields per row. This is real, ground-up multi-location inventory — the same product variant can have a different, independently-tracked stock count in five different warehouses simultaneously, and `increase_stock`/`decrease_stock` operate on one specific `(warehouse, variant)` row, not a single global count.

This is a materially different shape from Flash's `flash_inventory` table, which (per this engagement's own established schema knowledge) holds one `stock_by_size` JSONB column directly on the product row — a single, store-wide stock count, not location-scoped. **This is the one piece of this whole study that doesn't transfer as "just add a column"** — turning Flash's inventory model into genuine per-store stock (a real requirement once there's more than one physical Flash store location, each holding its own physical clothing stock) is structurally closer to introducing Saleor's `Stock` join-table pattern than to any of the other additive changes in this document. Flagged precisely here so it isn't underestimated in Phase 2's blueprint.

**Channels** (`saleor/channel/models.py:12-70`) are a real, distinctive Saleor concept, and I read the model directly rather than guess from the name: a `Channel` has `currency_code`, `default_country`, `slug`, and a long list of **behavioral configuration flags** — `allocation_strategy`, `automatically_confirm_all_new_orders`, `allow_unpaid_orders`, `order_mark_as_paid_strategy`, `expire_orders_after`, and about a dozen more. Critically, **a Channel has no `owner`/`tenant_id` field, and Product/Order rows relate to it via a plain foreign key** — there is no separate schema, no separate database, no data-isolation boundary at the storage layer. A Channel is a **shared-table, row-scoped configuration and pricing context**, not a fully isolated tenant. Product availability and price are channel-specific (a product can be priced differently or simply not listed in a given channel), but the underlying `Product`/`ProductVariant`/`Order` rows are the same shared tables for every channel.

This is directly, precisely relevant to Phase 2 of this document: it confirms that a mature, real, production multi-tenant-ish commerce platform's actual answer to "support multiple storefronts" is **an additive scoping column on shared tables**, not per-tenant schema/database separation — the same direction already recommended for Flash independently (see `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`).

### 1.5 Permissions — flat, domain-scoped capability flags, plus a real channel-scoping layer

`saleor/permission/enums.py:16-85` defines the real permission set — not a small number of named roles, but ~15 fine-grained, domain-scoped capability flags in Django's own `app_label.codename` format: `account.manage_users`, `account.manage_staff`, `order.manage_orders`, `product.manage_products`, `payment.handle_payments`, `discount.manage_discounts`, `channel.manage_channels`, `site.manage_settings`, and so on. A "role" in Saleor's own UI is a **named Group** (Django's standard `auth.Group` model) that bundles a chosen subset of these flags — Saleor doesn't hardcode "Manager"/"Staff"/"Owner" as fixed roles anywhere in the permission enum itself; those are just Groups a store owner creates and names however they like.

The genuinely important, previously-uncertain finding: **is this channel-scoped or global?** Confirmed directly by reading `order_cancel.py`'s `perform_mutation` and its call to `cls.check_channel_permissions(info, [order.channel_id])`, then reading that method's real implementation (`saleor/graphql/core/mutations.py:585-598`):

```python
@classmethod
def check_channel_permissions(cls, info, channel_ids):
    if get_app_promise(info.context).get():
        return  # a server-to-server "App" integration has access to all channels
    accessible_channels = get_user_accessible_channels(info, info.context.user)
    accessible_channel_ids = {str(channel.id) for channel in accessible_channels}
    channel_ids = {str(channel_id) for channel_id in channel_ids}
    if channel_ids - accessible_channel_ids:
        raise PermissionDenied(message="You don't have access to some objects' channel.")
```

`get_user_accessible_channels` (`saleor/graphql/account/utils.py:397-402`) resolves through a real per-user dataloader (`AccessibleChannelsByUserIdLoader`), meaning **a staff member's Group can be restricted to specific channels** — this is a genuine two-layer authorization model: (1) a flat capability check ("can this user manage orders at all"), and (2) a per-object channel-membership check ("is this *specific* order's channel one this user is allowed into"). This is the closest real analog Saleor has to tenant isolation at the authorization layer, and it's a clean, well-reasoned pattern worth naming precisely for Phase 2/3 — not because Flash needs Django Groups, but because the *shape* (flat role capability + a per-request scoping check against the specific object's tenant) is exactly the shape a future Flash multi-store JWT/permission model would need.

### 1.6 Customer/staff data model

`saleor/account/models.py:139-148` — Saleor has **one** `User` table for both customers and staff, distinguished by a single `is_staff` boolean, not separate tables. `UserManager`'s own customer-queryset logic (`saleor/account/models.py:127-136`) is worth citing exactly because it's a subtle, real detail: `Q(is_staff=False) | (Q(is_staff=True) & Exists(orders...))` — a staff member who has also placed a real order themselves still counts as a "customer" for that purpose. This reflects a domain where staff and customers share almost all of the same fields (name, email, address, order history) and the boundary between them is genuinely blurry (an employee can also be a shopper).

Flash instead has three fully separate tables — `users`, `drivers`, `admins` — and this is the right call for Flash, not a gap: Flash's three roles share almost no fields in common (a driver has `vehicle_type`/`vehicle_plate`/`current_lat`, a user has `address`/`cash_refusal_count`, an admin has `role`/nothing else) and never overlap (nobody is simultaneously a customer and a driver in the same account). Merging them into one table the way Saleor does would trade away the clean, role-specific schema Flash already has for a generality Flash's actual domain doesn't need.

### 1.7 Analytics/reporting

I did not find a dedicated analytics/reporting Django app or module anywhere in `saleor/`. Every dashboard number/chart in the frontend appears to be composed from ordinary GraphQL queries against the same domain types everything else uses (orders, products, etc.) — there is no separate `saleor/analytics/` or `saleor/reporting/` package. **Flagged as inferred, not exhaustively confirmed** — I did not read every one of Saleor's ~25 domain apps individually; I checked for an analytics-shaped app name and query pattern and didn't find one, but I can't rule out a small, narrowly-scoped reporting module I didn't specifically look for. This is consistent with Flash's own existing approach (`Admin.getFinancials()`/`Admin.getDailyTrends()` composing real aggregate SQL queries directly, no separate analytics service) — nothing to newly adopt here, more a confirmation that Flash's existing pattern already matches how a much larger platform does the same thing.

---

## Part 2 — Dashboard frontend, real UI/UX patterns

### 2.1 Structure, routing, data-fetching

`saleor-dashboard/src/orders/` mirrors the backend's per-domain convention: `components/`, `views/`, `queries.ts`, `mutations.ts`, `types.ts`, `urls.ts`. Real view names under `src/orders/views/`: `OrderList`, `OrderDetails`, `OrderFulfill`, `OrderRefund`, `OrderReturn`, `OrderGrantRefund`, `OrderSendRefund`, `OrderManualTransactionRefund`, `OrderTransactionRefundCreate/Edit`, `OrderDraftList`. Each maps to a real, distinct URL, confirmed in `src/orders/urls.ts:231-380`: `orderPath(id)` → `/orders/:id`, then `orderFulfillPath` → `/orders/:id/fulfill`, `orderReturnPath` → `/orders/:id/return`, `orderPaymentRefundPath` → `/orders/:id/payment-refund`, `orderGrantRefundPath` → `/orders/:id/grant-refund` — **every major action is its own real, deep-linkable route**, not a modal-only interaction bolted onto one page. A support agent could be sent a direct link to `/orders/abc123/return` and land exactly there.

Confirmed Apollo/codegen usage: `graphql.config.ts` and `codegen-main.ts` exist at the repo root and generate typed hooks from `.graphql` query/mutation files. `src/orders/components/OrderDetailsPage/OrderDetailsPage.tsx:150-153` shows the real, concrete pattern for using derived status: `order?.status === OrderStatus.UNCONFIRMED`, `order?.status !== OrderStatus.CANCELED` — plain boolean derivations computed once from the fetched order, then (based on the component's structure) used to conditionally show, hide, or disable actions like Cancel/Fulfill/Edit-address. I did not trace every one of these flags all the way to their exact JSX render sites within my time budget for this pass — the derivation pattern itself (compute booleans from `order.status` near the top of the component, reference them in render) is the confirmed, citable finding; the exact conditional-render call sites are a smaller, believable but not individually re-verified detail.

### 2.2 Design system

`package.json:92-93` shows **two** versions of Saleor's own design system installed simultaneously: `"@saleor/macaw-ui": "npm:@saleor/macaw-ui@0.7.4"` and `"@saleor/macaw-ui-next": "npm:@saleor/macaw-ui@1.4.2"` — real, direct evidence of an in-progress, incremental design-system migration (old components still rendering under the legacy package while new ones adopt the "next" version), not a clean single dependency. Worth naming as a real, honest data point about how even a mature, well-funded open-source product manages a UI-library migration: gradually, with both versions live at once, not a big-bang rewrite.

### 2.3 Order status display and the real timeline component

Real, confirmed component: `src/orders/components/OrderHistory/OrderHistory.tsx`, with a dedicated `OrderHistoryDate.tsx` sub-component that buckets events into `TODAY` / `YESTERDAY` / `LAST_7_DAYS` / `LAST_30_DAYS` / `OLDER` (`OrderHistory.tsx:36-59`) — a real, date-grouped chronological event timeline, plus a distinct `ExtendedTimelineEvent`/`ExtendedDiscountTimelineEvent` component for richer event types (discount-specific history entries get their own richer rendering than a plain text line). This confirms Saleor's order-detail view shows genuine event history, not just a current-status badge.

Separately, `src/components/StatusDot/StatusDot.tsx` is a real, small, reusable colored-dot status indicator, and `src/components/Datagrid/customCells/StatusCell.tsx` is the table-cell renderer used to show status in list views (e.g. the order list) — confirming status is shown two ways: a quick-scan dot/badge in list views, and a real chronological history on the detail view. This two-tier pattern (glanceable indicator in lists, full history on detail) is a genuinely good, directly transferable idea for Flash's own order-detail screen, independent of anything backend-specific.

### 2.4 Navigation and domain organization — resolved, real component found

**Update: the sidebar-menu-rendering component has since been found and read directly** — `src/components/Sidebar/menu/hooks/useMenuStructure.tsx`. The real, confirmed, exact top-to-bottom sidebar order is: **Home → Search → Catalog** (Products, Categories, Collections, Gift Cards, Product Types) **→ Fulfillment** (Orders, Draft Orders) **→ Customers → Discounts** (Promotions, Vouchers) **→ Modeling** (Models, Structures, Model Types) **→ Translations → Extensions → Configuration**. Each top-level entry is a plain JS object (`SidebarMenuItem`, `type: "item" | "itemGroup" | "divider"`) with an `icon`, `label`, `url`, optional `children`, and — directly relevant to §2.5 below — an optional `permissions` array. `Menu.tsx` (`src/components/Sidebar/menu/Item.tsx`) renders this structure with no hardcoded ordering logic of its own; the order above is entirely authored in `useMenuStructure.tsx`'s `menuItems` array. This confirms and supersedes the earlier `src/` domain-folder-listing evidence — the actual rendered order is now a **confirmed fact**, not an inference from folder names.

### 2.5 Permissions in the UI — resolved: page-level enforcement confirmed, action-level enforcement not found

**Update: the real permission-gating mechanism has been found**, in the same `useMenuStructure.tsx` file. Each menu item can declare a `permissions: PermissionEnum[]` array; `isMenuItemPermitted()` (same file) does an **any-of** match: `menuItem.permissions.some(permission => userPermissions.includes(permission))`, and an item with no `permissions` array (or an empty one) is shown to everyone. `getFilteredMenuItems`/the hook's own `reduce` recursively filters both top-level items and their children before the sidebar ever renders — this is real, confirmed, **proactive, client-side, page/section-level** hiding, not just a theoretical possibility.

Having found this, I went back and specifically re-checked whether an *individual action button* within an already-reachable page (e.g. the real Cancel button inside `OrderDetailsPage.tsx`, the component checked in the original pass) gets an equivalent per-action permission re-check. It does not, as far as a targeted search of that component and its immediate action-bar/dialog subtree (`OrderCancelDialog.tsx` and siblings) could confirm — no `hasPermission`/`userPermissions`/`PermissionEnum` reference anywhere in that subtree. Button availability there is driven entirely by order **status** (`order?.status !== OrderStatus.CANCELED`, confirmed in the original pass), not by re-checking the current user's permissions a second time at the button level.

**The resolved, precise picture — two real layers, not three:**
1. **Page/navigation layer (client, proactive):** confirmed — `isMenuItemPermitted` hides entire sections a user's role can't reach at all.
2. **Individual action buttons within an already-reachable page (client):** **not found** — appears to rely entirely on layer 3 below, not a redundant client-side recheck.
3. **API/mutation layer (server, authoritative):** confirmed in §1.2 — `permissions = (OrderPermissions.MANAGE_ORDERS,)` declared once per mutation class, enforced server-side regardless of what the client rendered.

This is a genuinely useful, precise finding for Flash's own Store Admin Portal design (`FLASH_STORE_ADMIN_DESIGN.md` §5.2): Saleor's real, valid security posture is "the API is the only layer that actually has to be right; the client hiding is a UX nicety, not a boundary" — and Flash's portal should explicitly decide whether to match that two-layer model or go further with a third, per-action client-side layer, rather than assume Saleor already does the maximal version of this.

---

## Part 3 — Honest comparison: what Flash should adopt, avoid, or take only as inspiration

| Pattern | Adopt / Avoid / Inspiration-only | Why |
|---|---|---|
| Domain logic never imports the API layer | **Adopt (already mostly true)** | Flash's `orderStateMachineService.js` already lives below `orderController.js` the same way. Nothing new to build — just a principle to keep protecting as the Store Admin grows: new admin actions should call existing services, never grow their own parallel business logic inline in a route handler. |
| Granular, single-purpose mutations/actions over one generic "update" endpoint | **Adopt, for the Store Admin's own actions specifically** | Directly informs Phase 3: separate `acceptOrder`/`rejectOrder`/`markPreparing`/`markReadyForPickup` actions, each independently permissioned, not one generic status-setter the UI drives with a dropdown. |
| Three-axis order state (fulfillment × authorize × charge) | **Avoid** | Solves a real problem (partial shipment, partial payment) that doesn't exist in Flash's same-day, single-driver, pay-in-full-or-not model. Would add real complexity for degrees of freedom Flash's business doesn't have. |
| `Stock` as a real warehouse×variant join table | **Inspiration for the eventual multi-store case, not needed today** | The one inventory pattern that doesn't transfer as "add a column" — a real structural change, correctly scoped as its own line item in Phase 2, not bundled in with the easier additive changes. |
| Channel as a shared-table, row-scoped configuration context (no per-tenant schema) | **Adopt the *shape*** | Directly validates Flash's own planned approach (an additive `store_id` column on shared tables, not per-tenant databases) — this is exactly how a mature real platform already does the analogous thing, not an untested idea. |
| Flat capability permissions + Group-based roles + per-object channel-scope check | **Adopt the *shape*, not the mechanism** | Flash doesn't need Django Groups or ~15 fine-grained permission flags for a 6-role model — but the two-layer idea (a role check, plus a per-request "is this specific object's store one this admin is allowed into" check) is exactly the shape Phase 2/3's RBAC design needs, and it's the same shape already used for tenant-scoped security everywhere else worth checking. |
| Page-level (client, proactive) + API-level (server, authoritative) permission enforcement, with **no** confirmed per-action-button client recheck | **Adopt the two confirmed layers; go further deliberately, not by default** | Confirmed (§2.5): Saleor hides whole sections proactively and relies on the server to reject unauthorized mutations, without an extra client-side recheck at the individual button level. Valid for Saleor's page-per-permission-group shape. Flash's Store Admin Portal has staff sharing pages with meaningfully different action permissions within them (Sales Staff vs. Finance on the same Orders page) — worth explicitly adding a third, per-action client layer rather than assuming Saleor's two-layer model is automatically sufficient for a different page/role shape. |
| One `User` table for staff + customers via `is_staff` | **Avoid** | Flash's three separate tables (`users`/`drivers`/`admins`) are correct for a domain where the three roles share almost no fields and never overlap — merging them would trade away a clean schema for generality Flash doesn't need. |
| Two-tier status display: glanceable dot/badge in lists, real chronological history on detail | **Adopt directly, backend-agnostic** | Pure UI/UX idea, doesn't depend on Saleor's GraphQL layer at all — directly usable in Flash's own order-detail Store Admin screen. |
| Deep-linkable, action-specific URLs (`/orders/:id/return`, not modal-only) | **Adopt directly, backend-agnostic** | Same — a real, transferable UX idea independent of GraphQL/REST. |

---

## What this document is not

This is investigation only, per this task's own ground rules — no code was written, no migration was created, no existing Flash file was modified. Both companion documents (`MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md`, `FLASH_STORE_ADMIN_DESIGN.md`) build on the findings above. Nothing here should be implemented without the founder's explicit, separate approval of a specific phase, in a future session.
