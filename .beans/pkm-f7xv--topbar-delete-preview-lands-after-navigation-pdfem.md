---
# pkm-f7xv
title: TopBar delete preview lands after navigation; PdfEmbed mounted ref under StrictMode
status: todo
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-07T18:42:46Z
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

- [ ] Red tests
- [ ] Reuse the `titleRef` guard after each await in `handleDelete`
- [ ] Set `mounted.current = true` in the effect body
