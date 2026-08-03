---
# pkm-dzgw
title: pkm get --section ignores requested heading level
status: completed
type: bug
priority: low
created_at: 2026-07-31T16:46:08Z
updated_at: 2026-08-03T14:18:39Z
parent: pkm-ulae
---

Follow-up from pkm-5ayg review. server/src/pkm/cli/render.py::select_section documents "'## Heading' or bare text" and deliberately strips the marker, so --section "### Notes" silently returns a level-2 heading — the level a user types is ignored. Lenient text matching is the read path's stated contract, but the level half should either be honored when given or explicitly documented as ignored.

- [x] Honor level and exact text for marked specs; preserve bare exact-text matching
- [x] Align render.py select_section and its docstring/help text with the decision

## Summary of Changes

- `render.py::select_section` now decides its matching mode from the spec's own
  syntax instead of stripping the marker. A marked spec (`## Notes`) matches
  heading level *and* exact text — the same level-and-text rule `--parent`
  already used, so the two specs can no longer disagree about which `Notes`
  they mean. A bare spec (`Notes`) keeps the lenient behaviour: exact text at
  any level, including a plain non-heading block. Ties resolve to the first
  match in document order in both modes.
- A miss now raises `RenderError` listing the page's headings *with* their
  level markers (`## Notes, ### Notes`) and echoes the spec as typed, so the
  error tells the user which spelling to ask for next.
- The docstring, the `pkm get` epilog, and the `--section` argument help all
  state both modes; README and the PKM skill show both forms.
- The `{1,3}` marker bound covers the app's whole heading domain (`h1`-`h3`
  via `HEADING_COMMANDS`); a `####` spec reads as bare text and still finds
  the block by exact text at any level, so nothing became unreachable.
- Verified: focused `test_cli_render.py`/`test_cli_main_read.py`/
  `test_cli_help.py` 92 passed; full server suite 1382 passed at 96.67%
  coverage; pyrefly 0 errors; ruff clean.
