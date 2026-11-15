---
# pkm-0mmv
title: Table cells have no keyboard entry point
status: todo
type: task
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-15T21:05:01Z
parent: pkm-l79g
---

In DataTable, sort headers are buttons and reachable by keyboard, but editable cells have no tab stop: a keyboard-only reader cannot open a cell without clicking first. Once one cell is open, Tab moves between cells. Give editable cells a focusable entry (roving tabindex, or Enter on a focused cell) without fighting the outline's own Tab handling.
