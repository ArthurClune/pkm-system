---
# pkm-aks7
title: CLI/MCP heading follow-ups from pkm-8m94
status: in-progress
type: task
priority: normal
created_at: 2026-07-30T21:16:48Z
updated_at: 2026-07-31T08:29:44Z
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

- [ ] 1. Extract `plan_mark` into `cli/build.py` and use it from both shells
- [ ] 2. Decide whether the three non-`get` renderers should print heading hashes (and update the round-trip claim to match whichever way it goes)
- [ ] 3. Decide whether an empty heading block needs handling, or whether SKILL.md's wording should be made exact

Context: pkm-8m94 (merged at bd0dc35, prod deployed 2026-07-30). Design: docs/superpowers/specs/2026-07-30-cli-mcp-heading-writes-design.md
