---
# pkm-f7xv
title: TopBar delete preview lands after navigation; PdfEmbed mounted ref under StrictMode
status: completed
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-08T14:29:04Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings webui F6 (HOLDS-NARROWER) and F12 (HOLDS, dev only).

- F6: `components/TopBar.tsx` `handleDelete` has no route guard. A slow
  delete preview that lands after navigating to page B opens the blocked
  dialog headed with B's title over A's blockers (or a "Delete A?" confirm
  over B). `handleExport` in the same file already uses a `titleRef` guard.
- F12: `components/PdfEmbed.tsx` sets `mounted` false in cleanup but never
  back to true in the effect body, so under StrictMode's dev replay the
  download probe's failure note never shows. Journal.tsx's `mountedRef` is
  the right shape. Dev-only, but a pattern agents copy.

- [x] Red tests
- [x] Reuse the `titleRef` guard after each await in `handleDelete`
- [x] Set `mounted.current = true` in the effect body

## Summary of Changes

TopBar.handleDelete re-checks `titleRef` after the preview, the confirm,
the DELETE and the 409 re-preview, so an answer landing after navigation
neither opens a dialog, deletes, reports nor navigates. PdfEmbed's
`mounted` ref is set true in its effect body. Red tests: three held-fetch
TopBar cases and a StrictMode PdfEmbed probe. Docs: the rule in
frontend.md § State management; two troubleshooting rows.
