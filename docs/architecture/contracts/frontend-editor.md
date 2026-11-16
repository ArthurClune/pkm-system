# Contract: the outline editor

Which blocks the editor shows as rows, what one block's draft does, and what
a table's view and cell editor do, case by case. These models are written from this file and never from the code, so
a change in behaviour edits the row here and the models together:

- `web/src/props/outline/visibleTree.ts`, the row model that
  `web/src/outline/visibleUids.props.test.tsx` checks `visibleUids`,
  `selectableUids` and `EditableBlockTree` against;
- `web/src/outline/validateOutlineFocus.props.test.ts`, which checks
  `validateOutlineFocus` with that row model;
- `web/src/props/outline/draftModel.ts`, which the draft property
  (`draft.prop.ts`) checks the real editor against;
- `web/src/props/tables/model.ts`, which `viewState.prop.ts` checks
  `stepView` against;
- `web/src/props/tables/queryModel.ts`, which `queryView.prop.ts` checks
  `stepQueryView`, `showQuery` and `holdRecords` against;
- `web/src/props/tables/cellModel.ts`, which `cellEditor.prop.ts` checks
  `stepEditor` and `neighbourCell` against.

Each section's principle, and why it holds, is in
[frontend-editor.md](../frontend-editor.md) under the same section name; a
reason that belongs to one row sits in that row.

## Rules an edit must not break

`hidesChildren` (`outline/tree.ts`) decides what hides, for
`EditableBlockTree`, `visibleUids`, `selectableUids` and
`validateOutlineFocus` alike.

A block's text is a table macro (`tableMacroOptions` in
`grammar/macroOptions.ts`) when, trimmed, it is the whole of one of two
spellings, optionally carrying a saved view's options:

| Text | A table macro? | Reason |
|---|---|---|
| `{{table}}` | yes | the spelling `/table` writes |
| `{{[[table]]}}` | yes | the spelling Roam imports hold |
| either, in another letter case (`{{TABLE}}`, `{{[[Table]]}}`) | yes | |
| either, with spaces or a newline around it | yes | |
| either, followed by options before its `}}` (`{{table \| sort: Lab desc}}`, `{{[[table]] \| filter: x \| view: cards}}`) | yes | a saved view; the options never change which children are rows |
| either, followed by spaces and then options (`{{table  \| sort: A asc}}`) | yes | the options start at the first ` \| ` |
| either, with other text beside it (`{{table}} x`) | no | |
| either, with options and then other text (`{{table \| view: cards}} notes {{toc}}`, `{{table \| a}} {{query: {and: [[B]]}}}`, `{{table \| filter: a}} b}}`) | no | the text's opening `{{` must close, braces counted, on its last character; else the trailing text would read as option text, and a rewrite of the options would drop it |
| either, with a `\|` not spaced as ` \| ` (`{{table\|sort: A asc}}`) | no | only ` \| ` starts an option |
| either, with other text before the first ` \| ` (`{{table [[a \| b]]}}`) | no | the head must be the bare name |
| a near spelling: `{{tables}}`, an unclosed `{{[[table]]`, a bare `table` | no | |

| A block whose text is a table macro | A valid Roam table (`roamTableRows` returns rows)? | Reason |
|---|---|---|
| with no children | no | |
| whose children each start a row, every cell of a row holding at most one child (the next cell) | yes | |
| with a cell, anywhere in a row, holding two or more children | no: it is an ordinary block | a grid has no place for the branch, and an ordinary block keeps it on screen |

Which children are rows, judged top-down:

| Block | Its children | Reason |
|---|---|---|
| a valid table, the focus on it or in its subtree (`focusChain`) | rows, collapsed or not: the raw outline, each cell an ordinary block | a cell is edited in its own row's textarea |
| a valid table, the focus elsewhere or none | not rows: the table is one row that draws the grid (`RoamTable`) | |
| a collapsed block with children | hidden (`hidesChildren`) | |
| any other block | rows | |

| Case | Outcome | Reason |
|---|---|---|
| a cell of a valid table whose children are rows | judged as any block: a collapsed cell with a child hides the rest of its row | |
| a heading (`heading` 1 to 3), or any `view_type` (`numbered`, `document`, unset) | the same rows as without it | a heading and a view type change how a row draws, never which rows show |

| Reader | Lists | Reason |
|---|---|---|
| `EditableBlockTree` (`.block-row`, in order) | the rows above, for the focus it is given | |
| `visibleUids` | the rows above, every valid table's children among them, wherever the focus is | a focus can sit in any cell, and arrows step through a table's cells once the focus is inside it |
| `selectableUids` | the rows above, no valid table's children among them: a table is one stop and its cells never one, collapsed or not | a selection clears the focus, so every table draws as its grid |

| Focus | `validateOutlineFocus` returns | Reason |
|---|---|---|
| a uid not in the tree | null | |
| a block under an ancestor that hides its children | that ancestor, the outermost if several, with the caret at the end of its text | it is the row on screen |
| a block in a collapsed valid table's subtree | the focus | a valid table hides nothing |
| a collapsed block itself | the focus | only its children hide |
| a block on screen, the caret past the end of its text | the caret clamped to the text's length | undo restores a caret recorded on other text |
| a block on screen, the caret between the halves of a surrogate pair | the caret moved to the pair's start (`snapCaret`) | typing there would leave two lone halves, saved as U+FFFD |
| a block on screen, the caret inside its text | the same object | |

## Drafts and commit points

| Event | The draft |
|---|---|
| plain typing | debounces (`TEXT_DEBOUNCE_MS` in `useOutline.ts`) |
| a structural edit, blur, undo, tab hide, or in-editor navigation (`onFlushDraft`) | flushes first |
| the caret inside a half-typed `[[ref` or `#tag` | is held |

| Case | Rule | Reason |
|---|---|---|
| the draft's `base` | the text the textarea showed before the clean draft's first edit (`onDirty`). It is not the tree's text when the tree changed and the textarea has not adopted it yet | |
| a flush's `base_text_hash` | hashes `base`, never the tree's text | |
| the textarea, a draft pending | shows the draft; text that lands on the tree is not adopted | |
| the textarea, no draft pending | adopts the tree's text each time it changes | |
| the textarea, an IME composition in progress | adopts nothing; at `compositionend` it adopts the tree's text if no draft is pending | replacing the value mid-composition disturbs the native composition UI |

## When a draft flushes

| When | Rule |
|---|---|
| A clean draft's first edit | `onDraftStart` opens the draft on the shown text, its `base`. `onDraftChange` only changes `text` |
| Undo, redo, or an upload that fills the focused (empty) block | the textarea adopts the tree's new text as [above](#drafts-and-commit-points). When a draft was pending, its end (`subscribeDraftEnd`) re-runs adoption even if the tree's text ends where it started |
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

A keydown the IME does not own, with no autocomplete row or date picker
open, is decided by `decideEditorKey` (`outline/keyboardPolicy.ts`):

| Keydown | Decision | Reason |
|---|---|---|
| Enter with no modifier, keyCode 229 included, the block editable | `split` at `selStart`: the block becomes two | |
| Escape, with or without a modifier, read-only included | `blur`: the block leaves edit mode, and the blur flushes its draft ([Drafts and commit points](#drafts-and-commit-points)) | |

## The table view

`stepView` (`tables/viewState.ts`) holds a saved and a live view, each a
filter, a sort, a view and columns, and the rows held after a cell edit.
The view is dirty when `isDirty` finds a field of the live view that
differs from the saved view's (`sameView`). It compares the fields, not the
macro text; a filter is compared as the macro stores it, so padding alone
is not a change. Reset and Save show only while it is dirty.

| Event | Saved view | Live view | Held rows | Reason |
|---|---|---|---|---|
| a filter typed | unchanged | that filter | released | a view change asks for the rows that view gives |
| a click on the header of a column the view is not sorted by | unchanged | sorted by it, ascending | released | |
| a click on the header of the column sorted ascending | unchanged | sorted by it, descending | released | |
| a click on the header of the column sorted descending | unchanged | unsorted | released | |
| a view switched, or columns hidden, added or moved | unchanged | that view or those columns | released | |
| a cell written, no rows held | unchanged | unchanged | the rows on screen, in order | an edited row must neither move nor vanish under the reader |
| a cell written, rows held | unchanged | unchanged | unchanged | the first edit's rows stay |
| Reset | unchanged | the saved view | released | |
| Save, written | the live view | unchanged | unchanged | |
| a refetch, the view dirty | the macro's options | unchanged | unchanged | a refetch must not lose the reader's changes |
| a refetch, the view clean | the macro's options | the macro's options | unchanged | a Save on another device must not leave this one offering Reset |
| the block unmounted and mounted again | the macro's options | the saved view | none | the state belongs to the mounted block |

What a query block shows (`showQuery`). A field follows the defaults when
the macro's options leave it out. The first edit is the first cell write
since the rows were last released. A live view the reader changes while
rows are held releases them, so what the first edit saw is never older
than the reader's own changes.

| Case | Shows | Reason |
|---|---|---|
| no rows held | the live view, its columns, and the current records through the live filter and sort, none stale | |
| no rows held, a column's key | the key the current key stats give it, by label and then as a key; else the label | |
| rows held, the view following the defaults | the view shown at the first edit | a refetch whose records hold no `::` line makes blocks the default, which would take the table and an open draft from the reader |
| rows held, the view not following the defaults | the live view | a view the macro sets is not a default |
| rows held, the columns following the defaults | the column labels shown at the first edit, in that order | a refetch whose records no longer hold a key drops its column from the defaults |
| rows held, the columns not following the defaults | the live view's columns | columns the macro sets are not defaults |
| rows held, a column's key | the key the current key stats give it, else the one the first edit's stats give it, each by label and then as a key; else the label | a held row's cell must read and write its own line |
| rows held, the rows | the first edit's rows, in order, each from the current records or else from its last record; one the current records lack is stale | an edited row must neither move nor vanish |
| a second edit while rows are held | what the first edit saw, unchanged | |

## The cell editor

`stepEditor` (`tables/cellEditor.ts`) holds at most one open cell, with
the value it opened with and the reader's draft. Closing a cell writes its
draft, outer whitespace trimmed, unless that equals the opening value
trimmed; then it writes nothing. "Writes the draft" below means that rule.

| Event | Open cell after | Writes | Reason |
|---|---|---|---|
| a click on a cell, none open | that cell, its draft its stored value | nothing | |
| a click on the open cell | unchanged | nothing | reopening would drop the draft |
| a click on another cell | that cell | the draft | |
| typing | unchanged, with the new draft | nothing | |
| Enter, or a click outside any cell | none | the draft | |
| Esc | none | nothing | |
| Tab | the next editable cell in row-major order, or none past the last | the draft | |
| Shift-Tab | the previous editable cell, or none before the first | the draft | |
| anything but a click on a cell, none open | none | nothing | |
