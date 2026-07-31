---
# pkm-aks7
title: CLI/MCP heading follow-ups from pkm-8m94
status: completed
type: task
created_at: 2026-07-30T21:16:48Z
updated_at: 2026-07-31T00:00:00Z
---

Three non-urgent follow-ups deferred from pkm-8m94's final whole-branch review. None is a correctness bug; each is a rough edge the heading work exposed.

## 1. plan_mark: the last op construction living in a shell

The task-marker paths deliberately bypass `plan_update` (the text they read back from the API is already bare, so splitting it would demote a real heading). That leaves the `with_state` + hand-built `update_text` dict + `base_text_hash` block duplicated verbatim between `cli/main.py`'s `cmd_update` and `mcp/server.py`'s `update_block` -- now the only op shaping outside the Functional Core, since plan_update owns the rest.

A `plan_mark(uid, current_text, mark)` in `cli/build.py` removes both the duplication and the shell logic in about four lines.

## 2. Non-get renderers print text without hashes

`render_groups`, `render_backlinks` and `render_search` (`cli/render.py`) emit `item['text']` bare, unlike `render_page`, which prints a stored heading as `## text`. So a heading copied out of `pkm todos` / `pkm search` into `pkm update` silently demotes to plain text.

The docs only claim the round trip for `pkm get`, so nothing is currently wrong -- but those three renderers are where the claim breaks if we ever want it unconditional.

## 3. Empty heading blocks are the one lossy round trip

`render.py` renders `heading=2, text=""` as `- ## `, and `split_heading` rejects `"## "` because `_HEADING_SPEC`'s `.+` needs a body -- so re-saving that line stores literal `"## "` with no level. SKILL.md says fetch-then-update round trips are lossless, which is true of every real block but not literally universal.

Probably not worth code; listed so the choice is deliberate.

## Tasks

- [x] 1. Extract `plan_mark` into `cli/build.py` and use it from both shells
- [x] 2. Decide whether the three non-`get` renderers should print heading hashes (and update the round-trip claim to match whichever way it goes)
- [x] 3. Decide whether an empty heading block needs handling, or whether SKILL.md's wording should be made exact

Context: pkm-8m94 (merged at bd0dc35, prod deployed 2026-07-30). Design: docs/superpowers/specs/2026-07-30-cli-mcp-heading-writes-design.md

## Summary of Changes

**Task 1 — `plan_mark` extracted.** Added `plan_mark(uid, current_text, mark)` to
`server/src/pkm/cli/build.py` (Functional Core): builds the `update_text` op with
the marker applied via `with_state`, plus the `base_text_hash` guard, and
deliberately emits no `set_heading` (mirrors the reasoning already documented on
`plan_update`: `current_text` is read back from the API already bare, so
splitting it would demote a real heading). TDD: added
`test_plan_mark_applies_marker_and_hash_guard_no_heading_op`,
`test_plan_mark_done_toggles_existing_marker`, and
`test_plan_mark_never_emits_set_heading` to `tests/test_cli_build.py` first,
watched them fail on `ImportError: cannot import name 'plan_mark'`, then
implemented. `cli/main.py`'s `cmd_update` and `mcp/server.py`'s `update_block`
now both call `plan_mark` instead of hand-building the op dict; the now-dead
`with_state`/`text_hash` imports were removed from both shells (still used
inside `cli/build.py`, unaffected).

**Task 2 — decision: leave the three renderers as-is; tighten the docs instead.**
`render_groups`, `render_backlinks`, `render_search` print `item['text']` bare
not because of a renderer oversight but because the response models behind
them (`GroupItem`, `BacklinkItem`, `SearchBlockHit` in
`server/src/pkm/server/response_models.py`) never carry a `heading` field at
all — `backlinks.py:20` and `routes_search.py:85,138` select only
`uid`/`text` (+ `breadcrumbs` for backlinks) off the row. Making the round
trip lossless there is a real API change (new field on three response
models, new query columns in two modules, an openapi.json + generated-types
regen, and updating whatever web code already consumes those types) — not a
small, clearly-safe renderer tweak confined to `cli/render.py`. That is out
of proportion to a deferred CLI-only follow-up, so the renderers are
unchanged. Instead, `docs/architecture/backend.md` and
`.claude/skills/pkm/SKILL.md` were updated to state explicitly that the
heading round trip is `pkm get`/`get_page`/`get_block` only, and that
`pkm todos`/`search`/`refs` output never carries heading markers, so text
copied from those verbs into `update`/`update_block` silently loses a
heading.

**Task 3 — decision: docs wording only, no code.** Confirmed the mechanism:
an empty heading block (`heading` set, `text` == `""`) renders via
`cli/render.py`'s `_line` as `- ## ` (heading marker, no body), and
`split_heading`'s `_HEADING_SPEC` (`^(#{1,3}) (.+)$`) requires at least one
body character after the hashes, so re-`update`ing that exact line stores
the literal string `"## "` with `heading=None` — a genuine but vanishingly
rare loss (there is no way to *write* a heading with empty text through any
CLI/MCP verb; the state can currently only be reached by direct DB
manipulation or a pre-existing row). Adding code to special-case it would
add a branch for a state the write path can't itself produce. `.claude/skills/pkm/SKILL.md`'s
write-verbs section now says this explicitly, alongside the task-2
clarification, so the "round trips are lossless" claim is no longer an
overclaim.

**Docs touched:** `docs/architecture/backend.md` (planner list gains
`plan_mark`; new paragraph on the `pkm get`-only round trip and why the
other three renderers aren't going to change), `.claude/skills/pkm/SKILL.md`
(write-verbs bullet rewritten to cover both the empty-heading case and the
non-`get` renderers). No server/API/route change; no openapi or generated-types
regen needed.

**Verification:** `cd server && uv run pytest -q` — 954 passed, coverage
95.97% (gate is 95%). `uv run pyrefly check` — 0 errors. `uv run ruff check`
— all checks passed. No `cli/`/`mcp/` test setup exists outside
`server/tests/`, so no separate suite to run. Web `pnpm verify`/Playwright
intentionally not run per task instructions (no web-app changes; another
session owns the E2E port).
