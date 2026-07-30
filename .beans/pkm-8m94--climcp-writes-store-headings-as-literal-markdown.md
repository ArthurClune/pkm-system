---
# pkm-8m94
title: CLI/MCP writes store headings as literal markdown
status: in-progress
type: bug
priority: normal
created_at: 2026-07-30T20:01:33Z
updated_at: 2026-07-30T20:28:43Z
---

Blocks written via the pkm CLI or MCP tools with '## Heading' text are stored verbatim with heading=NULL, so the page shows literal '## Heading' instead of a rendered heading.

Root cause: server/src/pkm/cli/build.py never emits a 'heading' field on content blocks. The only place it does is _Planner.creates (build.py:158-160), for a 'parent: "## Heading"' spec naming a heading that does not yet exist on the page. Every other created block stores its text verbatim.

The ops layer is not at fault: CreateOp.heading (ops_core.py:26) and SetHeadingOp (ops_core.py:61) both exist and validate 1-3.

Compounding it: render.py:39 renders a real heading AS '## text', so 'pkm get --uids' -> edit -> 'pkm save'/'pkm update' is a lossy round trip that silently demotes real headings to literal markdown. The CLI/MCP contracts never mention that headings can be set at all.

Reproduction (pure, no server):

    plan_save({'blocks': []}, 'P', None, '## Overview', False, uids)
    -> [{'op': 'create', 'text': '## Overview'}]   # no heading field

Design: docs/superpowers/specs/2026-07-30-cli-mcp-heading-writes-design.md


## Tasks

- [x] Task 1: `split_heading` + every create path (`_Planner.creates` item loop, `_headings` memo registration)
- [x] Task 2: `plan_update` + the three update paths (batch `update`, `cmd_update`, MCP `update_block`)
- [x] Task 3: contracts and docs (CLI epilogs + `--help` drift guard, MCP docstrings, pkm skill, README, `backend.md`)

Plan: docs/superpowers/plans/2026-07-30-cli-mcp-heading-writes.md



## Summary of Changes

Task 1 (`split_heading` + create paths): `split_heading(text) -> (body, level)` in `server/src/pkm/cli/build.py` strips a leading 1-3 hash marker off a single line, leaving `#Tag`, `#### x`+ deeper, `# ` (no body), and multi-line text untouched. It runs inside `_Planner.creates`'s item loop -- the one call site every create path funnels through (`pkm save`, batch `create`/`todo`/`outline`, `pkm upload`) -- so a heading line becomes a real `heading` field on the create op instead of literal text. A created heading also registers in the `_headings` memo so a later `parent: "## X"` in the same batch reuses it instead of duplicating it.

Task 2 (`plan_update` + update paths): `plan_update(uid, text, base_text=None)` in `build.py` returns an `update_text` op (with a `base_text_hash` guard only when `base_text` is given) followed by an unconditional `set_heading`, so a block's stored heading level always tracks the text's leading hashes on update -- present hashes set the level, absent hashes clear it. It is used by `plan_batch`'s `update` command (no guard), `cmd_update` in `cli/main.py`, and `update_block` in `mcp/server.py`. The `-D`/`-T`/`mark=` task-marker paths deliberately bypass `plan_update` and never touch the heading level, since the text they read back is already bare.

Task 3 (contracts and docs): documented the Task 1/2 behaviour everywhere an LLM or human reads the CLI/MCP contract, since the absence of any mention that headings could be set was why the bug went unnoticed:
- `server/src/pkm/cli/main.py`: extended `_SAVE_EPILOG`, `_UPDATE_EPILOG`, and `_BATCH_EPILOG`'s `create`/`update` entries with the heading-level rules.
- `server/src/pkm/mcp/server.py`: extended the `save_note`, `update_block`, and `batch` docstrings (the LLM-facing contracts) the same way.
- `server/tests/test_cli_help.py`: added a parametrized drift-guard test (`save`/`update`/`batch`) asserting each verb's `--help` mentions "heading" and `###`.
- `.claude/skills/pkm/SKILL.md`, `README.md`: added heading-level notes to the Write verbs / CLI quick-reference sections.
- `docs/architecture/backend.md`: added `plan_update` and `split_heading` to the planner list and a new prose bullet stating the heading-level invariant and its deliberate exclusions (`#Tag`, `#### `+, multi-line, task-marker paths).

Verification: `uv run pytest -q` (939 passed, 95.97% coverage), `uv run pyrefly check` (0 errors), `uv run ruff check` (all checks passed), all from `server/`.
