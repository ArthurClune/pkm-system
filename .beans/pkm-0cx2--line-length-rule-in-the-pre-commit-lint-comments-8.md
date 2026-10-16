---
# pkm-0cx2
title: 'Line-length rule in the pre-commit lint: comments 80, code 120, markdown exempt, noqa: E501 override'
status: completed
type: task
priority: normal
created_at: 2026-10-16T18:17:42Z
updated_at: 2026-10-16T18:33:42Z
---

Follow-on to pkm-rfkp. The repo wraps comment blocks at 80 and code at 120 (ruff `line-length`), by convention only; the pointer relink left 40 ragged comment lines and a sweep found 582 comment lines over 80 and 84 code lines over 120 on main.

## Rule

`commentlint` gains `line-length`: a comment line (only a comment marker precedes the text, or a docstring/block interior) is at most 80 characters; any other line at most 120. `.md` files are exempt (architecture tables cannot wrap). A line carrying `noqa: E501` in a comment is exempt. Ruff `E501` is enabled at 120 so Python editors flag code lines live with the same override.

## Checklist

- [x] core: `line-length` rule, comment-line detection by column, `noqa: E501` override, `.md` exempt; tests
- [x] ruff: `extend-select = ["E501"]`
- [x] sweep: rewrap comment paragraphs over 80 (scripted, markers/directives/commands kept on their own lines); fix or override the 84 code lines over 120
- [x] regenerate openapi.json / types.d.ts if a docstring moved
- [x] AGENTS.md rule paragraph; backend.md Testing bullet

## Summary of Changes

- `commentlint` gained `line-length`: comment lines (only a marker before the text, or a block/docstring interior) at most 80 columns, any other line 120, markdown exempt, `noqa: E501` exempt. Two scanner fixes came with it: string literals are skipped in TS/CSS (a `"/page/*"` route no longer opens a phantom block comment) and an assigned triple-quoted string (`DDL = """`) is data, not a docstring. Ruff `E501` enabled at 120 for live editor feedback.
- Sweep: 91 files had comment paragraphs refilled to 80 by script (markers, directives, commands and bullets kept on their own lines); ~120 code lines over 120 were reformatted by hand (object/JSX literals, imports, title and copy strings split with concatenation, CSS rules across lines, EDN fixture headers behind a `"""\` continuation, pyrefly-ignore reasons moved to a comment line). Two `noqa: E501`: the quoted upstream code line in `openRetry.test.ts` and nothing else — the SVG path was split instead.
- openapi.json / types.d.ts regenerated for the `routes_pages` docstring. AGENTS.md and backend.md state the widths and the override.
