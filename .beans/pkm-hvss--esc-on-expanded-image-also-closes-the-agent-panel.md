---
# pkm-hvss
title: Esc on expanded image also closes the agent panel
status: in-progress
type: bug
priority: normal
created_at: 2026-08-19T15:51:44Z
updated_at: 2026-08-19T15:55:53Z
---

In the assistant panel, clicking an image in a result expands it (ImageOverlay). Pressing Esc closes the overlay but the same keypress also reaches AssistantPanel's onKeyDown (React portal events propagate through the React tree), closing the panel too. Trap the first Esc in the overlay so it only closes the image; a second Esc then closes the panel as before. Clicking Close already behaves correctly.

## Todo
- [x] Failing test: Esc on the open overlay must not propagate to an ancestor React onKeyDown handler
- [x] Fix: ImageOverlay traps Escape (capture-phase keydown + stopPropagation)
- [x] Verify: web unit tests + typecheck pass (pnpm verify: 2298 unit + 54 e2e green)

## Summary of Changes

ImageOverlay now registers its keydown listener in the capture phase and calls stopPropagation on Escape before closing, so the keypress never reaches host key handlers — neither via DOM bubbling nor via React-tree portal propagation into AssistantPanel. Tab trapping unchanged. New regression test in AssetImage.test.tsx: an ancestor onKeyDown must not see the overlay-closing Escape, but must see a later Escape once the overlay is gone.
