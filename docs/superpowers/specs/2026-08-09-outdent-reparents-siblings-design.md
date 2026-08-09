# Outdent reparents following siblings (pkm-udqj)

## Problem

Outdenting a block moves just that block to sit after its former parent,
leaving its following siblings behind. The outdented block visually jumps
down past them, and there is no easy gesture to insert a block directly
after a subtree — you have to click into the subtree's last block and press
Enter, which is painful when large images push that block far up the page.

Given:

```
level 1
    a - level 2
        b - level 3
        a - level 3
```

outdenting `b` today produces:

```
level 1
    a - level 2
        a - level 3
    b - level 2   <- moved below its former siblings
```

## Decision

Outdent takes the following siblings with it as children — the standard
behavior in Logseq, Workflowy, and org-mode. The example becomes:

```
level 1
    a - level 2
    b - level 2
        a - level 3   <- reparented under b
```

The page reads identically top-to-bottom before and after the outdent; only
depths change.

## Behavior

### Single block (`outdentBlock`)

Outdenting block `b` under parent `P`:

- `b` moves to sit immediately after `P` (unchanged from today).
- `b`'s former following siblings become children of `b`, appended **after**
  `b`'s existing children, order preserved.
- If `b` is collapsed and gains reparented siblings, emit
  `set_collapsed(b, false)` first — otherwise the siblings would silently
  vanish into a collapsed subtree. Mirrors the existing precedent in
  `indentBlock`, which expands a collapsed target. No expansion when there
  are no trailing siblings to adopt.
- Outdenting the **last** child keeps today's exact behavior — this is the
  "insert after this subtree" gesture the change is for.
- Top-level blocks: still a no-op.

### Multi-select (`outdentSelection`)

Per sibling run, the unselected siblings between the end of that run and the
next selected run in the same sibling group (or the end of the sibling list)
reparent under the run's **last** block, appended after its existing
children. A split selection `[a, b*, c, d*, e]` gives `b` child `c` and `d`
child `e`, again preserving read order. Same collapse-expansion rule for a
run's last block when it gains children. The existing preflight — any
top-level run aborts the whole gesture — stays.

### Unchanged

- Indent stays asymmetric (does not adopt trailing siblings — same as
  Logseq).
- Move up/down (`moveBlockUp`, `moveBlockDown`, `moveSubtreeUp`) unchanged.
- All new behavior is expressible with existing `move` + `set_collapsed`
  ops: no server, API, or schema changes. The change is confined to the two
  Functional Core planners in `web/src/outline/edits.ts` plus tests.

## Accepted trade-off

Outdent stops being the exact inverse of indent: outdent `b` then
immediately indent it, and `b` keeps its acquired children instead of them
returning to the old parent. Logseq behaves the same way; Ctrl-Z still
undoes cleanly via op history.

## Testing

TDD in `web/src/outline/edits.test.ts`:

- trailing siblings reparent under the outdented block
- no trailing siblings → placement identical to today
- reparented siblings append after existing children
- collapsed outdented block expands when it adopts siblings; no
  `set_collapsed` op when it adopts none
- multi-select: consecutive run adopts trailing siblings under its last
  block; split runs in one sibling group each adopt only their gap
- top-level outdent stays a no-op

Existing outdent tests updated where they asserted the old placement.
