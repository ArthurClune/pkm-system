# Backend implementation review

**Date:** 2026-08-17
**Reviewer:** pi (Zed)
**Scope:** Backend code quality only (`server/src/pkm/`): over-complexity and
over-abstraction, duplicated code and missing abstractions, file and function
complexity. `docs/architecture/` was used for orientation; the findings are
about the code. The frontend counterpart is
[2026-08-17-implementation-review-frontend.md](2026-08-17-implementation-review-frontend.md).
**Status:** Review complete; no code fixes were made as part of this review.

## Executive assessment

The backend is 12.5k lines of non-test Python in 515 functions, and well
disciplined for its size:

- Average function length is ~24 lines; 3 functions exceed 100 lines
  (`importer/run.py::main`, `importer/parse_export.py::parse_export`,
  `cli/main.py::build_parser`) and 16 exceed 60.
- An AST-normalized clone scan (function bodies compared with names erased)
  found **zero** structural copy-paste functions ≥8 lines.
- Every function whose body is one call is a naming wrapper, a compat shim, or
  CLI-arg glue. None is a purposeless forwarding layer.
- Dead production code: one method (B1).

The functional-core/imperative-shell split is real: pure planners (`ops_core`,
`title_migration`, `query`, `refs`, `rename`) sit between thin I/O shells, and
most invariant comments cite the shipped bug they guard against.

Most findings are extraction-sized cleanups. The highest-value items are two
shared invariants implemented as a repeated ritual in more than one file (A1,
A2) and one correctness-adjacent cleanup flag in the assistant SSE path.

## A. Missing abstractions (duplication)

### A1. Asset-verify ritual hand-rolled twice — HIGH

`importer/run.py:142-152` and `export/writer.py:176-186` both repeat the same
stat → hash-only-if-size-matches → `asset_needs_repair` sequence around
`assets_core.asset_needs_repair()`:

```python
if dest.is_file():
    expected_size = ...
    actual_size = dest.stat().st_size
    actual_sha = (sha256_hex(dest.read_bytes())
                  if actual_size == expected_size else None)
    if not asset_needs_repair(sha, expected_size, actual_size, actual_sha):
        continue / (hardlink and continue)
```

The architecture docs describe this "trust nothing already on disk" check as
an invariant shared by import and export. With no shared code, a drift (one
side skipping the size short-circuit, or hashing before statting) would fail
no shared test.

**Fix:** add `asset_on_disk_needs_repair(path, sha256, expected_size) -> bool`
to `assets_core`, where the ritual is already documented; both call sites
become one line.

### A2. Refs re-derivation ritual lives in two places — MEDIUM

"refs and block_refs are always rebuilt from block text" is implemented as the
same four steps in two places:

- `server/ops_apply.py`, `_execute`'s `ReindexRefs` branch:
  DELETE refs → `extract()` → `index_ref` loop → `reindex_block_refs`
- `server/store.py::rewrite_snapshotted_blocks`: the same four steps inline.

`store.index_ref` and `store.reindex_block_refs` exist, but their composition,
which must stay in lockstep with the schema and the extractor, is written out
twice.

**Fix:** a named `store.reindex_refs_for_text(db, uid, text, now_ms)` that
both call.

### A3. Query-execution SQL duplicated across routes — MEDIUM

`routes_search.run_query` and `routes_export._run_query` carry near-identical
`SELECT count(*) FROM ({sql}) m JOIN blocks ... WHERE {QUERY_SOURCE_FILTER}`
plus group-rows-by-page logic. Each has a comment explaining it keeps its own
copy because one routes module importing another's internals would be the
wrong coupling. That diagnosis is right, but `query.py` is already the Core
module both import and the natural home for "execute a plan → grouped
results." Both call sites would shrink to a call.

### A4. Group-rows-by-page loop ×3 — LOW

The same ~8-line group/index/append loop appears in `routes_search.run_query`,
`routes_search.todos`, and `routes_pages.get_unlinked`.
`server/backlinks.group_backlinks` is the precedent; a `group_by_page(rows)`
beside it would complete the set.

### A5. `importer/titles.py` bridges modules through private APIs — MEDIUM

`titles.py:10-15` imports the private names `_ATTRIBUTE`, `_scan_brackets`,
`_strip_code` from `refs.py`, and `_rewrite_import_title_refs` re-implements
attribute-prefix handling that overlaps `rename.py`. That includes a
`text[attribute_start:]` slice that exists only to work around rename's
whitespace-anchored `_ATTRIBUTE.match`. `rename.py` also imports refs
privates, so the seam predates titles.py; titles.py widens it.

**Fix:** handle the raw-vs-normalized title-span mismatch where it originates,
either with public span exposure in `refs.py` or with `rename` accepting a
normalizer, instead of patching around it in a third module.

### Minor duplication

- `_walk` (3-line `BlockNode` tree generator) duplicated verbatim:
  `cli/build.py:50`, `cli/render.py:32`.
- Describe enqueue-guard triplet (eligibility check + `_active` guard + add +
  `put_nowait`) copy-pasted between `maybe_enqueue` and `scan`
  (`describe/service.py:104-128`).
- Identical decline-all-pending loops in `claude_engine.py:190` and `:234`.
- `_BLOCK_COLS` SQL literal duplicated (`routes_pages.py`, `routes_export.py`).
  It is commented as an intentional non-shared constant; borderline
  acceptable.

## B. Over-complexity / over-abstraction

Rare: no needless layering, no speculative generality, no abstraction with a
single accidental implementation. The full list:

### B1. `PkmClient.create_page` is dead in production — MEDIUM

`client/api.py:272`. The only callers are two tests
(`test_cli_main_read.py:154, 506`). Every real write path creates pages via
`create_page_ops` inside the atomic `OpBatch`, an invariant the docs give a
section to. This method is the separate-request pattern the design removed,
left in the client for the next caller to trip on.

**Fix:** delete it and have tests use `save_blocks`/`post_ops` for setup, or
mark it test-fixture-only.

### B2. Batch-only concerns leak into `_Planner.creates()` — MEDIUM

`cli/build.py:162`: 8 parameters, 69 lines, ≥5 jobs (alias/in-batch
resolution, heading memoization, missing-heading creation, outline
depth-stack walking, index splicing). `in_batch`/`index` exist only for
`_batch_create`; `plan_save` passes defaults it never uses.

**Fix:** move the `in_batch`-uid and `index` handling up into `_batch_create`
(which already handles `as_`), leaving `creates()` a pure outline planner over
a resolved parent uid. A small `_BatchCtx` (planner, aliases, created) would
also stop `_batch_create/_batch_outline/_batch_move` threading the same 3-4
arguments.

### B3. Package placement inversion — LOW but structural

`client/workflows.py` and `mcp/server.py` import planners from
`pkm.cli.build` / `pkm.cli.render`, and two docstrings apologize for it
("despite the package name they have always been shared"). The FCIS split is
right and the location is wrong: non-CLI modules importing `cli.*` inverts the
dependency the name asserts.

**Fix:** mechanical move to e.g. `pkm/planning.py` + `pkm/render.py` (or a
`pkm/shared/` package); delete the apologies.

### B4. Marginal

- `assets_core.classify_export_asset_transfer`: a one-line bool→string with a
  single production caller (`writer.py:205`) that interpolates the result into
  a counter key. Inline it; two explicit counter bumps document themselves.
- `assistant/policy.all_tool_names()` has no production caller but is the
  subject of the 11-count tripwire test. Add one line saying so, or the next
  reader deletes it as dead code.

## C. File and function complexity

| Location | Size | Assessment |
|---|---|---|
| `importer/run.py::main` | 157 L, ~7 jobs | **Needs splitting.** Extract the asset-copy loop. The two identical connect/try/finally/close blocks (lines 116-128, 159-168) can merge: the asset copy between them never touches the DB, so audit/apply can share a connection. |
| `importer/parse_export.py::parse_export` | 133 L | Cohesive two-pass tree build; the long orphan/cycle-recovery comments are justified. OK. |
| `cli/main.py::build_parser` | 107 L | Declarative argparse, one block per command; `_add`/`_common` already extract the repeated shape. OK. |
| `importer/titles.py::sanitize_export_titles` | 100 L | Extract `_merge_sanitized_pages` (≈ lines 200-243); the collision-group/survivor-pick/reorder block stands on its own. |
| `export/writer.py::export_graph` | 96 L | Extract the ~35-line asset staging loop (`_stage_assets`); the function then reads as its docstring says. |
| `server/app.py::create_app` | 96 L | Linear wiring. OK. |
| `server/ops_core.py::plan_op` | 92 L, 23 branches | Flat per-op dispatch with small branches. A good example of a long function that stays simple. OK. |
| `server/title_migration.py` `_inventory…`/`apply…` | 92/85 L | Linear, transactional, careful. OK. |
| `assistant/claude_engine.py::send` | 63 L | Extract `_abandon_turn()`. The decline-pendings → bounded-interrupt → `healthy = False` protocol should have a name as well as a comment. |
| `assistant/claude_engine.py::create_conversation` | 57 L | Extract `_resolve_model_env()` (requested, env, sdk-model); the z.ai branch is pure routing logic in the middle of the function. |
| `cli/build.py` (file) | 637 L | Two modules in one file: planners (~1-330) and batch schema+dispatch (~380-631). Splitting out the schema drops ~250 lines. The remaining size is justified: the dense comments each cite a shipped bug or live invariant. |

### Correctness-adjacent flag: SSE generator teardown

`assistant/routes.py::_with_keepalive` (lines 38-63) cancels the pending
`anext` on disconnect but never calls `await stream.aclose()` on the
underlying generator, and `sse()` just stops iterating. The cleanup in
`ClaudeConversation.send`'s `finally` (`claude_engine.py:183-216`: decline
parked confirms, bounded interrupt, `healthy = False`) therefore runs when
CPython's asyncgen finalizer hook collects the orphaned generators. That is
usually prompt, but its ordering is nondeterministic and not guaranteed under
other GC behavior. Per its own pkm-mbcc comment, the whole
`claude_engine.py:183-196` block exists for this path.

**Fix:** in `_with_keepalive`'s `finally`, `await stream.aclose()`
(permitted during GeneratorExit; bounded by `INTERRUPT_TIMEOUT_S`), and add a
test that disconnect runs the decline/interrupt cleanup.

### Comment-density imbalance

Comments generally sit where invariants are (`ws.py`'s concurrency reasoning
is a good example). Two outliers, in opposite directions:

- `describe/service.py:66-101`: the shutdown machinery (`close()`'s
  shield/while-loop, `_shutdown`'s `current_task().cancelling()` probe) is the
  most intricate concurrency code in that subsystem and has no explanatory
  comments.
- `assistant/service.py:37-152`: the 80s-worst-case-lock story is told three
  times (`CREATE_TIMEOUT_S` comment, `_admission_lock` comment, `create()`'s
  `finally` comment), ~45 lines of prose on ~25 lines of code, free to drift
  apart.

**Fix:** document `describe`'s shutdown semantics (idempotent close; caller
cancellation must not abort worker teardown); keep one account of the
assistant lock story and cross-reference it from the other two places.

## What's good

- **The write path** (`ops_core` effect-tuples → `ops_apply` → trigger
  journal) is the cleanest FCIS execution in the repo; `plan_op`'s dispatch
  shows how a 92-line function stays simple.
- **`client/api.py::_request`** is a single choke point, and validating every
  response against the shared Pydantic contracts makes server/CLI/MCP drift
  fail loudly.
- **No ORM; inline SQL at point of use.** The repeated-SQL scan found only
  trivial single-statement overlaps across different write paths, and
  intentional duplications carry justifying comments (`_BLOCK_COLS`, the MIME
  SQL twin in `assets_core`).
- **Test discipline:** ~70 test files, roughly one per module, 95% branch
  coverage enforced; the generated-artifact staleness guards and the
  contract-direction import tests are the right kind of tripwire.

## Suggested order of attack

1. **A1 + A2**: invariant-drift risk; each is a one-new-function fix.
2. **SSE teardown flag**: small fix that pins a nondeterministic cleanup path.
3. **C-tier extractions**: `run.py::main`, `export_graph`, `creates()`,
   `send()`/`create_conversation()`, `sanitize_export_titles`.
4. **B1 + A5**: delete the dead client method; give titles.py a public API.
5. **B3**: the `pkm.cli` → `pkm.planning` move, when convenient.
