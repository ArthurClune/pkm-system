---
# pkm-2771
title: Disentangle CLI batch planning and remove obsolete client and package boundaries
status: completed
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-18T00:00:00Z
parent: pkm-wvvu
---

## Review findings

Backend B1, B2, B3, the `cli/build.py` file-size finding, and the duplicated `_walk` helper.

`PkmClient.create_page` is production-dead and encourages non-atomic writes. `_Planner.creates()` mixes outline planning with batch-only alias/index bookkeeping. Shared planners and renderers live under `pkm.cli` despite use by client workflows and MCP.

## Acceptance criteria

- [x] Delete `PkmClient.create_page` and migrate test setup to atomic operation paths
- [x] Move batch-only uid/index/alias handling out of `_Planner.creates()` and introduce a small batch context only if it clarifies the threaded state
- [x] Split batch schema/dispatch from the outline planner when doing so gives each module one clear job
- [x] Relocate shared planning/rendering code to a transport-neutral package and update CLI, client workflow, and MCP imports
- [x] Remove package-placement apology comments and deduplicate the tiny BlockNode walker
- [x] Preserve CLI/MCP behavior, atomicity, help/contracts, and existing regression coverage
- [x] Update backend architecture and import-direction tests

## Summary of Changes

**B1.** `PkmClient.create_page` deleted. Its only callers were two test
setups; every production write mints a missing page with a `create_page` op
inside the same atomic `OpBatch`. Both tests now post that op instead, one of
them folding it into the batch it already sent. `get_page_blocks`'s docstring
records that the client exposes no page-creation method at all.

**B2.** `Planner.creates()` (was `_Planner.creates`) went from eight
parameters and five jobs to an outline walk over an already-resolved parent
uid:

- parent-spec resolution -- aliases, in-batch uids, creating or reusing a
  missing `## Heading` -- moved up into `_BatchCtx.resolve_parent`;
- the `index` splice became `Planner.create_at`, which the batch
  `create`/`todo` commands are the only callers of. It still skips the append
  counter, which is what lets an indexed create and a plain append under one
  parent interleave;
- the heading memo is now behind `Planner.heading` (miss -> plan it, hit ->
  reuse it) and `Planner._one` (register a heading created from item text);
- `bump`'s `in_batch: frozenset` became a `parent_off_page: bool` -- the set
  only ever answered one yes/no question about the parent.

`_BatchCtx` replaces the `planner`/`pages`/`aliases`/`created` quartet every
`_batch_*` helper threaded, and absorbs `_fetch_blocks`. New test: a move whose
parent was created earlier in the same batch -- the one off-page branch the
suite never exercised, now the reason `batch.py` is at 100%.

**B3 + file size.** `cli/build.py` split and moved:

- `pkm/planning.py` (Core, 359 L) -- the planners: `parse_outline`,
  `next_child_idx`, `resolve_parent`, `parse_uid_spec`, `split_heading`,
  `Planner`, `plan_save`, `plan_update`, `plan_mark`, `asset_block_text`,
  `create_page_ops`, `BuildError`.
- `pkm/batch.py` (Core, 385 L) -- the `pkm batch` command language: the
  discriminated command schema, `validate_batch`, `referenced_pages`, alias
  helpers, `_BatchCtx`, the per-command planners, `plan_batch`.
- `pkm/render.py` (Core) -- moved from `cli/render.py` unchanged apart from
  the walker and its docstring.

Imports updated in `cli/main.py`, `mcp/server.py`, `client/workflows.py`, and
the `pkm.cli.build` mention in `client/api.py`'s `post_ops` docstring. The
package-placement apology in `client/workflows.py` is gone; the docstrings now
state the arrangement as a fact. Tests renamed with their modules:
`test_cli_build.py` -> `test_planning.py`, `test_cli_render.py` ->
`test_render.py`.

**Walker dedup.** The `_walk` BlockNode generator, duplicated verbatim in
build.py and render.py, is now `contracts/responses.walk_blocks`, next to the
`BlockNode` it walks.

**Import-direction tests.** `_imports_of` accepts a single module file as well
as a package, so the three new top-level modules are covered. New
`test_shared_planners_never_import_a_shell` bars `pkm.planning`/`pkm.batch`/
`pkm.render` from importing `pkm.cli`/`pkm.mcp`/`pkm.client` -- the inversion
B3 fixed. `test_contracts_depend_on_neither_side` now also bars the three from
`contracts`, keeping it a leaf.

**Docs.** `backend.md`: three new module-map rows, the `cli/` row corrected to
`main.py` only, and a dependency-direction paragraph explaining why the
planners sit at the top level ("Two tests" -> "Three tests").
`cli-and-mcp.md`: the "Pure planners" section rewritten around the new
split, including `Planner.create_at`'s counter rule and the in-batch-uid
mechanism, plus `Planner._one` and `planning.create_page_ops` name fixes.

**Verification:** `uv run pytest -q` -- 1505 passed, coverage 97.13% (>=95%
enforced; `batch.py` 100%, `render.py` 100%, `planning.py` 93% -- its six
uncovered lines are the two defensive `BuildError` raises, one stack branch and
`asset_block_text`'s pdf/link arms, all uncovered before this bean too).
`uv run pyrefly check` -- 0 errors. `uv run ruff check` -- all checks passed.
CLI surface unchanged: `tests/test_cli_help.py` passes and both
`pkm --help` and `pkm batch --help` were run against the moved imports.
