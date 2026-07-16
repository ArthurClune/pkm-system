---
# pkm-wquz
title: TODO block keyboard shortcut
status: completed
type: feature
priority: normal
created_at: 2026-07-15T19:26:43Z
updated_at: 2026-07-16T16:23:39Z
---

Apple-Enter should toggle plain block->TODO->Done->plain block

## Summary of Changes

Cmd-Enter (Ctrl-Enter on non-Mac) while editing a block now cycles its task
state: plain -> `{{TODO}} ` -> `{{DONE}}` -> plain.

- `web/src/grammar/todo.ts`: new pure `cycleTodo(text): string`. Delegates
  TODO->DONE to the existing `toggleTodo`; strips the marker (+ one trailing
  space) for DONE->plain; prepends `{{TODO}} ` after any `> ` quote prefix
  for plain->TODO. `toggleTodo`/`onToggleTodo` (checkbox click) are
  unchanged — the checkbox still only flips TODO<->DONE.
- `web/src/outline/keyboardPolicy.ts`: new `cycle-todo` `KeyDecision`,
  matched on `(metaKey || ctrlKey) && !altKey && !shiftKey` + Enter, checked
  before the plain-Enter `split` branch (and after the read-only cutoff, so
  it's a no-op in read-only views). The autocomplete popup's own Enter
  handling still takes precedence when the popup is open (unchanged
  ordering).
- `web/src/components/EditableBlockTree.tsx`: new `onCycleTodo` handler prop
  on `OutlineHandlers`; `onKeyDown` switch case calls it with
  `preventDefault()`.
- `web/src/outline/useOutline.ts`: new `onCycleTodo(uid)` handler mirroring
  `onToggleTodo`, calling `cycleTodo` and going through `run()` (which
  flushes any pending debounced draft text before applying, so the cycle
  always acts on the latest text). No new caret-restoration code was
  needed: the existing tryAdopt/clampCaret effect in `EditableBlockTree`
  already re-syncs the focused textarea's draft to the new `node.text` and
  clamps the caret to the new length.

Tests added (TDD): `web/src/grammar/todo.test.ts` (cycleTodo cases:
plain/TODO/DONE cycle, quote prefix, bracket-variant preserved TODO->DONE,
bracket-variant DONE->plain, empty string), `web/src/outline/keyboardPolicy.test.ts`
(Cmd-Enter and Ctrl-Enter -> cycle-todo; plain/Shift-Enter unaffected;
read-only suppresses it), `web/src/components/EditableBlockTree.test.tsx`
(Cmd-Enter / Ctrl-Enter / Cmd-Shift-Enter wiring to the handler prop), and a
new `web/src/outline/useOutline.todo.test.tsx` (hook-level wiring: full
plain->TODO->DONE->plain cycle through `run()`/sync, plus a debounced-draft
flush-before-cycle case).

Full `E2E_PORT=8982 pnpm verify` gate passed: typecheck, lint, FCIS check,
coverage-enforced unit tests (82 files / 1071 tests), build, and all 7
Playwright E2E specs.
