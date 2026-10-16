---
# pkm-0cx2
title: 'Line-length rule in the pre-commit lint: comments 80, code 120, markdown exempt, noqa: E501 override'
status: in-progress
type: task
created_at: 2026-10-16T18:17:42Z
updated_at: 2026-10-16T18:17:42Z
---

Follow-on to pkm-rfkp. The repo wraps comment blocks at 80 and code at 120 (ruff `line-length`), by convention only; the pointer relink left 40 ragged comment lines and a sweep found 582 comment lines over 80 and 84 code lines over 120 on main.

## Rule

`commentlint` gains `line-length`: a comment line (only a comment marker precedes the text, or a docstring/block interior) is at most 80 characters; any other line at most 120. `.md` files are exempt (architecture tables cannot wrap). A line carrying `noqa: E501` in a comment is exempt. Ruff `E501` is enabled at 120 so Python editors flag code lines live with the same override.

## Checklist

- [ ] core: `line-length` rule, comment-line detection by column, `noqa: E501` override, `.md` exempt; tests
- [ ] ruff: `extend-select = ["E501"]`
- [ ] sweep: rewrap comment paragraphs over 80 (scripted, markers/directives/commands kept on their own lines); fix or override the 84 code lines over 120
- [ ] regenerate openapi.json / types.d.ts if a docstring moved
- [ ] AGENTS.md rule paragraph; backend.md Testing bullet
