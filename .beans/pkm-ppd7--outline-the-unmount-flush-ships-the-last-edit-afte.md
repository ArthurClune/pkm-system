---
# pkm-ppd7
title: 'Outline: the unmount flush ships the last edit after releasing the shared session; the other surface shows stale text'
status: todo
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding outline F3. Verdict: HOLDS, reproduced in vitest.

## Symptom
Page X open in the main pane and a sidebar panel. Type into a block and
leave the page within the 500 ms debounce (or with the caret in a `[[ref`).
The sidebar inherits the editor lease but shows the text without the last
edit until the write settles (a round trip online; until reconnect
offline). Editing that block there in the window forks a `[[conflict]]`
copy of the user's own text (same shape as pkm-sfp1/pkm-impk).

## Cause
`useOutline.ts`: the session handle is released in a `useLayoutEffect`
cleanup; the unmount flush runs in a passive `useEffect` cleanup, which React
runs later, so `run()` finds `sessionRef.current === null` and enqueues
without `applyLocal`. The comment "nothing is left to render into" assumes
no other view of the page.

## Fix
- [ ] Red test with two surfaces (the existing draftHold test uses one)
- [ ] Flush (and apply to the session) before releasing the handle, or have the passive cleanup re-acquire it via `peekOutlineSession`
