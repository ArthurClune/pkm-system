# Outline depth cap (pkm-2kwd)

## Why

An outline 255 levels deep makes `GET /api/page`, `/api/block/{uid}` and
`/api/journal` answer 500: pydantic-core's serialiser has a fixed recursion
guard, and `tree.build_tree` recurses on the Python stack behind it. Nothing
stops `/api/ops` from building such a chain (the review's probe made 2,000
levels in four batches). The SPA usually reads its local replica and so may
survive, but the CLI, the MCP tools, the assistant and a cold start all read
the server routes. Deep chains also make backlink breadcrumbs grow with the
cube of the depth (pkm-85jq).

Prod's deepest outline is 15 levels (2026-10-24, 57,938 blocks; anything
past 10 is a few dozen blocks).

## Decision

Arthur picked a **write-time cap of 100 levels**, and **any op that would
go past it fails its batch** (a 400), rather than being skipped with a
conflict note.

A top-level block is at depth 1; a block may sit at depth 100, not 101.

## Approaches considered

| Approach | Trade-off | |
|---|---|---|
| Cap at write time, reject | One bound protects every reader. Simplest server change. A rejected batch loses its other ops (below) | **chosen** |
| Cap at write time, skip like `move_cycle` | Never loses a batch's valid ops. Needs a new skip kind, a note, journal rows, and the replica's `skipsOnMissingTarget` mirror and `missing_targets.json` to learn it | not chosen: the case it protects (below) needs a 100-level outline |
| Iterative serialisation, no cap | Read routes only. Still unbounded: the limit moves to a few thousand levels, where JSON readers and every other recursive tree walk fail | not chosen |

## The rule

On the server, `ops_apply.apply_batch` judges each op as it reaches it, so
an op sees the earlier ops of its own batch applied:

- `create` under a live parent: fails when the parent sits at depth 100.
- `move` of a live block to a live parent: fails when the deepest block of
  the moved subtree would land past depth 100.
- Ops that are skipped (missing parent, cycle, stale page) are not judged:
  they place nothing.
- Top-level creates and moves are depth 1 and their subtrees are already
  judged, so a top-level move passes unless the subtree itself is over 100
  levels tall.

**Server-made landings are exempt** (my call). Conflict notes and a
diverged delete's copied subtree are written by the server, not sent by the
client, so a 400 there would discard a batch over something the client did
not do (`plan_op`'s docstring makes the same point for skips). They are
placed as today. Their depth stays under the 255 limit: a header the user
moved as deep as allowed sits at 100, and a copied subtree is at most 100
tall, so the deepest copy lands at 200. The check therefore sits on the
client's `create` and `move` only, never on effects the planner adds.

A failure raises `OpError` with the op's index and a message naming the
uid, the depth it would reach and the limit, the same shape as the title
syntax refusal. The batch's transaction rolls back.

The cap is one named constant on the server and one in the web, pinned
equal by a parity test (the builder picks the mechanism; the shared
fixtures under `shared/fixtures/` are the precedent).

## Cost of rejecting, accepted

A rejected batch from the web's offline queue is poisoned, the replica
rebases over a fresh snapshot, and every op in that batch is dropped
(`sync-recovery.md § A batch the server rejects`). The web refuses a
too-deep op wherever it can see the depth (below), so this happens only
when two devices' edits, each legal alone, stack past 100 levels (one
indents a subtree while the other, offline, adds levels under it), or when
the web sends without knowing a block's ancestors. Both need an outline
near 100 levels; with outlines at 15 this is accepted as effectively never
happening.

## Web

The web refuses an op it can see would go past the cap:

- The check sits at one point every outline edit passes through before its
  ops are applied locally and queued, so no command bypasses it (Tab, drag
  and drop, paste, move up/down, undo/redo, the assistant's local paths if
  any). The builder finds that point; listing commands is not enough.
- **Unknown depth sends** (my call). Where the web cannot see a block's
  whole ancestor chain (the replica still bootstrapping, the in-memory lane,
  a zoomed view whose ancestors are not loaded), it sends the op and the
  server decides. Refusing would block editing on a cold start, and a
  rejection needs an outline near 100 levels. Where the chain is known
  (the replica's rows, or the zoomed view's ancestors), it refuses.
- **Every depth refusal says so** (my call), with one notice in
  `EditablePage`'s top notice slot, where the other paste and link notices
  sit (Arthur: no silent drops; new notices reuse the existing slot). That
  covers Tab, drop, paste, move up/down across a parent and undo/redo.
  The drop indicator also does not offer a too-deep position.
- **A command is all or nothing** (my call): a multi-block indent, move or
  paste where any block would go too deep applies none of it.
- **A refused undo or redo leaves the history as it was** (my call), so it
  can be retried once the user has made room (another device may have
  indented the ancestors since the entry was recorded).

## CLI, MCP, assistant

No change of their own: they post to `/api/ops` and show the 400's message.
The CLI's `batch` already prints a refused batch's error; the assistant
sees the tool error.

## Importer

The Roam importer writes blocks directly, not through ops. It refuses an
export holding a block deeper than 100, before writing anything, naming the
page and the depth (my call: the import is one-shot and fixable in Roam,
and refusing matches the ops rule). Its `sys.setrecursionlimit(20000)`
stays: the tree assembly still recurses to the parsed depth before the
check can run, unless the builder moves the check ahead of it.

## Non-goals

- Making the read routes survive depth past 255. With ops capped and the
  importer refusing, only a direct database write can build one.
- Existing rows past the cap: prod has none. The rule judges only where an
  op puts blocks, so legacy rows deeper than 100 stay readable and
  editable; moving such a subtree fails if it still lands past 100.
- Property-test changes: the generators reach depth 3–5, so no property
  draws the cap, and modelling a rejection is not wanted. If a property
  for depth seems worth having, it is a follow-up bean.

## Tests

- Red tests first, from the probes `sec-pages/p3_deep_tree.py`,
  `p3b_threshold.py`, `p3c_threshold.py`, `p3d_journal.py`: a create chain
  and a move reaching depth 101 are refused with 400; depth 100 is
  accepted, and the page, block and journal routes read it with 200.
- A batch whose earlier ops build the chain that a later op overflows is
  refused whole, and nothing in it applied.
- A move of a 60-level subtree under a block at depth 41 is refused; at
  depth 40 it is accepted.
- `test_hostile_requests.py` gains the deep-chain case as a refusal.
- Server: a diverged delete of a 100-level subtree and a conflict note
  under a header at depth 100 both still apply (the landing exemption).
- Web: vitest at the choke point (create, indent, move, paste, undo each
  refused at the cap, accepted one level shallower; a multi-block indent
  with one too-deep block applies nothing; a refused undo leaves the
  history unchanged; unknown ancestry sends), and an e2e that Tab at the
  cap leaves the block where it was, sends no op and shows the notice.
- Importer: an export with a 101-deep block is refused and writes nothing.
- Gates: server pytest, pyrefly, ruff; `pnpm verify`; `proptest/check.sh`
  (ops path); `perf/check.sh` both sides, since the create and move paths
  gain a depth read.

## Docs

- `backend.md` § The write path: the depth rule beside the title syntax
  refusal ("Other planning errors stay 400s"), with the reason it rejects
  rather than skips.
- `sync-and-offline.md` or `sync-recovery.md`: the stacked-depth case as a
  known way a batch is rejected.
- `docs/troubleshooting.md`: one row (symptom: page/journal 500 on a deep
  outline; cause; owning section; pkm-2kwd).
- `docs/keyboard.md` needs nothing: it lists shortcuts.

## Left to the builder

- Where the server reads depth: the parent's chain (`_parent_chain`
  already serves moves) and the moved subtree's height
  (`_subtree_deepest_first` already tracks depth in its CTE).
- The web choke point and how the cap constant is shared.
- The notice wording.
