---
# pkm-wxwp
title: Wrapping a selection in [[ ]] does not open the ref autocomplete
status: completed
type: bug
priority: normal
created_at: 2026-09-03T13:04:36Z
updated_at: 2026-09-03T13:08:30Z
---

Typing '[[devi' opens the fuzzy title popup, but selecting 'device' and typing '[[' wraps it as [[device]] with the inner text still selected and no popup appears. Root cause: BlockInput.applyKeyEdit re-detects the completion context at selStart (just after the '[[', query '') so useTitleOptions('') returns nothing and buildRows renders no rows; and useAutocomplete.resolve reads selectionStart for the staleness check, so even a detected 'device' context would be judged stale against the collapsed-start caret.

- [x] Failing unit test (BlockInput: wrap selection with [[ -> popup offers the text; Enter completes, not splits)
- [x] Detect and resolve at the selection END (selEnd / selectionEnd), which equals the caret when collapsed
- [x] pnpm test:unit (2547 pass) + typecheck green
- [x] Docs: frontend.md autocomplete invariant gains the selectionEnd rule and a symptom row

## Summary of Changes

- `BlockInput.applyKeyEdit` re-detects the completion context at `selEnd` instead of `selStart`, so a `[[` wrapped around a still-selected word uses that word as the query.
- `useAutocomplete.resolve` reads `selectionEnd` for the liveness check and splice caret, so Enter/click on the popup completes over the selection instead of judging it stale. Both offsets coincide for a collapsed caret, so plain typing is unchanged.
- Unit test in BlockInput.test.tsx: select 'hello', type '[' twice, popup offers 'New page: hello', Enter completes to `[[hello]]` and does not split.
- docs/architecture/frontend.md: autocomplete invariant states the selectionEnd rule; symptom table gains a row.
