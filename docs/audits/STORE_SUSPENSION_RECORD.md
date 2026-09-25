# Store Suspension — Record

Closes the gap found during the onboarding end-to-end pass: Flash had no
working way to take a live store offline. This is a safety control being put
in place *before* Phase 2 (payouts), on the reasoning that shipping the
ability to pay a store while having no ability to cut one off is a missing
control right where real money starts moving.

---

## 1. What was actually broken

Three findings that looked separate but were one problem.

**1.1 — Nothing could move a store out of `approved`.**
`suspended` existed in the `stores_status_check` constraint but nothing set
it. `Store.approve()` and `Store.reject()` were both scoped
`WHERE status IN ('pending','under_review')`, and both AdminJS actions gated
on the same pair via `isAccessible`. On an approved store: no action shown,
`status`/`is_active` not editable (`isVisible: { edit: false }`), `delete` and
`bulkDelete` `isAccessible: false`. The only remedy was hand-written SQL —
which is in fact what had to be used to clean up the end-to-end test store.

**1.2 — `authenticateStore` never looked at the store.**
It did a live DB check on `store_users.is_active` — the right pattern already
existed — but selected only from `store_users`, so `stores.status` and
`stores.is_active` were invisible to it.

**1.3 — `login` had the same blind spot.**
It checked `storeUser.is_active` only. So even with the middleware fixed,
staff could sign in again and mint a fresh token.

**Why 1.2 mattered so much:** store JWTs last a hardcoded **8h** and there is
**no refresh endpoint**, so revocation can only come from the server. Verified
live during the end-to-end pass — with the store's `is_active` set to `false`
by direct SQL, the owner still got **HTTP 200** on `/api/store-orders`,
`/api/store-inventory`, `/api/store-analytics` and `/api/store-staff`.
Flipping a flag nothing re-read was not a kill switch.

---

## 2. The root cause of the *gap*, not just the bug

`rejectStore`'s `isAccessible` and `Store.reject()`'s `WHERE` clause were
written out separately and happened to agree — both hard-excluding
`approved`. Because they agreed, nothing failed: the action was simply never
offered, and no error was raised. A silently unreachable action is invisible.

So the fix is structural. `STORE_STATUS_TRANSITIONS` in `models/Store.js` is
now the single source of truth:

```js
const STORE_STATUS_TRANSITIONS = {
  approve:    ['pending', 'under_review'],
  reject:     ['pending', 'under_review'],
  suspend:    ['approved'],
  reactivate: ['suspended'],
};
```

Model `WHERE` clauses render from it via `sourceStatesSql()`; all four AdminJS
actions' `isAccessible` read it directly. **Zero hardcoded state lists remain**
in the store resource. A test reproduces the original bug (reverting one
`isAccessible` to a literal list) and fails — see §5.

---

## 3. What changed, file by file

| File | Change |
|---|---|
| `models/Store.js` | `STORE_STATUS_TRANSITIONS` + `sourceStatesSql()`; new `suspend()` and `reactivate()`; `approve()`/`reject()` WHERE clauses now derive from the map |
| `middleware/auth.js` | `authenticateStore` joins `stores` and refuses any store that is not `is_active AND status='approved'` |
| `controllers/storeAuthController.js` | `login` refuses to mint a token for such a store |
| `adminPanel.js` | `suspendStore` + `reactivateStore` actions; all four `isAccessible` derive from the map |
| `flash-store-portal/src/services/api.js` | On `403 STORE_SUSPENDED`, tears down the stored session and broadcasts an event |
| `flash-store-portal/src/context/StoreAuthContext.jsx` | Listens for that event and clears React state |
| `flash-store-portal/src/pages/LoginPage.jsx` | Shows why the session ended, consumed once |

**No migration.** `suspended` is already legal under `stores_status_check`.

### The middleware change

```js
// before
"SELECT is_active, password_changed_at FROM store_users WHERE id = $1"

// after
`SELECT su.is_active, su.password_changed_at,
        s.is_active AS store_is_active, s.status AS store_status
   FROM store_users su
   JOIN stores s ON s.id = su.store_id
  WHERE su.id = $1`
```

Then, after the existing account check:

```js
if (!storeRow.store_is_active || storeRow.store_status !== "approved") {
  return res.status(403).json({
    error: "This store is not currently active. Please contact Flash support.",
    code: "STORE_SUSPENDED",
  });
}
```

Notes that matter:

- **Cost is nil.** That query already ran on every authenticated request. It
  gains a primary-key join, not a second round trip.
- **Fails closed.** `store_users.store_id` is `NOT NULL` with a real FK, so the
  inner join cannot drop a legitimate row; if data were ever orphaned the row
  vanishes and access is denied.
- **Coverage is complete by construction.** `authenticateStore` is applied
  router-wide via `router.use(...)` on every store-scoped router (orders,
  inventory, analytics, staff), so one check covers all of them.
- **403, not 401.** The credentials are valid; the store is forbidden. A 401
  reads as "log in again" and would loop — and `login` refuses suspended
  stores too, so the loop is closed at both ends. The machine-readable `code`
  is what lets the portal say *why*.
- **Any non-approved state is refused**, not only `suspended`.

### Why `reactivate()` is not `approve()`

`approve()` runs through `StoreOnboardingService`, which mints a fresh
single-use invite token and sends a welcome email. Both are wrong for an owner
who already has a working password. `reactivate()` touches no tokens and sends
no email — the existing credentials simply start working again. Asserted by
test, not just by intent.

---

## 4. In-flight orders — the escalation path, traced

The decision (founder's, recorded here): **orders already accepted continue to
completion**; orders still awaiting acceptance are handled by the **existing**
store-acceptance timeout rather than any suspension-specific logic.

I was asked to confirm that path actually handles this rather than assume it
does because it exists for a similar case. Traced end to end:

**The cron** (`src/server.js`, every 15 min):

```sql
SELECT id FROM orders
WHERE status = 'pending_store_acceptance'
  AND updated_at < NOW() - INTERVAL '15 minutes'
```

**There is no store-related filter at all** — no join to `stores`, no status
or `is_active` condition. So a suspended store's unaccepted orders are
selected exactly like any other unresponsive store's.

**The handler**, `rejectPendingAcceptance` (`orderStateMachineService.js`):
locks the order `FOR UPDATE`, checks only
`normalizeState(order.status) === 'pending_store_acceptance'`, transitions to
`cancelled`, writes an `order_cancellations` row with `refund_mode =
'full_refund'`, commits, then emits the socket update, notifies the customer
and issues the refund behind the existing `isCardPaid` gate.

**It never references `stores` anywhere in its path.** So it behaves
identically whether or not the store is suspended. Confirmed by reading both,
not assumed.

**Worst-case timing:** up to 15 min (threshold) + up to 15 min (cron
interval) ≈ **30 min** before auto-cancel and refund. That is the pre-existing
SLA for any unresponsive store, so suspension introduces no new customer-facing
delay.

**Consequence worth stating plainly:** suspending a store with unaccepted
orders means those customers get cancelled and refunded within ~30 minutes,
automatically, with no admin action. That is the correct outcome, but an admin
suspending a busy store should know it happens.

`Store.suspend()` touches only the `stores` row — asserted by a test that
fails if its SQL ever mentions `orders`.

---

## 5. Adversarial testing

| Check | Result |
|---|---|
| Valid, unexpired **pre-suspension token** replayed | **403 `STORE_SUSPENDED`**, `next()` not called |
| **Fresh login** while suspended | **403**, and no token in the response body |
| **Suspension mid-session** | Next request refused; portal ejects to `/login` with the reason |
| **Reactivation** restores access | Same token, same account — passes again |
| Any non-approved state (`pending`/`under_review`/`rejected`/`suspended`) | All refused |
| `is_active=false` but `status='approved'` | Refused — either flag alone suffices |
| Orphaned account (no store row) | Refused — fails closed |
| Healthy approved store | Still passes — the switch isn't blocking everyone |
| Enumeration via login | Store check runs **after** password verification, so a wrong password returns a generic 401 and never the suspension code |
| `reactivate()` touching tokens or email | Neither — asserted |
| **Suspend touching order rows** | SQL touches `UPDATE stores` only; no `orders`, no `order_cancellations`, no `DELETE` |
| **Drift between `isAccessible` and the model WHERE** | Guarded both ways (see below) |
| Client teardown over-firing | A plain 401, and a 403 *without* the code, both leave the session intact |

### Mutation-tested, not just green

A passing test proves nothing unless it fails when the fix is removed. Each
was verified by deliberately breaking the code:

| Mutation | Tests that failed |
|---|---|
| Middleware store check disabled | **8** |
| `login` store check disabled | 1 (the exact one) |
| `rejectStore.isAccessible` reverted to a literal list — **reproducing the original bug** | 1 (the drift guard) |
| Client `STORE_SUSPENDED` teardown disabled | 4 |

All mutations reverted afterwards.

### Counts

- Backend: **409 → 431** tests, 35 suites, all passing.
- Portal: **30 → 40** tests, 5 files, all passing.
- Three pre-existing tests needed fixture updates (their mocks no longer
  described the real query shape). Updated to include the joined store state —
  **not** weakened; each still asserts what it originally did.

---

## 6. Not verified

- **No admin has clicked `suspendStore` in the real panel.** The actions are
  covered by the drift guard and the model methods by unit tests, but the
  AdminJS handlers themselves are not exercised by an authenticated click —
  the same admin-credential limitation as previous rounds.
- **Not exercised against production.** No store has been suspended live.
  The earlier evidence that a deactivated store's staff kept full access *was*
  gathered live; the fix for it is verified by unit tests and mutation
  testing only.
- **The ~30-minute auto-cancel consequence is traced, not observed.** No order
  has been put through it with a suspended store.
- **8h TTL left as-is.** Now that the store's state is re-checked per request,
  the TTL is much less load-bearing. Shortening it is a separate decision.

---

## 7. Follow-ups this surfaced

1. **`/api/store-auth/reset-password` still has no rate limiter.** Token
   entropy (384 bits) makes brute force infeasible, so it is not urgent, but
   it remains the only unthrottled write in the auth surface.
2. **No per-account admin revocation.** `revoked_tokens` is jti-keyed and
   only written by the user's own logout, so an admin cannot kill one staff
   member's session without deactivating the account. Suspension now covers
   the whole-store case, which was the urgent one.
3. **Suspension does not notify the store.** The owner discovers it by being
   signed out. A notification is worth considering — it pairs naturally with
   the bounce-visibility work queued next.
