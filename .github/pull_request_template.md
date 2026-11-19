<!-- See docs/WORKFLOW.md. Delete any section that genuinely does not apply, and say why. -->

## Summary
<!-- What changed and why. Link FOUND_ISSUES IDs (FI-xxx) and GitHub issues. -->

## Production impact
- [ ] **No production database change** in this PR. (If there is one, say so here first: it is founder-run, never via `migrate.js` — see docs/SCHEMA_BASELINE.md §6.)
- Runtime behaviour change: <!-- none / describe -->
- Schema change: <!-- none / migration vNN, proven with scripts/schema-baseline/schema_check.sh -->

## Impact analysis
<!-- What could break, who is affected (customers / drivers / stores / admins), money paths, locks, deploy order. -->

## Verification
<!-- Exact commands and their real output. Never "should work". For any "identical" claim, give hash + size + count. -->
- [ ] Tests run: <!-- command + counts -->
- [ ] Money/order UI follows docs/APP_STATES.md (Part 3 checklist), or N/A
- [ ] No secrets, tokens or PII printed, logged or committed

## Docs updated
- [ ] docs/WORKLOG.md entry
- [ ] docs/FOUND_ISSUES.md (new bugs found along the way are recorded, not fixed here)
- [ ] Any doc this change makes inaccurate

## Rollback
<!-- How to undo: revert commits? data to restore? -->
