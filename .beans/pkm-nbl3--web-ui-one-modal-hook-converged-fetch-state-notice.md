---
# pkm-nbl3
title: 'Web UI: one modal hook, converged fetch state, notices, prefs, routes, stylesheet'
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T06:19:55Z
parent: pkm-4gda
blocked_by:
    - pkm-t6xh
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W15. Child of the 2026-11-09 maintainability review epic.

## Close-out (2026-11-11)

- Behaviour the shared modal hook brings to the confirm and delete-blocked dialogs: Tab cycles inside, body scroll is locked, focus is restored on close, and Escape closes only the top modal (the menu, panel or search box beneath stays open).
- iPad simulator check passed for scroll lock, stacked modals and the editor afterwards. Left for a real iPad after deploy: a touch drag on a modal's backdrop, the on-screen keyboard offset after closing the PDF overlay, hardware-keyboard Tab.
- The Files PDF overlay keeps its own thumb refocus: a tapped or clicked button is not focused in Safari, so the modal's restore has nothing to return to.
