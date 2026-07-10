---
# pkm-22ay
title: 'EditableBlockTree remote-adoption polish: IME guard, dirty-clear identity, caret'
status: completed
type: task
priority: low
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:34:47Z
---

Follow-ups from pkm-tmtf final-review triage (2026-07-10 batch). Remote text adoption in EditableBlockTree (adopt-when-clean effect + dirtyRef) has three polish gaps: (1) no compositionstart/end handling — a remote update arriving mid-IME-composition (CJK/accented input) calls setDraft under the composition and can disturb it; (2) dirtyRef is cleared by value-equality with node.text, so a remote commit coincidentally equal to the local unflushed draft clears dirty while the local op is still pending (theoretical, LWW-convergent); (3) adoption does not preserve/reposition the caret in a focused-but-clean textarea.

## Checklist
- [x] Suppress remote adoption during IME composition (compositionstart/end guard), with a test
- [x] Consider writer-identity (or pending-op-aware) dirty clearing instead of pure value equality (considered, declined — see Summary)
- [x] Preserve caret position on adoption when focused and clean
- [x] pnpm test + typecheck clean



## Summary of Changes

All work landed in `web/src/components/EditableBlockTree.tsx` (BlockInput), `web/src/outline/edits.ts`, and their test files.

1. **IME composition guard.** Added `composingRef`, set on `compositionstart`/cleared on `compositionend` on the textarea. The adopt-when-clean effect (`tryAdopt`) now bails out while `composingRef.current` is true instead of calling `setDraft` mid-composition. `onCompositionEnd` re-invokes `tryAdopt()` so a remote update that arrived during composition is applied once the IME session ends (still subject to the existing dirty check). Covered by a new test that fires `compositionstart`, rerenders with new remote text, asserts the textarea is untouched, then fires `compositionend` and asserts the text is adopted.

2. **Dirty-clear identity — considered, declined.** The only reliable "was this update ours or a remote writer's" signal available without protocol changes is `useOutline`'s `pendingRef`/debounce-timer machinery, which lives one layer up and is never passed into `EditableBlockTree`/`BlockInput`. Making the dirty-clear write-aware would require either (a) threading a per-update "local vs remote" tag from `useOutline` through `BlockNode`/props into `BlockInput` (a new field consumed well beyond this one call site — read-only rendering, DnD, tests), or (b) plumbing a writer/op id through the sync layer's op batches and echoes, which the task explicitly rules out ("do not refactor the sync layer"). The failure mode is narrow and self-healing: it only mis-clears `dirtyRef` when a remote-authored `update_text` happens to be byte-identical to the local unflushed draft; the visible text is unaffected (it's the same string), and the system's own consistency model is last-write-wins, so a subsequent local flush or remote batch converges regardless. Given that, the fix was judged disproportionate to a theoretical, already-convergent edge case, and declined. Checklist item marked as considered.

3. **Caret preservation on adoption.** Added a pure `clampCaret(offset, length)` helper in `web/src/outline/edits.ts` (Functional Core) that keeps a prior caret offset unless the new text is shorter, in which case it clamps to the new length. `tryAdopt` now captures `el.selectionStart` before calling `setDraft` when the textarea is focused, storing the clamped target in `pendingCaretRef`; a new `useLayoutEffect` keyed on `draft` applies it via `setSelectionRange` right after the DOM commits the adopted text, so no `requestAnimationFrame`/async wait is needed and the behavior is deterministic in tests. Covered by two new tests: one asserting the caret offset is preserved when the adopted text is longer, one asserting it clamps when the adopted text is shorter than the prior offset. A direct unit test for `clampCaret` was also added in `edits.test.ts`.

Verification: `pnpm test -- --run` (274 tests, all passing) and `pnpm typecheck` (clean) from `web/`.
