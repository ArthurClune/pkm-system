---
# pkm-2wiw
title: 'Outline: IME composition is invisible to the key policy; committing a conversion with Enter splits the block'
status: todo
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding outline F2. Verdict: HOLDS.

## Symptom
With a Japanese/Chinese IME, committing a conversion with Enter splits the
block (and unmounts the composing input); candidate-list arrows navigate to
neighbouring blocks; Escape blurs; Tab indents; `[`/`(` can auto-pair. English
typing hits it only via dead keys or the accent picker.

## Cause
`BlockInput.tsx` `onKeyDown` / `decideKey` never read composition state;
`useBlockDraft.ts` tracks `composingRef` but uses it only to defer adoption.
Chromium sends the committing Enter with `isComposing === true`. Safari ends
the composition first, so that Enter arrives with `isComposing === false`
and keyCode 229. Guarding on keyCode 229 alone risks swallowing Enter from
the iPad's on-screen keyboard.

## Fix
- [ ] Red tests for both event orders (Chromium: isComposing; WebKit: compositionend then keydown 229)
- [ ] Expose composing state from `useBlockDraft` (including the just-ended case) to the key policy as an `EditorKeyInput` field; return `none` while composing
- [ ] Verify on the iPad simulator (`.claude/skills/ipad-simulator`) that on-screen-keyboard Enter still splits
