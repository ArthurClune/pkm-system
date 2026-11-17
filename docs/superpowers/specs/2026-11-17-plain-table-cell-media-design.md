# Plain-table cell media renders in place (pkm-8ypj)

## Intent

In a plain `{{table}}` body cell, media with no full-screen viewer renders
as a ↗ label whose target is the cell's own block, on the page already
open. The click goes nowhere new, so the media can only be read as raw text
in the cell editor. Plain tables should show it instead.

## Goals

- A code block in a plain-table cell renders as a `CodeBlock` (highlighted),
  in the cell.
- A Mermaid block in a plain-table cell renders as its source, as a
  `CodeBlock` with no language: a drawn diagram in a cell is not wanted.
- A bare Bluesky post URL in a plain-table cell renders as an ordinary link,
  not an embed.
- A nested `{{query}}` in a plain-table cell renders as its source text, not
  a live query.
- Both `StaticTable` (before the tables chunk loads) and `PlainTable` render
  the same, so the swap does not change a cell.

## Non-goals

- Query tables and Cards (`recordCells`) keep the labels: their line is on
  another page, where the outline renders the media.
- PDFs and images keep their labels and overlays in every table.
- Maths and plain text already render in cells; nothing changes for them.

## Approaches

- **A (chosen):** every "line" medium renders in place in a plain table:
  code as code, Mermaid and queries as source, Bluesky as a link. No plain
  table is left with a label that goes nowhere.
- **B:** only code and Mermaid change now; Bluesky and queries stay as
  labels that jump to their own cell. Rejected: it keeps the dead-end label.

## Design

- The cell context tells `Segment` whether the cell belongs to a plain table
  (`PlainTable` and `StaticTable` say yes; `recordCells` says no).
- `cellMedia` (Functional Core) takes that and, for a plain table, returns
  what to render instead of a "line" label: a code block (with its language,
  or none for Mermaid), a plain link, or source text. PDF and image results
  are unchanged.
- A wide code block widens its column; the table's horizontal scroll already
  absorbs that.

## Left to the builder

- Names of the context field and result kinds.
- How a query's source text is reconstructed (the segment holds `expr` and
  `options`, not the raw text).
- That a click inside a rendered code block (e.g. a copy control, text
  selection) still behaves sensibly given the `<td>` opens the cell editor on
  a click.
- Updating `docs/architecture/frontend-rendering.md` § Media in table cells.
