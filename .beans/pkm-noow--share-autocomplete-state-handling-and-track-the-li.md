---
# pkm-noow
title: Share autocomplete state handling and track the live caret
status: completed
type: bug
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T13:21:07Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 9.

**References:** web/src/components/Composer.tsx:15-54; web/src/components/EditableBlockTree.tsx:397-399,558-618,786-792

Both editors update caret and autocomplete context only from onChange. Mouse clicks and selection-only caret movement can leave an old completion active, allowing Enter/Tab to edit the wrong location or consume an intended newline.

**Direction:** Recompute on selection changes or derive completion context from the textarea's live selection when executing a pick. Prefer a shared autocomplete-controller hook.

- [x] Add selection-only caret movement tests in both editors
- [x] Implement shared/live autocomplete context handling

## Summary of Changes

Both editors now hold their autocomplete state in one shared controller and never act on a remembered caret.

**Functional Core** — `web/src/outline/autocomplete.ts` gains `liveAcContext(stored, text, caret)`: given the context captured by the last input event and the text/caret read live off the textarea, it returns the context only when the live caret still implies exactly it (same kind, start and query), else null. A narrowed query counts as stale too — the rows on screen were fetched for the longer one, so completing would strand its tail.

**Shell** — new `web/src/outline/useAutocomplete.ts` owns the open context and the highlighted row for both editors, exposing `onEdit(text, caret)` (re-detect after a text edit), `close()`, and `resolve(el)`. `resolve` is the single gate every action path goes through: it re-derives the context from the live selection, closes the popup when it no longer matches, and otherwise returns `{ctx, caret, text}` — one consistent live snapshot for the splice. Documented as unsafe to call from `keyup`, because both editors place the caret after a key-edit in a `requestAnimationFrame` and keyup always lands inside that window.

`Composer.tsx` and `EditableBlockTree.tsx`'s `BlockInput` both dropped their private `ac` / `acSelected` / `caret` state for the hook. `pick` splices at `resolve`'s live caret (this covers the mouse-pick path, where the popup's `onMouseDown` preventDefault keeps the textarea's selection intact); `onKeyDown` resolves first and treats a stale popup as closed, so `decideEditorKey` sees `acRowsLength: 0` and Enter stays a split / Tab an indent instead of being swallowed; a new `onClick` on each textarea prunes a stale popup as soon as the user clicks away, rather than one keystroke later. Task 1's `autocompleteKeyAction` is unchanged and still decides which keys the popup may claim.

Tests: `autocomplete.test.ts` covers `liveAcContext` (live match, caret left the token, narrowed query, different token kind, closed popup). `Composer.test.tsx` and `EditableBlockTree.test.tsx` each add selection-only caret-move cases — Enter falls through (a split at the live caret in the outline; an unprevented newline in the Composer), Tab indents instead of completing a stale `[[` ref, a mouse pick on a stale row applies nothing, and clicking away closes the popup. jsdom does not move the caret for a native key, so these set the selection directly before dispatching, which is what the browser does.

`docs/architecture/frontend.md`: added `useAutocomplete.ts` to the `outline/` module map and a prose bullet on the shared popup state and the live-caret invariant.

Files changed: `web/src/outline/autocomplete.ts`, `web/src/outline/useAutocomplete.ts` (new), `web/src/components/Composer.tsx`, `web/src/components/EditableBlockTree.tsx`, `web/src/outline/autocomplete.test.ts`, `web/src/components/Composer.test.tsx`, `web/src/components/EditableBlockTree.test.tsx`, `docs/architecture/frontend.md`.
