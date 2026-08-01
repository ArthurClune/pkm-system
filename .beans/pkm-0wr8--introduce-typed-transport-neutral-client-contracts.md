---
# pkm-0wr8
title: Introduce typed transport-neutral client contracts and remove dependency inversion
status: completed
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T13:04:56Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 20).

## Context

**References:** `server/src/pkm/client/api.py:18,91-148`; `server/src/pkm/cli/build.py:10,38-342`; `server/src/pkm/server/response_models.py:18-264`; imports in `server/src/pkm/cli/main.py:27-28` and `server/src/pkm/mcp/server.py:19`

PkmClient returns bare dictionaries and downstream planners/renderers access nested untyped data, so static checking cannot catch response drift despite exact Pydantic models existing. CLI/MCP depend inward on pkm.server.* and duplicate ensure-page/default-date/fetch-plan-post workflows.

**Direction:** Move transport-neutral operation/response contracts into an independent domain package, return validated models or precise TypedDicts, and extract shared application workflows while keeping presentation shells separate.

## Tasks

- [x] Define dependency direction and transport-neutral contracts
- [x] Add malformed/stale response contract tests
- [x] Replace duplicate CLI/MCP workflows without over-generalising presentation

## Summary of Changes

New `pkm/contracts/` package (Functional Core) holding the shapes both
halves need, imported by server and client alike and importing neither:

- `contracts/ops.py` — the op models `POST /api/ops` accepts, plus
  `UID_RE` and `text_hash` (both sides must agree on how `base_text_hash`
  is computed). `server/ops_core.py` keeps `plan_op` and the effect
  values and now imports its models from here.
- `contracts/responses.py` — the JSON response models, moved wholesale
  from `server/response_models.py` (the routes' `response_model=` imports
  just point at the new path, so `web/src/api/openapi.json` is
  byte-identical and no gen-types run was needed). Adds `OpsAck` and
  `AssetDeleteAck` for the two write acks the CLI reads; they are
  deliberately NOT attached to their routes as `response_model=` (that
  would add components to the published schema for bodies no generated
  client reads), so a test asserts each still matches its live route.
- `contracts/daily.py` — `title_for_date`/`date_for_title`. The journal
  day-window logic stays in `server/daily.py`.

`PkmClient` now returns validated models rather than dicts — full models,
not TypedDicts, because runtime validation is the point: a 2xx body that
doesn't match raises `ResponseSchemaError` (an `ApiError`, so the CLI
still exits 1 with one stderr line) naming the endpoint and field path,
while unknown extra fields stay tolerated so a newer server keeps working
with an older CLI. `get_page_or_placeholder` became `get_page_blocks`,
returning `(blocks, missing)` — blocks are all a planner reads and the
only part of a page a missing one can honestly stand in for.

The planners in `cli/build.py` now take `list[BlockNode]` and emit
contract op models; `cli/render.py` renders models. This is what makes
drift a type error: renaming a response field now fails `pyrefly check`
(verified by deliberately misspelling two fields — 2 errors, reverted),
where the old `payload["page"]["title"]` was unanalyzable.

`client/workflows.py` (new, Shell) holds the four write workflows the CLI
and MCP server had duplicated line-for-line — `save_blocks`,
`edit_block`, `apply_batch`, `upload_and_link` — plus the default-page
rule. Presentation stayed split: they return values, and each shell
phrases them (CLI prints; MCP returns strings). `mcp/server.py` lost 83
lines, `cli/main.py` 116.

Also removed: `referenced_pages` now reads validated commands instead of
re-walking raw JSON, and `render_assets`'s defensive `.get("refs")`
(the field is required by the contract).

Verification: 1093 passed, coverage 96.49% (was 96.44%); `pyrefly check`
0 errors; `ruff check` clean; regenerated openapi.json byte-identical to
the committed one.
