# Admin Platform — Phase 1: Store-Account Identity Model (Proposal Only)

**Status:** Proposal for founder decision. No code, migrations, routes, or UI in this document or this commit. Builds directly on `docs/ADMIN_PLATFORM_PHASE0_ARCHITECTURE_NOTES.md` (read that first — findings below are used, not re-derived).

**The problem, stated precisely:** Phase 0 found that no design anywhere — not `production-readiness-audit`'s `FLASH_STORE_ADMIN_DESIGN.md`, not `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md` — specifies *how* Flash confirms that a person creating the first `store_users` row for a given `stores` row is actually authorized to represent that real, physical store. Both docs assume "Flash does it manually," with no defined mechanism. Left undesigned, that gap is a direct impersonation vector: anyone who can talk to an onboarding flow (or a Flash staffer who skips a step under time pressure) could stand up a store-admin account that controls another business's orders, inventory, and payout-adjacent data (per Phase 0 §3.1, `stores.owner_email`/`owner_phone` are exactly the fields meant to carry this contact identity, and they exist only as unenforced columns today — nothing currently checks them against anything).

**Founder-set constraint for this proposal:** the eventual build must be genuinely scale-ready — designed for hundreds of stores from day one, not a shortcut that works for two and gets rebuilt later — and it must not introduce a way to break anything already working (no existing endpoint, auth path, or data can regress).

---

## Non-negotiable property (holds regardless of which option below is chosen)

**A store-admin account must be permanently bound, server-side, to exactly the one `stores.id` row it was authorized for, enforced on every single request, and never trusted from a client-supplied store ID.**

Concretely:
- The store's identity is a foreign key set once at account-provisioning time (`store_users.store_id`), written by server-side logic only — never accepted as a request body/query/header field on any store-scoped endpoint.
- Every store-scoped route (orders, inventory, staff, settings) derives `store_id` from the authenticated `store_users` row (via the JWT subject → DB lookup, or a value embedded in the token at issuance and re-verified against the DB, not just trusted from the token alone), the same pattern `requireOwnStore` was designed for on `production-readiness-audit` — Phase 0 flagged that pattern as written-but-never-adversarially-tested, so Phase 2+ must re-verify it live, not assume it, before any second real store goes on it.
- This holds independent of which identity-verification option (below) is chosen at onboarding time. Onboarding answers "who is allowed to create the first account for store X"; this property answers "once that account exists, what can it ever act as" — the two are separate concerns and both are mandatory.

---

## Option A — Flash-staff-verified manual onboarding (paperwork-gated, human-in-the-loop)

**Mechanism:** A prospective store owner submits a request (form, email, or a phone/in-person conversation — channel doesn't matter for the identity question) with business proof: e.g. an ID or business-registration document, a phone number Flash calls back on, and a bank account or business address that can be cross-checked. A Flash admin — using the *existing, already-built* AdminJS/admin-dashboard auth from Phase 0 §2, no new auth surface needed — reviews the evidence and, only then, triggers account creation: fills in `stores.owner_name`/`owner_email`/`owner_phone` and creates the first `store_users` row with a Flash-generated temporary password or an email-based invite link.

- **Prevents impersonation how:** a human checks government-issued/business-registration ID against the claimed store before any account exists. This is the strongest identity check available and the one implicitly assumed (never specified) by the prior design docs.
- **New data/fields needed:** none beyond what Phase 0 already found designed-in on `production-readiness-audit` (`stores.owner_name/owner_email/owner_phone`). Add one field this proposal introduces: an `stores.onboarding_verified_by` (admin id) + `stores.onboarding_verified_at` audit pair, so every store's provenance is queryable later — small, additive, no schema risk.
- **Operational burden on Flash staff:** real and linear in store count — every single onboarding needs a human to look at documents and place a phone call or equivalent. At 5–20 stores this is trivial (an afternoon's work total). At "hundreds," it becomes a standing operational function, not incidental admin work.
- **Scaling past a handful:** does not scale by itself past roughly the point where verification volume needs a dedicated person/role — but it scales *safely*, because the bottleneck is a human decision, not a system limitation, and the same underlying data model (one `stores` row, one verified contact) supports both 2 stores and 200 without any redesign. The fix at scale is adding review capacity or partially automating evidence collection (Option B), not changing the trust model.
- **Trade-off:** slowest onboarding (hours to days, not self-service), but zero new automated-verification attack surface to build or get wrong.

## Option B — Self-service signup gated by automated proof-of-control checks

**Mechanism:** A public signup form lets a prospective owner submit business details plus one or more automatable proof-of-control signals — e.g. a one-time code sent to a phone number, an email domain match (store's claimed email must match a business-domain email, not a free Gmail address), and/or a small "verification payout" deposited to a claimed bank account that the owner must report back (a pattern used by several fintechs for account-ownership proof). Only after these automated checks pass does the account activate; a Flash admin does a lighter final review (not full document verification) before the store goes live, or optionally the flow auto-activates for lower-risk signals only.

- **Prevents impersonation how:** each individual signal (phone OTP, email-domain match, micro-deposit) is a real but partial proof of control over something associated with the store — not proof of legal identity the way Option A's document check is. Combined, they raise the cost of impersonation significantly above "just fill in a form," but do not reach Option A's certainty (e.g., someone could still control a phone number without owning the business).
- **New data/fields needed:** everything Option A needs, plus verification-state columns (`stores.phone_verified_at`, `email_domain_verified_at`, `bank_verification_status`), a short-lived OTP/token table (or reuse of the existing `refresh_tokens`-style pattern for a purpose-built `store_onboarding_tokens` table), and integration with an SMS provider (new dependency — flagged per CLAUDE.md's dependency rule, would need its own justification/cost discussion, not decided here) or reuse of the existing email pipeline (`emailService.js`, per Phase 0 §2.1, is already in the codebase) for the domain-match path.
- **Operational burden on Flash staff:** low and roughly constant per store — mostly reviewing flagged/ambiguous cases (mismatched signals, disposable-looking domains) rather than every single signup.
- **Scaling past a handful:** this is the option actually shaped for "hundreds" — the review queue only holds *exceptions*, so staff time grows sub-linearly with store count. It is also the most engineering to build correctly (multiple integrations, more states to test, more edge cases — a partially-verified store, an owner who loses phone access, a shared/agency email domain) and the most new attack surface (an OTP flow badly built is itself an impersonation vector, which is exactly the class of bug this whole proposal exists to prevent).
- **Trade-off:** fastest onboarding, most implementation and ongoing-maintenance cost, and the automated checks are individually weaker than a human document review — mitigated, not eliminated, by combining signals and keeping a manual review step for anything ambiguous.

## Option C — Hybrid: manual verification now, automated proof-of-control layered in later as a Phase behind this one

**Mechanism:** Ship Option A first — it requires no new integrations, reuses the existing AdminJS auth surface Phase 0 already confirmed works, and needs zero new external dependencies. Design the `stores`/`store_users` schema and the onboarding audit fields (`onboarding_verified_by/_at`) so that Option B's automated signals can be added later as *additional*, optional verification layers on the same records, without a schema rewrite — e.g. the same `phone_verified_at`-shaped columns can be added later without touching the identity-binding logic (the non-negotiable property above), since that logic never depended on *how* a store was verified, only on the fact that `store_users.store_id` is fixed at creation.

- **Prevents impersonation how:** identical to Option A at launch (human document review); identical to Option B once/if the automated layers are added.
- **New data/fields needed:** same as Option A initially; forward-compatible with Option B's additions without migration risk (additive columns only, per CLAUDE.md's database rules — no destructive change ever required to add Option B later).
- **Operational burden on Flash staff:** same as Option A at current store counts (a handful to a few dozen) — which matches where Flash actually is today per Phase 0 §3 (a *single* real store, "Flash Closet"). Burden only becomes worth automating once volume justifies the extra engineering, which this option explicitly defers rather than pre-building on speculation.
- **Scaling past a handful:** the schema and the enforcement model (the non-negotiable property) already scale to hundreds unchanged — only the *verification method* would need to evolve, and Option C is structured so that evolution is additive, not a redesign.
- **Trade-off:** none of Option B's engineering cost is paid until it's actually needed, at the cost of accepting Option A's manual burden until that point — a deliberate, explicit sequencing decision rather than a permanent one.

---

## Recommendation: Option C (manual-first, automation-ready)

Rationale, directly against the founder's "build for scale, make no mistakes" instruction:

- Flash today has exactly one real store (Phase 0 §3). Building Option B's multi-signal automated verification pipeline now would be solving a hundreds-of-stores problem before there is a second store, with no live traffic to validate any of it against — the highest-risk way to introduce new attack surface (a badly-built OTP/proof-of-control flow is itself an impersonation path).
- Option A alone is correct but under-specifies what happens at real scale, which the founder explicitly asked to avoid ("not a shortcut, build for scale").
- Option C gets Option A's low-risk, zero-new-dependency launch immediately, while making the schema and audit trail forward-compatible with Option B so scaling to hundreds is an additive extension, not a rebuild — satisfying "genuinely scale-ready" without speculative engineering today.

### Architecture Decision Framework — applied to Option C (per CLAUDE.md, required)

1. **What business problem does this actually solve?** Closes the one identity-verification gap every prior store-admin design doc explicitly left open: proving that whoever creates a store's first admin account is actually authorized to represent that real store, before that account can ever touch orders/inventory/payout-adjacent data for it.

2. **Why is this better than extending the current design?** There is no current design to extend on this point — Phase 0 confirmed the onboarding-identity question was never designed, only deferred, on `production-readiness-audit`. Option C is additive to that prior work (same `stores`/`store_users` shape, same audit-log instinct as `admin_actions`) rather than a competing architecture.

3. **What trade-offs does it introduce?** Slower onboarding than a self-service flow at launch; a standing (small, currently near-zero given one real store) manual-review burden on Flash staff; and a deliberate decision to not build Option B's automation until volume justifies it, which means near-term store growth is bounded by staff review capacity, not system capacity.

4. **How does it behave at two stores?** Identical to one store: one more manual review, one more `stores` row with `owner_name/email/phone` populated and `onboarding_verified_by/_at` set, one more `store_users` row. The non-negotiable binding property means the second store's admin can never see or act on the first store's data even though both run through the same code path — this is exactly the tenant-isolation property Phase 0 flagged as designed-but-never-adversarially-tested on `production-readiness-audit`'s `requireOwnStore`, and it must be proven, not assumed, before a real second store goes live.

5. **How does it scale to thousands?** The schema and enforcement model scale unchanged (a foreign key and a server-side lookup don't get more expensive per store). The *manual review step* does not scale to thousands as designed — that is explicitly acknowledged, not hidden, and is exactly why Option C's schema is built additive-ready for Option B's automated signals to absorb that load if/when Flash approaches store counts where manual review becomes the bottleneck. Thousands of stores is a real trigger point for revisiting this doc, not a case this proposal claims to solve today.

6. **How hard would it be to migrate away from later?** Low. Moving from manual-only to manual+automated verification adds columns and a token table; it does not change `store_users.store_id` binding, the JWT/session model, or any already-shipped endpoint contract. No destructive migration, no breaking change to the store-portal frontend's existing API contract (Phase 0 §1.2).

7. **Does it make the system easier or harder for future developers?** Easier: it keeps the identity-binding logic (the one piece every future feature depends on) simple and fully decoupled from *how* a store got verified, so a future developer adding Option B's automation touches onboarding code only, never the request-authorization code path every store-scoped route already depends on.

---

## What this document does not do

No code, schema, migration, or route was written. No decision has been made — this is a recommendation pending founder approval of Option A, B, or C (or a variant). Phase 2 (implementation) does not start until that approval is given.
