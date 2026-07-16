# Roam Table Rendering Design

## Problem

The imported graph correctly preserves Roam table blocks, including five examples on `AI Pricing` and 31 examples overall. The frontend does not recognize `{{table}}` or `{{[[table]]}}`, so it displays the macro literally and renders the table's cells as a deeply nested outline.

Roam stores each table row as a direct child of the macro block. That child's single-child chain contains the row's cells. The first structural row is the table header; subsequent rows are body rows.

## Scope

- Render valid `{{table}}` and `{{[[table]]}}` block trees as semantic HTML tables in both editable and read-only outlines.
- Preserve inline Roam-flavoured Markdown rendering inside every cell.
- Add a `Table` slash command: selecting `/table` in an empty block replaces the trigger with `{{table}}`.
- Do not rewrite imported data or change the server/import pipeline.
- Do not add spreadsheet-style cell editing or table-specific structural editing controls.

## Architecture

### Functional core

Add `web/src/components/roamTable.ts`, classified as Functional Core. It will:

- recognize only complete, case-insensitive macro spellings after trimming surrounding whitespace;
- walk each direct child's single-child chain into a row;
- return `null` when the macro has no rows or any cell branches to multiple children, ensuring malformed content remains visible through the ordinary outline renderer;
- normalize valid rows to the widest row by padding missing trailing cells with `null`.

The output retains each `BlockNode`, rather than reducing cells to strings, so rendering can tokenize the original cell text without losing identity or metadata.

### Imperative shell

Add `web/src/components/RoamTable.tsx`, classified as Imperative Shell because it composes `InlineSegments` and its context-aware child renderers. It receives normalized rows and emits:

- a horizontally scrollable wrapper;
- a semantic `<table>`;
- the first row in `<thead>` using `<th>`;
- remaining rows in `<tbody>` using `<td>`;
- `tokenizeBlock` plus `InlineSegments` for every non-empty cell.

`BlockTree.tsx` and `EditableBlockTree.tsx` will call the pure conversion helper at the block boundary. A valid table replaces the macro text and ordinary descendant outline. Read-only rendering always shows the table. In the editable tree, clicking the table follows the existing block click behavior and focuses the macro block; while that macro is focused, the raw macro and ordinary descendants reappear for editing. Blurring restores the rendered table. This keeps all source blocks editable without introducing a second editor implementation.

### Slash command

Add `{ name: "table", label: "Table" }` to `SLASH_COMMANDS`. `applySlashCommand` will transform an empty `/table` trigger into `{ text: "{{table}}", cursor: 9 }`. The existing autocomplete menu and command application path require no shell changes.

## Presentation

Add narrowly scoped styles for the scroll wrapper and table borders, spacing, header background, and left-aligned header text. Colors will use existing theme variables. Wide tables scroll horizontally rather than overflowing the page or sidebar.

## Error and Edge Handling

- Empty table macros remain ordinary blocks, which is necessary immediately after `/table` creation and keeps them editable.
- Branched cell structures fall back to the ordinary outline so no imported content is silently hidden.
- Ragged rows are padded with empty cells to match Markdown table behavior.
- One-row tables render a header with an empty body.
- Cell content continues through the existing safe link, page reference, emphasis, TODO, and embed rendering rules.

## Testing

Use test-driven development:

1. Pure helper tests based on the `AI Pricing` shape: macro recognition, first-row/header ordering, row-chain conversion, ragged-row padding, and malformed-branch fallback.
2. `BlockTree` and `EditableBlockTree` rendering tests asserting a semantic table, header/body cells, inline Markdown rendering, hidden macro text/outline while rendered, and editable fallback when the macro receives focus.
3. Slash command tests asserting `Table` is offered and `/table` produces exactly `{{table}}` with the cursor at the end.
4. Run focused Vitest tests, full `pnpm verify`, server tests/typecheck/lint, and FCIS validation before completion.
