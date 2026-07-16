# Undo/Redo Design (pkm-7q14)

**Date:** 2026-07-16
**Bean:** pkm-7q14 — Add undo and redo support
**Status:** Approved

## Goal

Cmd-Z undoes the most recent local editing operation; Shift-Cmd-Z redoes the
most recently undone one. A new operation after undo clears the redo history.
Undo and redo preserve document/block consistency.

## Scope decisions (agreed)

- **Global per-tab history.** One undo stack for the whole app session, across
  journal day-outlines and page navigations. Entries are tagged with their
  page title.
- **Block edits only.** Page deletion (TopBar) stays behind its confirm
  dialog; restoring a whole page is out of scope (possible follow-up bean).
- **Collapse/expand is view state.** Batches consisting only of
  `set_collapsed` are never recorded; `set_collapsed` riders inside mixed
  batches (auto-expand during indent/move) are dropped from the inverse, so
  undo does not re-collapse. Exception: recreating a deleted subtree restores
  each node's collapsed flag — that is content fidelity, not a view toggle.
- **Own edits only.** Remote (other-client/other-tab) ops are never recorded
  and never undone.

## Approach: inverse op batches

Every edit gesture already becomes a `BlockOp[]` batch computed in
`edits.ts`, applied optimistically via `applyOps` (tree.ts), and enqueued
through `sync.enqueue` + `session.applyLocal` (`useOutline.run()`). Undo
records, at dispatch time, the inverse batch computed from the pre-edit tree.
Undo/redo then dispatch a recorded batch through the exact same pipeline as
any edit — optimistic apply, offline queue, replica persistence, server sync,
and websocket broadcast all work unchanged.

Rejected alternatives: tree snapshots + diff-to-ops (diff synthesis is harder
than inversion, memory-heavy, awkward for a global cross-page stack); native
browser undo for text + custom structural stack (per-block textareas remount
on structural edits, killing native history; two interleaved histories can't
satisfy the "most recent operation" AC).

## Components

### `web/src/outline/history.ts` — Functional Core

```ts
interface HistoryEntry {
  pageTitle: string;
  ops: BlockOp[];        // forward batch (redo replays this)
  inverse: BlockOp[];    // undo batch
  focusBefore: FocusTarget | null;  // restored on undo
  focusAfter: FocusTarget | null;   // restored on redo
}
```

- `invertOps(tree: BlockNode[], pageTitle: string, ops: BlockOp[]):
  BlockOp[] | null` — walks the forward batch op-by-op against a simulated
  tree (stepping with the existing `applyOps`), collecting one inverse per
  op, then returns the reversed list. Returns `null` when any op is not
  invertible from this tree; the caller then records nothing (history is
  otherwise untouched).
- Pure stack transitions over `{undoStack, redoStack}` with a cap
  (100 entries): `record` pushes and clears the redo stack; `takeUndo` moves
  the top entry to the redo stack and returns it; `takeRedo` mirrors.

### Inversion semantics

| Forward op | Inverse |
|---|---|
| `create` | `delete uid` |
| `update_text` | `update_text` with the pre-op text read off the simulated tree |
| `move` | `move` back to the old `parent_uid` + the node's old `order_idx` (the shift-before-insert contract lands the block before its old next sibling; absolute order_idx gaps may differ, which the server tolerates) |
| `delete` | pre-order `create` ops rebuilding the whole subtree (uid, text, heading, view_type, order_idx) plus `set_collapsed` for nodes that were collapsed |
| `set_heading` / `set_view_type` | same op with the old value |
| `set_collapsed` | dropped from the inverse (see scope decisions) |
| `create_page` | nothing (additive, harmless to leave) |
| cross-page move (moved block or target parent not in this tree) | not invertible → `null` |

### `web/src/outline/undoManager.ts` — Imperative Shell

Module-level singleton (same pattern as `activeOutlines.ts`) holding the
per-tab history state. API: `record(entry)`, `undo(deps)`, `redo(deps)`,
where deps provide `enqueue`, session lookup by title, focus/navigation
callbacks. Dispatch of an entry:

1. `sync.enqueue(batch, ["page", entry.pageTitle])`.
2. If an outline session for that title is live, `applyLocal` so the change
   renders instantly and focus is restored (`focusBefore` on undo,
   `focusAfter` on redo).
3. If the page is not currently rendered, the ops still apply (replica and
   server stay correct) and the app navigates to that page so the effect is
   visible.

Session lookup requires a non-creating `peekOutlineSession(title)` alongside
`acquireOutlineSession`.

### Capture point: `useOutline.run()`

`run()` is the single choke point every op-producing gesture flows through
(split, indent/outdent, moves, DnD `moveTo`, todo toggle, uploads,
`createFirstBlock`, `appendBlock`, slash commands, draft flushes). After
computing `ops` against the flushed `base` tree, it calls
`invertOps(base, pageTitle, ops)` and records the entry when the result is
non-null and not collapse-only. `dnd.removeSubtreeLocal` /
`insertSubtreeLocal` are visual staging only (their ops arrive via `moveTo`)
and record nothing themselves.

### Keyboard

- **Inside a block textarea:** `decideEditorKey` gains
  `{type: "undo"}` / `{type: "redo"}` for Cmd-Z / Shift-Cmd-Z, plus
  Ctrl-Z / Ctrl-Shift-Z for non-Mac (matching the todo-cycle
  `metaKey || ctrlKey` precedent). Read-only-gated. The shell
  `preventDefault`s so native textarea undo never fights the app stack. The
  handler flushes the block's pending draft first, so the first Cmd-Z undoes
  whatever was typed since the last flush.
- **Outside a textarea** (block selection active, or nothing focused): a
  global keydown listener that ignores events targeting editable elements —
  Cmd-Z in the search bar or a title input keeps native input undo. Block
  textareas preventDefault before the event would reach it.

### Typing granularity

One undo step per debounced `update_text` flush (500 ms idle, blur, tab-hide,
or pre-structural-edit flush). No sub-flush character undo in v1.

## Concurrency and failure behavior

Undo entries record ops, not tree states. If remote ops intervened, the
inverse batch applies best-effort with the same guarantees as any local op:

- A batch the server rejects (e.g. inverse targeting a remotely-deleted
  block) takes the existing 4xx poison path and is dropped.
- Text-undo racing a remote edit gets the server's normal update_text
  conflict handling. Inverse `update_text` ops carry no `base_text_hash`,
  matching the current client flush path (future hardening could add it).

No new consistency machinery is introduced.

## Acceptance-criteria mapping

- Cmd-Z undoes the most recent supported operation → keyboard + undoManager.
- Shift-Cmd-Z redoes → `takeRedo` + forward-batch replay.
- Consistency across operations → inverses are ordinary ops applied through
  the standard pipeline; delete-subtree restore covers the hard case.
- New operation after undo clears redo → `record` clears `redoStack`.
- Automated tests → below.

## Testing

- **Unit (`history.test.ts`):** `invertOps` per op type, including
  delete-subtree restore with heading/view_type/collapsed, mixed batches,
  collapse-only batches (not recorded), cross-page move (`null`), move
  inverse position semantics; stack transitions: record/undo/redo,
  redo-cleared-on-record, cap eviction.
- **Hook tests (`useOutline`):** an edit records an entry; undo dispatches
  the inverse and restores focus; redo replays; a fresh edit after undo
  clears redo; collapse toggles record nothing.
- **`keyboardPolicy` tests:** new chords (meta and ctrl variants),
  read-only gating, no clash with existing shortcuts.
- **E2E (Playwright):** type → structural edit → Cmd-Z twice → Shift-Cmd-Z,
  asserting tree state at each step; `press`, not `keyboard.type`.

## FCIS placement

`history.ts` is Functional Core (pure inversion + stack transitions).
`undoManager.ts` is Imperative Shell (singleton state, dispatch wiring).
`keyboardPolicy.ts` additions stay pure decisions; all DOM effects remain in
the shell components.
