---
# pkm-dzgw
title: pkm get --section ignores requested heading level
status: todo
type: bug
priority: low
created_at: 2026-07-31T16:46:08Z
updated_at: 2026-07-31T16:46:08Z
parent: pkm-ulae
---

Follow-up from pkm-5ayg review. server/src/pkm/cli/render.py::select_section documents "'## Heading' or bare text" and deliberately strips the marker, so --section "### Notes" silently returns a level-2 heading — the level a user types is ignored. Lenient text matching is the read path's stated contract, but the level half should either be honored when given or explicitly documented as ignored.

- [ ] Decide: honor level when a marker is supplied, or document that markers are stripped
- [ ] Align render.py select_section and its docstring/help text with the decision
