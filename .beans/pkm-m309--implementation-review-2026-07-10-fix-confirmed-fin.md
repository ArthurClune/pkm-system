---
# pkm-m309
title: 'Implementation review 2026-07-10: fix confirmed findings'
status: todo
type: epic
created_at: 2026-07-10T10:56:15Z
updated_at: 2026-07-10T10:56:15Z
---

Tracks all work arising from docs/2026-07-10-implementation-review.md (gpt-sol whole-repo review, pkm-pcaz). Four Important findings block production-readiness; plus type/contract gaps and cleanup items. Suggested order per review: db init fix, focused-block remote updates, offline op queue, filename bounding, generated response types, typecheck in verification, docs/cleanup. After the four Important fixes, rerun backend + frontend + build + Playwright suites and inspect server stderr, not just exit codes.
