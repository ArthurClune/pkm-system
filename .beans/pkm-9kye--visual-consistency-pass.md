---
# pkm-9kye
title: Visual consistency pass
status: completed
type: feature
priority: normal
created_at: 2026-07-14T20:06:28Z
updated_at: 2026-07-14T20:49:27Z
parent: pkm-heod
---

Small inconsistencies across the chrome.

- [x] Unify border-radius scale (currently 3/4/6px mixed) — e.g. 4px controls, 6px cards, 8px panels
- [x] One shared secondary-button style (Show more, menu buttons, composer send, etc.)
- [x] Bullets (#e3ecf2) one step darker in light mode so outline structure reads
- [x] Quick sweep in both themes after the above

## Summary of Changes

Radii tokenised: --radius-control 4px / --radius-card 6px / --radius-panel 8px, all stray 3px radii gone; one `.btn-secondary` style shared by Show more ×4, composer send, and sidebar entry controls/Add; light-mode bullets darkened (#d2e0ea dot, #c6d7e3 ring). Swept journal + AGI in both themes and at phone width on the scratch server; `pnpm verify` (typecheck, coverage, e2e) green.
