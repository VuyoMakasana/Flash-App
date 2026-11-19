---
name: App state gap (APP_STATES.md)
about: A money/order/auth action that does not meet docs/APP_STATES.md (Phase 5A inventory)
title: "[APP-STATE] <app>: <action> — <gap>"
labels: app-state
---

**App:** flash-user-app / flash-driver-app / flash-store-portal
**Action:** <!-- e.g. "Confirm cash OTP" -->
**Trace:** button `file:line` → API `services/api.js:line` → route/controller `file:line` → DB → response → screen `file:line`

| Situation | Today (file:line) | Required by APP_STATES.md |
|---|---|---|
| Success | | |
| Validation / 401 / 403 / 409 / 5xx | | |
| Timeout / connection lost | | UNKNOWN → re-fetch status |
| Double-tap | | button disabled, idempotency key |
| App backgrounded / offline | | |

**Rule(s) broken:** <!-- Rule 1–7 -->
**Proposed fix (needs approval):**
