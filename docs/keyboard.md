# Keyboard shortcuts

Shortcuts are listed Mac-first. Where a Ctrl variant exists for non-Mac
keyboards, it is noted. Keys not listed here keep the browser's native text
editing: Option/Alt word moves, Cmd+arrow line and document jumps,
Ctrl+Shift+arrow paragraph selection, and the emacs-style Ctrl+letter
bindings.

## Anywhere in the app

| Shortcut | Action |
|---|---|
| Cmd+U (or Ctrl+U) | Focus search; press again in search to cancel and clear it |
| Ctrl+Shift+D | Go to Daily Notes |
| Cmd+/ (or Ctrl+/) | Show / hide the right sidebar |
| Cmd+Z / Shift+Cmd+Z (or Ctrl variants) | Undo / redo the last outline edit, whether or not a block is being edited. Undoing an edit on a page that isn't open takes you there |
| Cmd+J (or Ctrl+J) | Show / hide the Assistant panel |
| Ctrl+Shift+T | Show / hide timestamps |

## Search

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move the highlight through the results, including the "Create page" row |
| Enter | Open the highlighted result, or create the page from the "Create page" row |
| Shift+Enter | Open the highlighted result in the right sidebar |
| Escape | Cancel and clear the search |

## Editing a block

### Moving between blocks

These use plain arrows. With a modifier, arrows do something else or keep
their native behaviour.

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move within the block; from its first/last line, move to the block above/below |
| ← / → | Move within the block; from its start/end, move to the previous/next block |

### Selecting text

| Shortcut | Action |
|---|---|
| Shift+arrows | Native text selection within the block; at the block's first/last line it becomes a block selection (see below) |
| Shift+Cmd+← | Select to the start of the current line; each further press adds the line above |
| Shift+Cmd+→ | Select to the end of the current line; each further press adds the line below |
| Ctrl+Cmd+← | Select from the caret to the start of the block, across all its lines |
| Ctrl+Cmd+→ | Select from the caret to the end of the block, across all its lines |

### Selecting blocks

| Shortcut | Action |
|---|---|
| Ctrl+Cmd+↑ or Ctrl+Cmd+↓ | Select the current block; each further press extends the selection one block up/down |
| Shift+↑ at the block's first line / Shift+↓ at its last line | Select the current block and its neighbour. With text selected, once the selection can't grow within the block, the next Shift+↑/↓ turns it into a block selection |

See "While blocks are selected" below for what you can do next.

### Structure and movement

| Shortcut | Action |
|---|---|
| Enter | Split the block at the caret |
| Shift+Enter | New line inside the block |
| Tab / Shift+Tab | Indent / outdent (outdent takes the following siblings along as its children) |
| Shift+Cmd+↑ / Shift+Cmd+↓ | Move the block and its subtree up/down at the same depth, crossing into other parents where needed |
| Backspace at the start of a block | Merge into the previous sibling when neither block has children. Otherwise an empty block without children is deleted |
| Shift+Cmd+V (or Ctrl+Shift+V) | Paste multi-line text as an outline: each line becomes a block, and indentation (tabs or spaces) becomes nesting. Plain Cmd+V pastes into the current block |

### Formatting and editing

| Shortcut | Action |
|---|---|
| Cmd+B / Cmd+I | Bold / italic (wraps or unwraps the selection) |
| Cmd+K | Wrap the selection as a markdown link |
| Cmd+Enter (or Ctrl+Enter) | Cycle plain → TODO → DONE |
| Cmd+Alt+1/2/3 | Heading level 1/2/3 |
| Cmd+Alt+0 | Back to plain text |
| Ctrl+O | Open the `[[page]]` the caret is inside |
| Ctrl+Shift+O | Open the `[[page]]` the caret is inside in the sidebar |
| `[`, `(`, `{`, `"`, `'`, backtick | Auto-pair, or wrap the selection; typing `[[` opens the page-link autocomplete |
| Escape | Stop editing the block |

### Autocomplete popup (after `[[`, `#`, or `/`)

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move the highlight |
| Enter or Tab | Pick the highlighted row |
| Escape | Close the popup, keeping what you typed |

Keys with a modifier keep their usual meaning while the popup is open.

### On an iPhone

The iPhone keyboard has no Tab key. While you edit a block, a bar above the
keyboard offers the missing keys. Each does what that key does on a hardware
keyboard.

| Key | Action |
|---|---|
| → | Indent (Tab) |
| ← | Outdent (Shift+Tab) |
| ( ) [ ] | Type the bracket, with the usual auto-closing and `[[` link popup |

## Slash commands

Typing `/` at the start of a block or after a space opens the command menu.
The menu uses the autocomplete popup keys above. Keep typing to filter the
list: `/py` narrows to the Python code block and `/query-o` to the OR query.

| Command | Action |
|---|---|
| `/text` | Turn the block into a plain text block (shown verbatim, no formatting) |
| `/todo` | Prefix the block with a TODO checkbox |
| `/table` | Turn an empty block into a `{{table}}`: the block's children become the table's rows, the first row being the header |
| `/toc` | Turn an empty block into a `{{toc}}`: a table of contents of the page's headings, nested by outline and kept up to date; each entry jumps to its heading |
| `/python`, `/shell`, `/javascript` | Turn the block into a highlighted code block |
| `/mermaid` | Turn the block into a Mermaid diagram |
| `/upload` | Pick files to upload; each goes on its own bullet after this one (an empty block takes the first); an image shows inline |
| `/h1`, `/h2`, `/h3` | Make the block a heading (picking its current level turns it back into normal text) |
| `/normal` | Back to normal text |
| `/query-and` | Turn an empty block into a query placeholder, `{{query: {and: A B}}}`, for blocks tagged with both pages |
| `/query-or` | Turn an empty block into a query placeholder for blocks tagged with either page |
| `/query-and-not` | Turn an empty block into a query placeholder for blocks tagged with the first page but not the second |
| `/today`, `/tomorrow` | Insert a link to today's / tomorrow's daily note |
| `/date` | Pick a date from a calendar and insert a link to its daily note; Escape closes the calendar |
| `/link-local-file` | Browse or search the server's local files folder and insert a `Local copy::` link to the file you pick |
| `/goodlinks` | Find the nearest web link: in this block, then its parent, then its previous sibling. Look it up in GoodLinks and insert a `Local copy::` link to the saved copy. A page GoodLinks does not have yet is saved there, marked read |

Replace the `A` and `B` placeholders with `[[Page]]` links to run the query.
Type `[[` to search for a page. The placeholders are plain text, so they never
create pages named "A" or "B". The query shows an error until you fill them
in.

## While blocks are selected

The selection takes over the keyboard until it's cleared.

| Shortcut | Action |
|---|---|
| Ctrl+Cmd+↑/↓ or Shift+↑/↓ | Extend or shrink the selection one block at a time |
| Shift+Cmd+↑ / Shift+Cmd+↓ | Move the selected blocks up/down as a group, keeping their structure |
| Tab / Shift+Tab | Indent / outdent the selected blocks (outdent takes the trailing siblings along under the last selected block) |
| Cmd+C (or Ctrl+C) | Copy the selected blocks' text, one line per block with nesting as tabs; Shift+Cmd+V pastes it back with the hierarchy intact |
| Backspace or Delete | Delete the selected blocks (asks first when more than 20; Cmd+Z undoes it until the tab reloads) |
| ↑ / ↓ (no modifier) | Drop the selection and go back to editing |
| Escape | Clear the selection |

## Block menu

Open it by clicking or right-clicking a block's bullet. On a focused bullet,
Enter, Space, Shift+F10 or the context-menu key opens it too.

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
| A block's references popover, on an entry (focused) | Enter | Jump to the referencing block |
| Assistant panel | Enter | Send the message |
| Assistant panel | Shift+Enter | New line in the message |
| Assistant panel | Escape | Close the panel |
| Link a local file | ↑ / ↓ | Move the highlight |
| Link a local file | Enter | Open the highlighted folder, or link the highlighted file |
| Link a local file | Backspace in an empty search | Go up one folder |
| Link a local file | Escape | Close |
| Confirmation dialog | Enter / Escape | Confirm / cancel |
| Expanded image | Escape | Close |
| PDF viewer (expanded) | Escape | Close |
| GoodLinks reader | Escape | Close |
