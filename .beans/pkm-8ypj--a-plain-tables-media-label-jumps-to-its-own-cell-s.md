---
# pkm-8ypj
title: A plain table's media label jumps to its own cell, so the media is never seen rendered
status: completed
type: feature
priority: normal
created_at: 2026-11-16T20:17:03Z
updated_at: 2026-11-17T08:49:48Z
---

In a plain {{table}} body cell, media that has no full-screen viewer (a Mermaid diagram, a code block, a Bluesky post, a nested query) renders as a ↗ label. The label goes to the line that holds the media, and for a plain table that line is the cell's own block, on the page already open: the click scrolls to and flashes the same cell, and shift-click opens the same page, with the same table, in the sidebar. So such media in a plain table can be seen only as raw text in the cell editor. Query tables are fine: their line is on another page, where the outline renders the media.

This was the agreed behaviour (plain and query tables behave the same), kept on purpose to live with for a while. Likely first change: code blocks and plain text, e.g. showing a code block inline in a plain-table cell (or in a popover from the label) instead of a label that goes nowhere new.

Where the rule lives: docs/architecture/frontend-rendering.md § Media in table cells (cellMedia in web/src/components/cellMediaCore.ts decides what becomes a label; CellMediaLabel renders it; PlainTable and roamTable's StaticTable provide CellMediaContext). Follows pkm-4uv1.


## Checklist

- [x] Plain-table cells render code, Mermaid/query sources and Bluesky links in place
- [x] E2E updated
- [x] Architecture doc updated


## Summary of Changes

Symptom: in a plain {{table}} cell, a code block, Mermaid diagram, bare
Bluesky post or nested query showed as a "↗ Code block" / "↗ Mermaid
diagram" / "↗ Bluesky post" / "↗ Query" label whose click scrolled to
the same cell. Cause: plain tables used the query-table label, whose target
is the line holding the media, and in a plain table that line is the cell.

Now a plain-table cell renders that media in place: a code block as a
highlighted CodeBlock, a Mermaid block as its source in a CodeBlock with no
language, a bare Bluesky URL as a plain link, and a query as its source as
typed (the tokenizer's query segment carries `source`). Query tables and
cards keep their labels; PDFs and images keep labels and overlays
everywhere. CellMediaTarget is a union by table kind and a line label
carries its own page and uid, so OutlinePageContext had no reader left and
was removed. The entry-chunk budget rose by the measured 264 bytes.

The rule lives in docs/architecture/frontend-rendering.md § Media in table
cells.
