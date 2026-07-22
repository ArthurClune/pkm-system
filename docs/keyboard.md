# Keyboard shortcuts

All shortcuts are listed Mac-first. Where a shortcut also exists for
non-Mac keyboards, the Ctrl variant is noted. Everything not listed here
is left to the browser's native text editing (Option/Alt word moves,
Cmd+arrow line/document jumps, Ctrl+Shift+arrow paragraph selection, the
emacs-style Ctrl+letter bindings, and so on).

## Anywhere in the app

| Shortcut | Action |
|---|---|
| Cmd+U (or Ctrl+U) | Focus search; pressed again while in search, cancel and clear it |
| Ctrl+Shift+D | Go to Daily Notes (Ctrl+Cmd+D is reserved by macOS for dictionary lookup) |
| Cmd+/ (or Ctrl+/) | Show / hide the right sidebar |
| Cmd+Z / Shift+Cmd+Z (or Ctrl variants) | Undo / redo — global, works whether or not a block is being edited |

## Search

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move the highlight through the results (including the "Create page" row) |
| Enter | Open the highlighted result |
| Shift+Enter | Open the highlighted result in the right sidebar |
| Escape | Cancel and clear the search |

## Editing a block

### Moving between blocks

Plain arrows only — a modifier always means something else (or stays
native).

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move within the block; from its first/last line, move to the block above/below |
| ← / → | Move within the block; from its very start/end, move to the previous/next block |

### Selecting text

| Shortcut | Action |
|---|---|
| Shift+arrows | Native text selection within the block |
| Ctrl+Cmd+← | Select from the caret to the start of the block (the whole block text, not just the current display line); further presses change nothing |
| Ctrl+Cmd+→ | Select from the caret to the end of the block; further presses change nothing |

### Selecting blocks

| Shortcut | Action |
|---|---|
| Ctrl+Cmd+↑ or Ctrl+Cmd+↓ | Select the whole current block; each further press extends the selection one block up/down |
| Shift+↑ at the block's first line / Shift+↓ at its last line | Start a block selection: the current block plus its neighbour |

See "While blocks are selected" below for what you can do next.

### Structure and movement

| Shortcut | Action |
|---|---|
| Enter | Split the block at the caret |
| Shift+Enter | New line inside the block |
| Tab / Shift+Tab | Indent / outdent |
| Shift+Cmd+↑ / Shift+Cmd+↓ | Move the block and its whole subtree up/down, keeping its depth, across parents where needed |
| Backspace at the start of a block | Merge into the previous block |

### Formatting and editing

| Shortcut | Action |
|---|---|
| Cmd+B / Cmd+I | Bold / italic (wraps or unwraps the selection) |
| Cmd+K | Wrap the selection as a markdown link |
| Cmd+Enter (or Ctrl+Enter) | Cycle plain → TODO → DONE |
| Ctrl+Alt+1/2/3 | Heading level 1/2/3 |
| Ctrl+Alt+0 | Back to plain text |
| Ctrl+O | Open the `[[page]]` the caret is inside |
| `[`, `(`, `{`, `"` | Auto-pair; typing `[[` opens the page-link autocomplete |
| Escape | Stop editing the block |

### Autocomplete popup (after `[[`, `#`, or `/`)

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move the highlight |
| Enter or Tab | Pick the highlighted row |
| Escape | Close the popup (keeps what you typed) |

Ctrl+Cmd and Option/Alt arrow chords still work while the popup is open.

## While blocks are selected

The selection owns the keyboard until it's cleared.

| Shortcut | Action |
|---|---|
| Ctrl+Cmd+↑/↓ or Shift+↑/↓ | Extend or shrink the selection one block at a time |
| Shift+Cmd+↑ / Shift+Cmd+↓ | Move all selected blocks up/down as one group, keeping their structure |
| Tab / Shift+Tab | Indent / outdent all selected blocks together |
| Cmd+C (or Ctrl+C) | Copy the selected blocks' text |
| Backspace or Delete | Delete the selected blocks (asks first when more than 5) |
| ↑ / ↓ (no modifier) | Drop the selection and go back to editing |
| Escape | Clear the selection |

## Block menu

Open it by clicking (or right-clicking) a block's bullet, or with
Enter / Space on a focused bullet.

| Shortcut | Action |
|---|---|
| ↑ / ↓ / Home / End | Move through the menu items |
| Enter | Pick the highlighted item |
| Escape or Tab | Close the menu |

## Elsewhere

| Context | Shortcut | Action |
|---|---|---|
| Page title (while renaming) | Enter | Commit the new title |
| Page title (while renaming) | Escape | Cancel the rename |
| Block reference `((…))` (focused) | Enter | Jump to the referenced block |
| Expanded image | Escape | Close |
| PDF viewer (expanded) | Escape | Close |
