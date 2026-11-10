---
# pkm-eek2
title: e2e specs write to pages they create, not today's journal
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-10T09:36:15Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W16. Child of the 2026-11-09 maintainability review epic.

Summary: added web/e2e/ownPage.ts (ownPage and scratch fixtures); edit, undo, embeds, image-expansion, math, offline, offline-shell, pdf and rename write to pages they create and delete them. conflict-landing keeps the journal by design (the server lands conflict entries on today's note) and already removes what it wrote. help writes nothing. Full Playwright suite green twice.
