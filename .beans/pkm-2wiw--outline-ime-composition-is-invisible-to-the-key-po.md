---
# pkm-2wiw
title: 'Outline: IME composition is invisible to the key policy; committing a conversion with Enter splits the block'
status: in-progress
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:59:05Z
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
- [x] Red tests for both event orders (Chromium: isComposing; WebKit: compositionend then keydown 229)
- [x] Expose composing state from `useBlockDraft` (including the just-ended case) to the key policy as an `EditorKeyInput` field; return `none` while composing
- [x] Verify on the iPad simulator (`.claude/skills/ipad-simulator`): dispatched composition/keydown orders through the React handlers in real WebKit, and a W3C key-action Enter splits (on-screen keyboard not reachable there; see evidence)
- [ ] physical iPad: on-screen Enter splits a block, and an IME commit with Enter does not

## Summary of Changes

`useBlockDraft.imeOwns` answers whether the IME owns a keydown: `isComposing`, between compositionstart and compositionend, or the first keydown after a compositionend with keyCode 229 within `IME_COMMIT_WINDOW_MS` (WebKit's order), measured on `imeClock` (`performance.now()` read in the handlers), never by comparing events' timeStamps. `EditorKeyInput.composing` makes `decideEditorKey` return `none` for it, and the /date picker's Escape is skipped. The outline draft property (`props/outline/draft*.ts`) gained composition steps and keydowns in both engines' shapes; `imeTeeth.prop.ts` holds two mutants.

## iPad simulator evidence (2026-11-08)

iPad Air 11-inch (M4) simulator, iOS 26.5, Safari 26.5, desktop-class UA. Scripts drove the served build through safaridriver. Each scenario used one block, `hello`, with the caret at its end.

**Dispatched (untrusted) events through the React handlers.** These ran on the fixed build. WebKit honours `keyCode` in KeyboardEventInit, and an instance `timeStamp` can be set with `Object.defineProperty`.

| Scenario | Rows after |
|---|---|
| Chromium order: compositionstart, keydown Enter 229 isComposing, compositionend | 1 (no split); then Enter 13 splits |
| WebKit order: compositionstart, compositionend, keydown Enter 229 | 1; then Enter 13 splits |
| WebKit order with the 229 keydown stamped 815684366637 (compositionend at 2106) | 1; then Enter 13 splits |
| compositionend, then a 229 Enter 626 ms later | 2 (splits) |
| a real Enter (13) right after compositionend | 2 |
| a 229 Enter with no composition | 2 |
| a plain Enter (13) | 2 |

**W3C key action** (`ActionChains.send_keys(Keys.ENTER)`). It delivered a trusted keydown and keyup: key `Enter`, code `Enter`, keyCode 13, isComposing false. No beforeinput or input fired. The block split.

**Clocks.**
- Trusted keydowns from key actions carry a timeStamp of about 815684366629-815684366716, near-constant across runs made minutes apart.
- Events WebKit raises itself carry about 2,000, as `performance.now()` does: a trusted focus or focusin read 2080, and a compositionend about 2064.
- Comparing the two events' timeStamps therefore put WebKit's committing Enter outside the window, so it split. `imeOwns` now reads `imeClock` in the handlers instead.

**Not reachable in the simulator.**
- The on-screen keyboard: programmatic focus shows no software keyboard, WebDriver cannot tap native UIKit keys, and `simctl` has no key input.
- A trusted IME composition.

So what the on-screen Enter actually sends (its keyCode, its clock, whether it composes) needs a physical iPad.
