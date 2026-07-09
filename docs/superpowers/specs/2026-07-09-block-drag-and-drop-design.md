# Block Drag-and-Drop (Desktop) — Design

**Date:** 2026-07-09
**Status:** Approved 2026-07-09
**Bean:** pkm-jg1p (related: pkm-g356 editable sidebar panels)

## Goal

Move blocks by dragging their bullet, Roam-style, anywhere in the rendered
UI: within a page, across days in the journal scroll, and between sidebar
panels and the main pane. Desktop pointer only (the design spec keeps outline
manipulation off touch).

## Decisions (from brainstorming)

- **Scope:** within-page AND cross-page (journal days, sidebar↔main) in one
  feature. Cross-page requires a server extension — the current `move` op
  rejects cross-page moves (`ops_core.py`: "cross-page move is not
  supported").
- **Depth model:** Roam-style. Drop-indicator line at the hovered boundary
  between rows; horizontal pointer position picks the depth among the levels
  valid at that boundary.
- **Implementation:** native HTML5 drag-and-drop (no dnd-kit dependency, no
  custom pointer-tracking layer). Cross-container drags are the API's sweet
  spot; its ghost-image/styling quirks don't matter for a drop-line UI.
  Semantic logic lives in pure Functional Core modules.
- **Server:** extend the existing `move` op rather than adding a new op type
  — keeps the atomic-batch and WS-broadcast story unchanged.

## Section 1: Interaction

- **Drag handle:** every block's bullet (`span.bullet`) becomes draggable.
  The block moves with its entire subtree; a collapsed subtree stays
  collapsed and moves as one.
- **Drop targets:** any boundary between rendered rows in any outline on
  screen — the main page outline, each day's outline in the journal scroll,
  and each sidebar panel — plus "empty" targets that accept a top-level
  drop: a day that doesn't exist yet (its "start writing" placeholder), an
  empty page body, an empty sidebar panel.
- **Depth selection at a boundary:** valid depths run from "child of the row
  above" (deepest) down to "sibling of the shallowest ancestor whose subtree
  ends at this boundary". The pointer's x-offset relative to the outline's
  indent width picks one; the indicator line renders at the chosen depth.
- **Exclusions:**
  - No boundary inside the dragged block's own subtree (indicator
    suppressed; the server's cycle check backs this up).
  - At a boundary immediately after a collapsed block, the child depth is
    excluded — nothing may land invisibly inside a closed subtree.
- **Cancel:** Escape, or releasing outside any valid boundary, cancels with
  no op. Dropping at the block's current position is a no-op (no op sent).
- **Out of scope:** multi-block selection drag; touch/iPad; auto-scroll
  polish beyond what the browser gives natively.

## Section 2: Server — cross-page `move`

`MoveOp` gains an optional `page_title: str | None` (default `None`).
Target-page resolution:

1. `parent_uid` set → target page is the parent's page. The existing
   cross-page guard is removed; `page_title`, if also sent, must agree with
   the parent's page (else 400).
2. `parent_uid` null, `page_title` set → top level of that page,
   auto-created if missing (same implicit-creation semantics as `create`;
   covers dropping onto a not-yet-existing journal day).
3. `parent_uid` null, `page_title` null → top level of the block's current
   page (today's behaviour, fully backward compatible).

Application (one transaction, as today):

- `ShiftSiblings` on the target parent/page; `SetParent` on the moved block;
  **new:** when the target page differs, update `page_id` for the entire
  subtree (recursive CTE), and `TouchPage` both source and target pages.
- Block uids never change, so `((block refs))` and `refs` rows (keyed by
  source-block uid) are untouched.
- FTS: the plan must check whether `blocks_fts` denormalizes page
  title/page_id; if it does, reindex the moved subtree's rows in the same
  transaction.
- Validation unchanged in spirit: missing parent / cycle / unknown uid →
  whole batch 400. New: rule-1 page mismatch above.

## Section 3: Client architecture

**Pure core — `web/src/outline/dnd.ts` (new, Functional Core):**

- Input: the flattened visible rows of one outline (uid, depth, parent
  chain, collapsed, subtree-of-drag flag) + pointer y (boundary) and x
  (depth).
- Output: a drop candidate `{boundaryIndex, allowedDepths, chosenDepth}` and
  its resolution to `{parent_uid, order_idx, page_title}` — using the same
  "insert before the block currently at order_idx, counted BEFORE removal"
  contract as `edits.ts` (same-page case must account for the dragged block
  still being in place).
- This module owns every semantic rule in Section 1 and is exhaustively
  unit-tested.

**Thin shell:**

- `EditableBlockTree`: bullet gets `draggable` + `onDragStart`
  (`dataTransfer` carries `{uid, sourcePage}`); the outline container
  handles `dragover` (compute candidate, position the single indicator
  element from row rects) and `drop`. Read-only/reconnecting disables both
  ends. Dragging the focused block flushes pending drafts first (existing
  structural-op flush path).
- `BlockTree` (sidebar panels): same drag-source and drop-target wiring,
  minus any optimistic tree surgery.

**Drop handling:**

- **Same page:** existing optimistic path — `useOutline.run()` with the
  move op from `dnd.ts`.
- **Cross-page:** one move op is enqueued; optimistically the source outline
  removes the subtree and the target outline inserts it (`outline/tree.ts`
  gains cross-tree remove/insert helpers). Focus is not moved.
- **Sidebar panels:** read-only snapshots stay simple — after a confirmed
  drop into or drag out of a panel, the panel refetches its payload.
- **Remote clients:** a received cross-page move triggers a resync of
  affected outlines (existing resync machinery) rather than two-tree
  patching.

## Section 4: Edge cases

- Dragged-while-focused: drafts flushed before the move (blur semantics
  already exist for structural ops).
- Same-position drop: detected in `dnd.ts`, no op emitted.
- Empty-day drop creates the page implicitly via rule 2 in Section 2.
- Journal day auto-created today by another client mid-drag: harmless —
  rule 2 is get-or-create.

## Section 5: Testing

- **Vitest (pure):** `dnd.ts` — boundary/depth resolution incl. allowed
  ranges, x→depth mapping, subtree and collapsed exclusions, same-position
  no-op, order_idx contract for same-page (pre-removal counting) and
  cross-page; `tree.ts` cross-tree helpers.
- **pytest:** cross-page move — subtree `page_id` update, both pages
  touched, auto-create target, page/parent mismatch 400, cycle unchanged,
  FTS correctness (per the check above), uids/refs stable.
- **Component tests:** jsdom `DataTransfer` stub — same-page drop emits one
  move op and reorders optimistically; cross-page drop updates both
  outlines; sidebar panel refetch on drop-in/drag-out; disabled when
  read-only.
- **Smoke:** manual/agent-browser run against real data per house practice
  (drag within a heavy page, across journal days, into and out of a sidebar
  panel).
