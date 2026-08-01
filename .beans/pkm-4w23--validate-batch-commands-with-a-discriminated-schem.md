---
# pkm-4w23
title: Validate batch commands with a discriminated schema before planning or I/O
status: completed
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:53:32Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 21).

## Context

**References:** `server/src/pkm/cli/build.py:296-320,341-414`; `server/src/pkm/cli/main.py:420-432,561-572`; `server/src/pkm/mcp/server.py:134-149`

The only contract is list[dict]; malformed items and nested values can escape as AttributeError/KeyError. plan_batch() is also an oversized dispatcher combining validation, alias state, and planning.

**Direction:** Add command-specific discriminated models in the functional core, validate the full envelope before page discovery, and dispatch to small per-command planners with one stable user-facing error contract.

## Tasks

- [x] Test non-object items/params, missing/wrong fields, indexes, and aliases in CLI and MCP
- [x] Split validation from command planning

## Summary of Changes

Added a discriminated-union command schema to `cli/build.py` (Functional Core): `CreateCommand`/`TodoCommand`/`OutlineCommand`/`UpdateCommand`/`MoveCommand`/`DeleteCommand`, keyed on the pydantic `command`-field discriminator, each carrying a strict (`extra="forbid"`) params model (`CreateParams`, `OutlineParams`, `UpdateParams`, `MoveParams`, `DeleteParams`). `OutlineParams.items` uses a PEP-695 recursive `NestedItem` type alias (`str | list[NestedItem]`) so nested outline shape is validated structurally instead of at runtime inside the planner.

`_parse_command(raw, index)` parses one raw item against the schema and turns any `pydantic.ValidationError` into one `BuildError` naming the item's index and the specific problem (`_format_command_error`): non-object item, missing/unknown `command`, or a `path: msg` field-level error for anything else. `validate_batch(commands)` is the new preflight entry point -- it validates the FULL envelope (raises on the first bad item) and both `cli/main.py`'s `cmd_batch` and `mcp/server.py`'s `batch()` now call it immediately after decoding the JSON body, before `referenced_pages`/`get_page_or_placeholder` ever runs, so a malformed batch never triggers a page fetch or page/asset creation.

`plan_batch` itself now parses every item through the same `_parse_command` as its first step (so calling it directly, as the existing unit tests do, still raises the identical `BuildError` for a malformed item), then dispatches each parsed command to a small per-command planner (`_batch_create`, `_batch_outline`, `_batch_update`, `_batch_move`, `_batch_delete`) instead of one large inline if/elif chain mixing alias state, page lookup, and business validation. Runtime/stateful checks that can't be expressed in the schema -- unknown `{{alias}}`, `page not fetched`, `move target heading does not exist` -- stay in the planners and raise the exact same `BuildError` messages as before, so every pre-existing `plan_batch`/CLI/MCP batch test passes unmodified.

Also removed two now-redundant runtime checks that the schema subsumes: `_page()`'s "command needs a 'page' param" (page is now a required, non-empty schema field) and the outline branch's "outline needs non-empty 'items'" (now `Field(min_length=1)` on `OutlineParams.items`); `_nested_items` dropped its own type-checking raise since the recursive schema now guarantees every leaf is a string and every branch a list before it ever runs.

New tests (build/CLI/MCP layers): non-object batch items, non-object `params`, missing/wrong-typed fields, negative `index`, unparseable `index`, malformed nested outline items, empty `items`, unknown param keys (typos), the offending index being reported for a multi-item batch, `validate_batch` returning parsed commands for a valid batch, `plan_batch` itself rejecting non-object items/missing fields/negative index when called directly, and end-to-end CLI/MCP tests for non-object items, missing/wrong-typed fields, negative index, unknown alias, and a schema failure in a later command leaving an earlier command's brand-new page uncreated (proving validation runs before any I/O).

**Verification:** `cd server && uv run pytest -q` -- 1076 passed, coverage 96.44% (>=95% required). `uv run pyrefly check` -- 0 errors. `uv run ruff check` -- all checks passed.

**Files changed:** `server/src/pkm/cli/build.py`, `server/src/pkm/cli/main.py`, `server/src/pkm/mcp/server.py`, `server/tests/test_cli_build.py`, `server/tests/test_cli_main_write.py`, `server/tests/test_mcp_server.py`.
