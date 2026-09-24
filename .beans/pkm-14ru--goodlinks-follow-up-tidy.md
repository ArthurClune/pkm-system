---
# pkm-14ru
title: GoodLinks follow-up tidy
status: completed
type: task
priority: normal
created_at: 2026-09-24T09:42:30Z
updated_at: 2026-09-24T09:54:40Z
---

Follow-ups from the GoodLinks review (handover 2026-09-23), triaged for maintainability, consistency and YAGNI.

- [x] Gateway: a non-JSON 2xx body is GoodlinksUnavailable, not an uncaught 500
- [x] CLI: help text says "Goodlinks" like every other user-facing string; test for GoodLinks closed (exit 1, "not running")
- [x] e2e: stub GoodLinks binds an ephemeral port; E2E_GOODLINKS_PORT removed
- [x] Web: one definition of the refused-token detail
- [x] Web: URL detector keeps balanced parentheses (Wikipedia-style URLs)
- [x] Web: GoodlinksLink/Reader take the link id; isGoodlinksHref and the reader's malformed-href branch deleted; false header comment fixed
- [x] e2e: dead page-title tripwire deleted; Dismiss locator scoped to the editor notice
- [x] Docs: Escape-inside-frame limitation, route table owned by backend.md, config-row wording, pkm skill command list
