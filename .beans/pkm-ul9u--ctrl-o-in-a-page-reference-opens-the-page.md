---
# pkm-ul9u
title: Ctrl-O in a page reference opens the page
status: completed
type: feature
priority: normal
created_at: 2026-07-10T16:36:54Z
updated_at: 2026-07-10T17:41:17Z
---

With the cursor inside a [[page reference]] while editing, pressing Ctrl-O should open the referenced page (matching Roam/Logseq behaviour).

- [x] Detect when the caret is within a page-reference token in the editor
- [x] Ctrl-O navigates to that page
- [x] No conflict with existing browser/app shortcuts
  - macOS browsers use Cmd-O for file-open, not Ctrl-O, so there's no clash
    there. On Windows/Linux, Ctrl-O is the browser's open-file shortcut, but
    we only `preventDefault()` it when the caret is inside a `[[ref]]` in a
    focused block textarea (`refTitleAtCaret` returns non-null) — outside a
    ref the key passes through untouched. This matches Roam's behaviour and
    is a narrow enough interception to be acceptable.
- [x] Tests

## Summary of Changes

- Added a pure helper `refTitleAtCaret(text, caret)` in
  `web/src/outline/refAtCaret.ts` (Functional Core) that does a balanced
  `[[...]]` bracket scan (mirroring `grammar/refs.ts`'s `scanBrackets`) but
  keeps start/end offsets, so it can report the title of whichever ref span
  contains the caret (inclusive of the brackets). Returns `null` for: caret
  outside any span, unclosed `[[`, and empty `[[]]`. When refs are nested,
  the innermost span wins. Unit tests in
  `web/src/outline/refAtCaret.test.ts` cover caret inside/outside, bracket
  boundaries, multiple sibling refs (`[[a]] b [[c]]`), unclosed `[[`, empty
  `[[]]`, and nesting.
- Wired it up in `web/src/components/EditableBlockTree.tsx`'s `BlockInput`
  `onKeyDown` (Imperative Shell): on `Ctrl-O` (not Cmd/Alt) with the caret
  inside a ref, `preventDefault()` and `navigate(pagePath(title))` via
  `useNavigate` from `react-router-dom` and `pagePath` from `../paths`. The
  check sits after the existing autocomplete-popup key handling (so an open
  popup's Arrow/Enter/Tab/Escape handling is unaffected, and doesn't block
  Ctrl-O — "o" isn't one of the popup's keys anyway) and before the
  `readOnly` early return, so the key is left completely alone (no
  `preventDefault`) whenever the caret isn't inside a ref.
- Component tests added to `web/src/components/EditableBlockTree.test.tsx`:
  Ctrl-O with the caret inside `[[World]]` navigates (asserted via a
  `MemoryRouter` + `Routes` pair, following `SearchModal.test.tsx`'s
  navigation-assertion pattern); Ctrl-O with the caret in plain prose does
  not navigate and leaves the route untouched.
- Verified: `cd web && pnpm test -- --run` → 305 tests passed (41 files);
  `cd web && pnpm typecheck` → clean.
