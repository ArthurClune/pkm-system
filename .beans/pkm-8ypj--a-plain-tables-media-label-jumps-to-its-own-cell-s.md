---
# pkm-8ypj
title: A plain table's media label jumps to its own cell, so the media is never seen rendered
status: draft
type: feature
priority: deferred
created_at: 2026-11-16T20:17:03Z
updated_at: 2026-11-16T20:17:03Z
---

In a plain {{table}} body cell, media that has no full-screen viewer (a Mermaid diagram, a code block, a Bluesky post, a nested query) renders as a ↗ label. The label goes to the line that holds the media, and for a plain table that line is the cell's own block, on the page already open: the click scrolls to and flashes the same cell, and shift-click opens the same page, with the same table, in the sidebar. So such media in a plain table can be seen only as raw text in the cell editor. Query tables are fine: their line is on another page, where the outline renders the media.

This was the agreed behaviour (plain and query tables behave the same), kept on purpose to live with for a while. Likely first change: code blocks and plain text, e.g. showing a code block inline in a plain-table cell (or in a popover from the label) instead of a label that goes nowhere new.

Where the rule lives: docs/architecture/frontend-rendering.md § Media in table cells (cellMedia in web/src/components/cellMediaCore.ts decides what becomes a label; CellMediaLabel renders it; PlainTable and roamTable's StaticTable provide CellMediaContext). Follows pkm-4uv1.
