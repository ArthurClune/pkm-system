---
# pkm-m309
title: 'Implementation review 2026-07-10: fix confirmed findings'
status: completed
type: epic
priority: normal
created_at: 2026-07-10T10:56:15Z
updated_at: 2026-07-10T12:22:15Z
---

Tracks all work arising from docs/2026-07-10-implementation-review.md (gpt-sol whole-repo review, pkm-pcaz). Four Important findings block production-readiness; plus type/contract gaps and cleanup items. Suggested order per review: db init fix, focused-block remote updates, offline op queue, filename bounding, generated response types, typecheck in verification, docs/cleanup. After the four Important fixes, rerun backend + frontend + build + Playwright suites and inspect server stderr, not just exit codes.

## Summary of Changes

All 8 child beans implemented, task-reviewed, merged to main (--no-ff), and pushed (batch 5624e02..72df221, 40 commits), plus the two pre-existing DnD beans pkm-auw2 and pkm-auvy. Final verification on the merged tree: server 276 passed + pyrefly 0 errors + ruff clean; web 268 passed + tsc clean + production build OK; Playwright e2e 2/2 with an EMPTY server error log under the new harness that fails on any 5xx/unhandled exception (the review's headline "database is locked" 500s are gone). Final whole-batch review (cross-change interactions + deferred-minors triage): READY WITH FOLLOW-UPS, no fix-now items. Follow-up beans: pkm-vcz7 (DnD dead branch + doc comments), pkm-22ay (remote-adoption polish: IME/caret/dirty-clear), pkm-8er1 (test hardening), pkm-2939 (guardrails: WAL assert in create_app, drift-test auto-discovery).
