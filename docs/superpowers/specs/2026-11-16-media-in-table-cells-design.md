# Media in table cells and query cards

Bean: pkm-4uv1.

## Intent

A query's Table and Cards views, and a plain `{{table}}`, are for scanning
many rows. Today a cell renders its value exactly as the outline does, so a
`Local copy::` link to an uploaded PDF mounts the whole inline viewer and one
row grows to the viewer's height. The same happens with an image, a Bluesky
post, a Mermaid diagram, a code block or a nested query. Rows should stay
table-sized; the media should be one click away.

## Goals

- A cell or card value that holds media shows a compact, one-line label.
- A PDF or image label opens the existing full-screen viewer over the table.
  Escape or Close returns to the table with focus back on the label, and the
  table keeps its filter, sort, scroll and any held rows.
- Any other media label takes you to the block that holds it.
- Nothing is fetched until the click, so a table of local-copy papers stays
  cheap to render.

## Non-goals

- Changing how media renders in the outline, backlinks or the sidebar.
- Row titles (`RecordLink`): their media is already inert text.
- New full-screen viewers for Bluesky, Mermaid, code or queries.

## Anti-goals

- A click on a media label opening the cell editor, or a click elsewhere in
  the cell no longer opening it.
- A table render that fetches a PDF, image or post.

## Approaches

1. **Full-screen viewer from the cell.** Keeps you in the table, reuses
   `PdfViewer`'s overlay mode (as the Files browser uses it) and
   `ImageOverlay`. Only PDFs and images have such a viewer.
2. **Link to the block.** One rule for every media kind, including future
   ones, and it matches how row titles already treat media. Reading a PDF
   takes two steps, and leaving the page loses an unsaved filter or sort.
3. **Split by kind (chosen).** PDFs and images take approach 1, since reading
   papers from a reading list is the main use and both viewers exist.
   Everything else takes approach 2.

## Decided

| Value holds | Cell or card shows | Click | Shift-click |
|---|---|---|---|
| a PDF link (uploaded or local) | 📄 and the link text or file name | full-screen PDF viewer | same |
| an image (uploaded or external) | 🖼 and the alt text or file name | full-screen image viewer | same |
| a Bluesky post, Mermaid diagram, code block or nested query | a short label naming the kind | go to the line that holds it, on its page | open that line in the right sidebar |
| anything else (text, links, tags, refs, math, TODO) | as today | as today | as today |

- Applies to query Table and Cards cells (`CellValue`) and plain
  `{{table}}` body cells. Plain-table headers already write media out as
  text (`headerSegments`).
- The label is its own button inside the cell. Keyboard: Enter or Space on
  it does what a click does; Enter on the cell itself still opens the editor.
- Query tables and plain tables behave the same, so a label does the same
  thing wherever it appears. For a plain table the line is the cell's own
  block, on the page already open.

## Calls made here (correct any)

- External images open in the full-screen viewer on click without the
  separate click-to-load step: the click is the consent that step asks for.
- A value with text and media keeps the text and swaps only the media for
  its label.

## Left to the builder

- How the cell context reaches the renderers (a context read where
  `InlineSegments` dispatches is the likely shape, as `InertMediaContext`
  does for row titles).
- Label wording and styling, within the existing control classes.
- Where a jump to a plain table's cell lands: the cell's block renders as
  part of the table, so the jump should bring the table into view and mark
  that cell, the way a jump to a line marks the line.
- Where the rule is stated: `frontend-rendering.md` beside the PDF and
  segment tables, and `frontend-editor.md` § Tables.
