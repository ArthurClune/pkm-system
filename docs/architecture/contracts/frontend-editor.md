# Contract: the outline editor

What one block's draft does, case by case.
`web/src/props/outline/draftModel.ts`, which the draft property
(`draft.prop.ts`) checks the real editor against, is written from this file
and never from the code, so a change in behaviour edits the row here and the
model together. Each section's principle, and why it holds, is in
[frontend-editor.md](../frontend-editor.md) under the same section name; a
reason that belongs to one row sits in that row.

## Drafts and commit points

| Event | The draft |
|---|---|
| plain typing | debounces (`TEXT_DEBOUNCE_MS` in `useOutline.ts`) |
| a structural edit, blur, undo, tab hide, or in-editor navigation (`onFlushDraft`) | flushes first |
| the caret inside a half-typed `[[ref` or `#tag` | is held |

## When a draft flushes

| When | Rule |
|---|---|
| A clean draft's first edit | `onDraftStart` opens the draft on the shown text, its `base`. `onDraftChange` only changes `text` |
| Undo, redo, or an upload that fills the focused (empty) block | the textarea adopts the tree's new text whenever no draft is pending. When one was, its end (`subscribeDraftEnd`) re-runs adoption even if the tree's text ends where it started |
| Focus or a new draft moves to another block | the old draft flushes first. A block a remote batch removes unmounts with no blur, so nothing else would flush it |
| A remote batch reparents the block or an ancestor | the textarea remounts with no blur. `BlockInput` reads `handlers.pendingDraft(uid)` at mount and resumes it dirty with its base, and restores the selection the old textarea reported (`onInputUnmount`) |
| A parent passes a new `initial` | the draft flushes first, so the parent tree waits for that write |

`pendingTextOps` decides what the flush sends:

| Draft at flush | Flush sends |
|---|---|
| `text === base`, or the tree already holds `text` | nothing |
| block in the tree, text changed | `update_text` with `base_text_hash` of `base`, plus `page_title` |
| block gone (remote delete, cross-page move) | the same op. The server applies it on the block's new page, or lands an edit to a deleted block on today's daily note |

## Keyboard policy

A keydown the IME owns decides `none`, whatever the key.
`useBlockDraft.imeOwns` answers for it:

| Keydown | Owned by the IME |
|---|---|
| `isComposing`, or between `compositionstart` and `compositionend` | yes (Chromium sends the committing Enter this way) |
| the first after a `compositionend`, with keyCode 229, within `IME_COMMIT_WINDOW_MS` | yes (WebKit ends the composition before sending its committing keydown) |
| any other, keyCode 229 included | no |
