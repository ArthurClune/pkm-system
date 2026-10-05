# Property checks: client/server op divergence (pkm-j3ui, with pkm-sj5l)

Design agreed with Arthur 2026-10-05, section by section. Bean pkm-j3ui,
sub-project 4 of the property-checks epic pkm-nws9; pkm-sj5l is folded in.
Line numbers are as of `066e9de8` on `main`.

## Problem

Op semantics have four implementations, kept in step today only by
hand-written parity fixtures
([backend.md § Generated artifacts and parity fixtures](../../architecture/backend.md#generated-artifacts-and-parity-fixtures)):

| Side | Code | Fed by |
|---|---|---|
| server | `ops_core.plan_op` + `ops_apply._execute` | `POST /api/ops` |
| CLI | `planning.Planner` | `pkm batch` (the server suite checks it) |
| replica | `replica/localOps.ts applyLocalOps`, through `queue.ts enqueueBatch` | every local edit (optimistic), and `apply.ts reapplyPending` on every feed window |
| in-memory | `outline/tree.ts applyOpInPlace` | the editor's own commands, and remote websocket echoes (`outlineSessions.ts applyRemote`) |

The server suite checks the server against a model, and pkm-f7zv checks
outline commands against a reading-view model with no server. Nothing checks
that the client sides store what the server stores. Three facts make that a
real gap:

- **The echo is not the batch.** The server broadcasts only the ops it
  applied, with page titles resolved to the stored page
  (`ops_apply._broadcast_op`, `ops_apply.py:486`). An open page applies that
  echo straight to its tree. So the in-memory tree sees cross-page moves,
  creates under a parent on another page, and ops aimed at other pages, which
  the editor's own commands never produce. `applyOpInPlace` has no cycle
  guard, and its create filter goes by `page_title`.
- **The replica's apply is the server's minus conflicts**, by design
  (`localOps.ts` header). Every other difference is a bug that lasts until
  the next pull, or for hours offline.
- **pkm-sj5l.** A pending batch with two moves of one block drifts its
  siblings' `order_idx` by +2 on every feed window that lacks it, because
  `keepSlot`'s per-op check fails for the first move once the second has
  placed the block. It is not known to be reachable from the editor. j3ui's
  job is to surface any reachable form of it, or of the wider "a later op
  disturbs an earlier op's slot" shape, and fix what it finds.

## Decisions

| Question | Ruling |
|---|---|
| Which streams | All four: echo → in-memory tree; commands → server; batch → replica; replay of a pending batch over a real feed window |
| Approach | A TypeScript differential suite against the harness server, not a Python-generated fixture corpus (no shrinking across languages, no command stream) and not a single-client sync harness mode (slow, never reaches the in-memory tree) |
| Budget | About 60 s of `proptest/check.sh web`; the web side grows to about 5 minutes |
| jarz scenarios as fixtures | No: they are multi-client sync stories and already run as fixed scenarios in `sync.prop.ts` |
| Replay property | Inside the server-backed example, over real windows, not in-process over invented ones |

## The property

One property, `web/src/props/ops/ops.prop.ts`, against the harness server on
port 8978, run by `proptest/check.sh web` in the same fork as the sync and
outline suites.

### Start state

Seeded through the real `POST /api/ops` after `/__proptest/reset`, so the
server's refs and journal are its own: `create_page` for each page, then
creates in ascending key order (each lands at its drawn key with no shift),
then `set_collapsed` where drawn. Then `GET /api/sync/snapshot` gives S0.

- **Pages:** `Outline Props` (the page commands run on: f7zv's runner
  hard-codes `PAGE_TITLE`), `Ops Two` and `Ops Three`. The reset's own
  `Proptest` and `Second` pages stay, untouched, and are compared like any
  other page.
- **Title pool:** those three plus `Ops Four`, which never exists at the
  start, so a create or move can name a page the batch makes.
- **Blocks:** 0 to 10 per page, nested to depth 3, gapped keys drawn as
  f7zv's `treeArb` draws them. Uids from a fixed pool of server-valid uids
  (`UID_RE` needs 6 to 32 characters; f7zv's `b0` uids do not qualify, so
  `treeArb` is not reused as is). Text, heading, view type and collapsed as
  f7zv draws them, plus `[[Title]]` refs into the title pool and `((uid))`
  block refs.

### Steps

An example is a short sequence of steps, so state evolves as it does on a
device.

| Kind | Share | Steps | Between steps |
|---|---|---|---|
| raw | about 60% | 1 to 3 raw batches | the in-memory trees advance by echoes only; the replica by optimistic applies and real windows only |
| command | about 40% | 1 to 5 f7zv commands (undo and redo included), each step's ops one batch | the editor's tree advances by its own commands only |

**Raw batch:** 1 to 6 ops.

| Op | Variations |
|---|---|
| `create` | parent none, live, missing, or on another page; any pool title; a fresh uid, or rarely an existing one (a 400) |
| `move` | same parent; another parent; another page's top level or a parent there; a cycle (under itself or a descendant); a missing parent. `order_idx` 0, in range, in a gap, past the end |
| `update_text` | hashless, matching, or stale hash; now and then a deleted target |
| `delete` | hashless, matching, or stale subtree hash |
| `set_collapsed`, `set_heading`, `set_view_type`, `create_page` | |

About one batch in four names one block twice (two moves, or a create then a
move): pkm-sj5l's shape. About one batch in thirty carries a forbidden title.

**What the server receives** is what the app would send. A raw batch goes
through the replica's real `enqueueBatch`, and the POST body carries the ops
it stored in `pending_ops` (hashes filled as the app fills them). A command
batch is stamped with `stampBaseTextHashes` against the pre-command tree, as
`useOutline` stamps it (`useOutline.ts:190`), then enqueued the same way.

### One raw step

1. The replica enqueues raw batch B (`enqueueBatch`: the optimistic apply).
2. In about half of raw steps, **another device** POSTs its own raw batch O,
   drawn against the server's current state. O may touch B's rows or only
   another page. The in-memory trees apply O's echo.
3. If O ran, the replica pulls the changes window from its cursor and applies
   it with the real `applyChanges`, so `reapplyPending` replays B. Check R.
4. B is POSTed. Its echo is read from `/__proptest/echo`, the snapshot S1
   from `/api/sync/snapshot`. Checks 1 and 3, and rejection agreement.

### One command step

The f7zv runner (`props/outline/run.ts runSequence`) runs the command on the
editor's tree; the step's ops are stamped, enqueued and POSTed. A command
that emits no ops (f7zv's `silent` check already holds it to that) posts
nothing, and the step only checks that the trees are unchanged. Checks 2, 1
(on the other pages) and 3. A command step never gets an O: remote batches
reach an editor as echoes, which raw steps cover.

## The checks

### Forms

- **Tree form** (checks 1 and 2): per page, nested nodes of uid, text,
  heading, view type, collapsed and **exact** `order_idx`, children in key
  order; no timestamps. `ops/compare.ts` builds it from a snapshot by grouping
  rows by page and parent. Keys are compared exactly because the editor
  computes its next ops from them.
- **Graph form** (checks 3 and R): `props/sync/normalise.ts`, as the sync
  oracle uses it: pages and refs by title, so local negative page ids compare
  cleanly; no timestamps.

### Check 1: echo → in-memory tree

For every pool page, `applyOpsWithChange(T_p, echo, p).blocks` equals
`tree_p(after)`, where `T_p` is that page's in-memory tree as it stands: built
from S0, then advanced only by the echoes of earlier batches (O's included). For a command step, the command's page is check 2's,
so check 1 covers the other pages only.

A page is set aside, and tallied, when the real `applyRemote` would ask for
an authoritative reload instead: a move brings onto the page a block its
tree does not hold (`outlineSessions.ts:636-639`). The property calls the
real rule, so that predicate moves out of `applyRemote` into `tree.ts` as an
exported pure function, with no change in behaviour.

### Check 2: commands → server

The command's resulting tree equals `tree_Outline Props(after)`. A command
batch the server rejects, or one whose ack skips an op, is a failure on its
own: starting from the server's own state, the editor should send neither.

### Check 3: batch → replica

The replica after the optimistic apply (and any replay) equals S1 in graph
form.

### Check R: replay is a first apply

After step 3's window, the replica equals a fresh replica built from the
snapshot after O with the same pending batches enqueued on it:

- compared on structure (sibling order, fields, pages, refs) in general;
- compared on **exact `order_idx`** when the window re-shipped none of the
  rows the pending batches touched, as the effect ledger names them. That is
  where the sj5l drift lives.

Only windows at the journal head, at the server's default window size, are
used. Below the head, block tombstones are deferred and collateral waits for
settle; those are accepted transient exposures (pkm-d3qh, pkm-dbr1,
pkm-jarz) that the sync suite already covers.

### Rejection agreement

A batch with a forbidden title is a server 400 and an `enqueueBatch`
`LocalOpError`, together or not at all. Another 400 (a create of a live uid)
is enqueued optimistically and repaired by the poison path, which the sync
suite's `BadBatch` covers; it is tallied, and checks 1 and 3 are skipped for
that step. A command batch must never be rejected.

### Exclusions

The complete list. Anything else that differs is a finding.

| Exclusion | Applies to | Why |
|---|---|---|
| Rows the server minted: uids in neither S0 nor the steps' creates (conflict headers, rescued texts, skip notes), with their refs and the pages that exist only for them (the daily page, `conflict`) | 1, 3, R | Never echoed; the replica does not mirror conflict handling; the feed delivers them (`ops_apply.AppliedBatch` docstring, `localOps.ts` header). The edited block's own text agrees: on a conflict the incoming edit still wins (backend.md § Conflicts) |
| A page whose echo needs an authoritative reload | 1 | The real session reloads it rather than applying the echo |
| Timestamps | all | Client clock against the frozen server clock, as in the sync oracle |

## Harness server

`server/tooling/proptest/sync_server.py` only, never `pkm.server.app`:

- `GET /__proptest/echo` returns the `ops` of the last broadcast frame that
  carried them, recorded by wrapping `app.state.hub.broadcast`. Reset clears
  it. A replayed batch broadcasts nothing, so a step reads the echo only
  after a fresh commit.
- A teeth-only mode, armed by a control call and cleared by reset, that
  drops the `page_title` of cross-page moves from the recorded echo.

## Failure report and tally

The report follows the other suites: `ops property failed after N runs`,
seed, path, the shrunk counterexample, and a `replay:` line with
`--file ops/ops.prop.ts`. The counterexample prints the start state as
indented trees per page and each step: the batch or command, O if any, and
the ack's `applied` and `skipped`. The error names every check that failed at
the first failing step, with its diff in tree or graph form.

The `afterAll` tally: raw and command examples; op kinds and each variation
reached (cycle, missing parent, cross-page, stale hash, a block named twice);
O steps that did and did not touch B's rows; skipped ops by reason; pages set
aside for an authoritative reload; rejections by cause.

## Teeth

`ops/teeth.prop.ts` swaps in wrong implementations through a seam object, as
f7zv's `REAL` seam does, never by patching modules. Each must be caught by
the check it breaks:

| Mutant | Caught by |
|---|---|
| `applyOpInPlace` without `shiftFrom`'s exemption for the moved block | 1 |
| `applyLocalOps` placing a move one slot late | 3 |
| a replay that always shifts (no `keepSlot` clash check) | R |
| the echo without a cross-page move's `page_title` (server teeth mode) | 1 |

A crash, or another check failing alone, is not a catch.

## Gate and budget

`NUM_RUNS` is calibrated to about 60 s on a quiet machine; the property's
time limit is 120 s, so an overrun fails as a budget problem, not a finding.
`proptest/check.sh web --file ops/ops.prop.ts` runs it alone. No change to
`proptest/run.py`'s side selection: `web/…` and `server/src/…` already pick
the web side.

## Files

| File | Pattern | Role |
|---|---|---|
| `web/src/props/ops/arbitraries.ts` | Functional Core | start states, raw batches, O batches, command steps |
| `web/src/props/ops/compare.ts` | Functional Core | snapshot to tree form, exclusions, diffs |
| `web/src/props/ops/ops.prop.ts` | Imperative Shell | the property, report and tally |
| `web/src/props/ops/teeth.prop.ts` | Imperative Shell | the mutants |
| `web/src/props/ops/*.test.ts` | test | unit tests under `pnpm test:unit` |
| `web/src/outline/tree.ts` | Functional Core | gains the authoritative-reload predicate |
| `web/src/outline/outlineSessions.ts` | Imperative Shell | `applyRemote` calls it |
| `server/tooling/proptest/sync_server.py` | Imperative Shell | the echo route and teeth mode |

## Findings

The epic's rules hold:

- a product bug is fixed with the shrunk example as a unit test beside the
  code, plus a `docs/troubleshooting.md` row;
- a model or command disagreement, or an unclear one (an echo the tree
  cannot take), goes to Arthur to rule;
- nothing is excluded beyond the table above, and no check is weakened for a
  clean run.

pkm-sj5l is fixed if check R finds it in any form, raw batches included:
Arthur's rule is that findings get fixed. The bean's candidate fix, skipping
a replay when the window re-shipped none of the batch's rows, is where its
design starts.

## Docs

- `docs/architecture/property-checks.md`: the suite row, a "What the ops
  property checks" section, the module table, the echo route, calibration.
- `AGENTS.md`: the web budget sentence (sync about 3 minutes, outline about
  45 seconds, ops about 60 seconds).
- `docs/troubleshooting.md`: one row per finding fixed.
- `docs/architecture/backend.md`'s parity fixture section gets one line
  saying the ops suite checks the server, replica and in-memory
  implementations against each other (the CLI planner stays with the server
  suite).
