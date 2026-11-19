# `docs/audits/` — Index

**Status:** created 2026-11-19 (foundation Phase 3). **No file here was moved, renamed or deleted.** Code comments refer to 17 of these files by name, so moving them would break those references.

**Where the current truth lives** (outside this folder):
- `docs/PROJECT_STATE.md`: the state of the codebase
- `docs/FOUND_ISSUES.md`: every open issue, with an FI-ID
- `docs/SCHEMA_BASELINE.md`: production schema and migration rules
- `docs/APP_STATES.md`: the app-state standard
- `docs/WORKFLOW.md`: rules and process

**How to read the classes:**
- **Current**: still the reference for its subject.
- **Record**: a dated record of one piece of work. Accurate for its date, never updated.
- **Superseded**: its findings were carried into a later document (named), so read that instead.

**Basis:** classified from each file's title, date and inbound references, plus `HANDOFF_OCT_2026.md` §0's own index. Most files were **not** re-read in full for this index. `refs` counts other tracked files that name the file; `code` counts those inside app/backend code or scripts.

| File | Class | Superseded by / notes | Last change | refs (code) |
|---|---|---|---|---|
| `HANDOFF_OCT_2026.md` | Current (handoff) | Partly superseded by `PROJECT_STATE.md` and `FOUND_ISSUES.md`; still the founder-decision list | 2026-10-01 | 3 (0) |
| `OPEN_FOLLOWUPS.md` | Current (detail) | Items are mirrored in `FOUND_ISSUES.md` by ID; keeps the long-form reasoning | 2026-10-01 | 14 (2) |
| `PAYMENT_MODEL_AND_PORTAL_AUDIT.md` | Current | The confirmed target payment model (A1–A6, B1–B6) | 2026-09-26 | 5 (0) |
| `STORE_EMAIL_SQUATTING_PROPOSAL.md` | Current (open decision) | Options A/B/C, awaiting the founder | 2026-09-25 | 1 (0) |
| `LAUNCH_READINESS_AUDIT_OCT_2026.md` | Current (reference) | Launch picture as of Oct; see `LAUNCH_INFRA_CHECKLIST.md` | 2026-10-01 | 1 (0) |
| `FINANCIAL_DOMAIN_SPECIFICATION.md` | Current (spec) | | 2026-08-01 | 14 (6) |
| `DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md` | Current (spec) | | 2026-08-01 | 6 (3) |
| `FLASH_STORE_ADMIN_DESIGN.md` | Current (design) | Most-referenced design doc | 2026-08-01 | 30 (24) |
| `MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md` | Current (design) | | 2026-08-01 | 6 (2) |
| `ORDER_AUTHORITY_MATRIX.md` | Current (spec) | | 2026-08-01 | 2 (0) |
| `BUSINESS_DOMAIN_MAP.md` | Current (spec) | | 2026-08-01 | 3 (0) |
| `ADMIN_PANEL_AUDIT_AND_VISION.md` | Current (design) | | 2026-07-25 | 13 (12) |
| `POSTHOG_ANALYTICS_DESIGN.md` | Current (design) | | 2026-09-19 | 2 (2) |
| `SUBSCRIPTION_LIFECYCLE_AUDIT.md` | Current | HANDOFF calls it the subscription "lifecycle truth" | 2026-07-30 | 3 (1) |
| `PRODUCTION_SECRETS_CHECKLIST.md` | Current (checklist) | To be folded into `docs/SECRETS.md` in Phase 8 | 2026-07-17 | 7 (2) |
| `DEPLOYMENT_SAFETY_RECOMMENDATIONS.md` | Current (recommendations) | See `WORKFLOW.md` §3 deploy rules and `LAUNCH_INFRA_CHECKLIST.md` | 2026-09-19 | 3 (0) |
| `SALEOR_ARCHITECTURE_STUDY.md` | Record (research) | | 2026-08-01 | 4 (0) |
| `POST_AUDIT_PRIORITY_ROADMAP.md` | Record (paused roadmap) | Execution order now in `WORKFLOW.md` §5 | 2026-09-19 | 2 (0) |
| `PHASE2_STORE_PAYOUTS_PLAN.md` | Record (plan) | | 2026-09-26 | 3 (0) |
| `PHASE2A_PAYOUT_DESTINATION_RECORD.md` | Record | | 2026-09-26 | 2 (2) |
| `PHASE2B_COMMISSION_RECORD.md` | Record | | 2026-09-26 | 1 (0) |
| `PRODUCT_PRICE_INTEGRITY_RECORD.md` | Record | | 2026-09-30 | 4 (2) |
| `STORE_PORTAL_PHASE1_RECORD.md` | Record | | 2026-09-24 | 1 (0) |
| `STORE_ONBOARDING_FRONTEND_RECORD.md` | Record | | 2026-09-25 | 3 (0) |
| `STORE_SUSPENSION_RECORD.md` | Record | | 2026-09-25 | 2 (1) |
| `STORE_PRODUCT_EDIT_AND_REACTIVATE_RECORD.md` | Record | | 2026-09-30 | 2 (0) |
| `EMAIL_BOUNCE_VISIBILITY_RECORD.md` | Record | Unreferenced | 2026-09-25 | 0 (0) |
| `HOTFIX_ORDER_PHOTO_BYPASS.md` | Record | | 2026-09-07 | 1 (0) |
| `PHASE_0.5_REMEDIATION_RECORD.md` | Record | Unreferenced | 2026-09-19 | 0 (0) |
| `PHASE_1_CHANGE_REPORT.md` | Record | | 2026-07-11 | 1 (0) |
| `FLASH_AUDIT_REPORT.md` | Superseded | `PROJECT_STATE.md` | 2026-07-11 | 3 (0) |
| `ACCESS_SECURITY_AUDIT.md` | Superseded | `PROJECT_STATE.md`, `FOUND_ISSUES.md` | 2026-07-12 | 5 (0) |
| `PRODUCTION_READINESS_AUDIT.md` | Superseded | `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md`, then `PROJECT_STATE.md` | 2026-09-19 | 4 (0) |
| `CRITICAL_FLOW_EDGE_CASE_AUDIT.md` | Superseded | `PROJECT_STATE.md`; unreferenced | 2026-07-28 | 0 (0) |
| `RETURNS_AND_LEGAL_AUDIT.md` | Superseded | `PROJECT_STATE.md` (H-16) | 2026-07-11 | 5 (1) |
| `SECTION_2.8_PAYMENTS_AUDIT.md` | Superseded | `SECTION_2.15_…`, then `PROJECT_STATE.md` | 2026-09-19 | 2 (0) |
| `SECTION_2.8_COMMISSION_DEBT_AUDIT.md` | Superseded | same | 2026-09-19 | 3 (0) |
| `SECTION_2.9_REFUND_LIFECYCLE_AUDIT.md` | Superseded | same | 2026-09-19 | 2 (0) |
| `SECTION_2.10_STUCK_ORDER_STATE_MACHINE_AUDIT.md` | Superseded | same | 2026-09-19 | 1 (0) |
| `SECTION_2.11_TRAFFIC_SCALING_AUDIT.md` | Superseded | same | 2026-09-19 | 2 (1) |
| `SECTION_2.12_STORE_MISSED_ORDER_RELIABILITY_AUDIT.md` | Superseded | same | 2026-09-19 | 1 (0) |
| `SECTION_2.13_FULL_ADMIN_VISIBILITY_AUDIT.md` | Superseded | same | 2026-09-19 | 1 (0) |
| `SECTION_2.15_FINAL_CONSOLIDATED_REPORT.md` | Superseded | `PROJECT_STATE.md`, `FOUND_ISSUES.md` | 2026-09-19 | 3 (0) |

Not listed: `SECURITY_SELF_PENTEST_REPORT.md`. **It is kept outside the repo by the founder**: both copies (the main folder's untracked file and a worktree's version) were moved to the founder's own secrets folder on 2026-11-20. `.gitignore` blocks `SECURITY_SELF_PENTEST_REPORT*.md` anywhere, so a copy can never be committed.
