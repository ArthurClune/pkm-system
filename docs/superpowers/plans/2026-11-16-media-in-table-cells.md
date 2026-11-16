# Media in Table Cells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A query Table/Cards cell or a plain `{{table}}` body cell shows media as a one-line label; a PDF or image label opens the full-screen viewer, any other media label goes to the line that holds it.

**Architecture:** A pure classifier (`cellMedia`) decides, per inline segment, whether it is media and which label it gets. `InlineSegments` consults it only under a new `CellMediaContext`, which the table hosts provide with the cell's page and uid, and renders `CellMediaLabel` in place of the media. PDFs reuse `PdfEmbed`'s overlay mode (as `views/Files.tsx` does), images reuse `ImageOverlay`; the line label navigates like `RecordLink` does. A jump to a plain-table cell finds the cell by a `data-cell-uid` the table puts on its `<td>`.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-media-in-table-cells-design.md`. Bean: `pkm-4uv1`.

## Global Constraints

- Applies to query Table and Cards cells (`CellValue`) and plain `{{table}}` body cells only; headers already write media as text (`headerSegments`).
- Not changed: media in the outline, backlinks, sidebar, and query row titles (`RecordLink`).
- Nothing is fetched until the label is clicked: no `<img>`, no PDF viewer import, no Bluesky frame in a cell before the click.
- A click on a label never opens the cell editor; a click elsewhere in an editable cell still does.
- Query tables and plain tables behave the same: line label click goes to the line on its page, shift-click opens that line in the right sidebar.
- A value with text and media keeps the text; only the media segment becomes a label.
- External images open full-screen on the first click (no separate click-to-load step).
- Work in `/Users/arthur/code/llm/pkm/.worktrees/cell-media` (branch `feat/cell-media`). Its `web/node_modules` is a symlink: never stage it, never `pnpm install` through it. Stage by explicit path.
- FCIS headers on every new file; comment lines ≤ 80 columns; no bean ids in code comments.

## Review Focus

1. Escape inside a viewer opened from a cell (inside the table's `island`) closes the viewer and returns focus to the label, without leaving the cell editor open. Test in Task 3.
2. A click or Enter inside the viewer's portal bubbles through the React tree to the `<td>`: it must not open the cell editor behind the viewer. Test in Task 3.
3. A local-copy PDF (`/api/local/…`) or external image in a cell fetches nothing on render. Test in Task 2.
4. A cell whose value is text plus a PDF link keeps the text. Test in Task 2.
5. A re-render of the table with the same cell value (a refetch) keeps an open viewer open. Test in Task 3.

---

### Task 1: The pure classifier

**Files:**
- Modify: `web/src/components/externalMedia.ts` (receives `isPdfHref`, `isDeferredPdfHref`, `pdfLabelFromHref` from `InlineSegments.tsx`, unchanged, all exported)
- Modify: `web/src/components/InlineSegments.tsx` (import them from `externalMedia`; delete the local copies)
- Modify: `web/src/components/InlineSegments.test.tsx`, `web/src/sync/assets.props.test.ts` (import from `externalMedia`)
- Create: `web/src/components/cellMediaCore.ts` (`// pattern: Functional Core`)
- Test: `web/src/components/cellMediaCore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CellMedia =
    | { kind: "pdf"; href: string; label: string }
    | { kind: "image"; src: string; alt: string; label: string }
    | { kind: "line"; label: string };
  export function cellMedia(seg: BlockSegment): CellMedia | null;
  ```

- [ ] **Step 1: Write the failing tests** in `cellMediaCore.test.ts`, building segments with `tokenizeBlock` from `../grammar/tokenize` (take the one segment of interest):
  - `[paper.pdf](/assets/<64 hex>/paper.pdf)` → `{ kind: "pdf", href, label: "paper.pdf" }`
  - `{{pdf: /api/local/Papers/A%20B.pdf}}` → `{ kind: "pdf", label: "A B.pdf" }`
  - `![Bed plan](/assets/<64 hex>/bed.png)` → `{ kind: "image", alt: "Bed plan", label: "Bed plan" }`
  - `![](https://example.org/x/photo.jpg)` → `{ kind: "image", label: "photo.jpg" }`; `![](https://example.org/)` → `label: "image"`
  - a bare Bluesky post URL (copy one from `bluesky.test.ts`) → `{ kind: "line", label: "Bluesky post" }`; the same URL as `[source](url)` → `null`
  - ```` ```mermaid ```` block → `label: "Mermaid diagram"`; ```` ```python ```` block → `label: "Code block"`
  - `{{query: {and: [[X]]}}}` → `label: "Query"`
  - `null` for: plain text, `` `inline code` ``, `$x$`, `[[Page]]`, `#tag`, `((block-uid))`, a TODO, an https link, a GoodLinks link, an `/assets/…/notes.txt` link

- [ ] **Step 2: Run to verify it fails**

  Run: `cd web && pnpm vitest run src/components/cellMediaCore.test.ts`
  Expected: FAIL, cannot resolve `./cellMediaCore`.

- [ ] **Step 3: Move the three PDF helpers into `externalMedia.ts`, then implement `cellMedia`** using `isPdfHref`, `pdfLabelFromHref` and `isBlueskyPostUrl` (`./bluesky`) with the same tests `InlineSegments`' `Segment` applies today (a `link` is a PDF only when `isPdfHref`; a Bluesky embed only when `text === href`). An image's label is its alt, else the last path segment of `src` decoded (raw on malformed encoding, as `pdfLabelFromHref` does), else `"image"`.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd web && pnpm vitest run src/components/cellMediaCore.test.ts src/components/InlineSegments.test.tsx src/sync/assets.props.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add web/src/components/externalMedia.ts web/src/components/InlineSegments.tsx \
    web/src/components/InlineSegments.test.tsx web/src/sync/assets.props.test.ts \
    web/src/components/cellMediaCore.ts web/src/components/cellMediaCore.test.ts
  git commit -m "web: classify media segments for table cells (pkm-4uv1)"
  ```

### Task 2: The label and its dispatch

**Files:**
- Modify: `web/src/contexts.ts` (two contexts)
- Create: `web/src/components/CellMediaLabel.tsx` (`// pattern: Imperative Shell`)
- Modify: `web/src/components/InlineSegments.tsx` (`Segment`)
- Modify: `web/src/styles.css` (`.cell-media-label`, beside `.query-cell-badge`)
- Test: `web/src/components/CellMediaLabel.test.tsx`

**Interfaces:**
- Consumes: `cellMedia`, `CellMedia` (Task 1); `PdfEmbed({ href, label, onClose })` overlay mode; `ImageOverlay({ src, alt, onClose, onError, triggerRef })`; `SidebarContext.openInSidebar(title, uid)`; `pagePath(title)`.
- Produces:
  ```ts
  // contexts.ts
  /** Set by a table cell: media in it renders as a CellMediaLabel, and a
   * line label goes to `uid` on `page` (null: label is plain text). */
  export interface CellMediaTarget { page: RawTitle | null; uid: BlockUid }
  export const CellMediaContext = createContext<CellMediaTarget | null>(null);
  /** The page an editable outline shows; null outside one. */
  export const OutlinePageContext = createContext<RawTitle | null>(null);
  // CellMediaLabel.tsx
  export function CellMediaLabel({ media }: { media: CellMedia }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests** in `CellMediaLabel.test.tsx`, rendering `<InlineSegments segments={tokenizeBlock(text)} />` inside `CellMediaContext.Provider value={{ page: "Reading List", uid: "cell-uid-1" }}` and a `MemoryRouter` (mint brands with the helpers in `test-mint.ts`):
  - `pdf_label_replaces_the_embed`: text `See [paper.pdf](/assets/<hex>/paper.pdf)` → `getByRole("button", { name: "Open PDF full screen: paper.pdf" })` has text `📄 paper.pdf`; the text `See` is present; `container.querySelector(".pdf-embed")` is null.
  - `local_pdf_and_external_image_fetch_nothing_until_clicked`: `{{pdf: /api/local/a.pdf}}` and `![](https://example.org/p.jpg)` → no `img` element and a spy on `fetch` not called.
  - `pdf_label_opens_the_overlay_and_escape_returns_focus`: click the label → `findByRole("dialog")`; `userEvent.keyboard("{Escape}")` → no dialog, and the label has focus.
  - `image_label_opens_the_image_overlay`: `![Bed](/assets/<hex>/bed.png)` → button name `Open image full screen: Bed`, text `🖼 Bed`; click → dialog named `Expanded image: Bed`.
  - `line_label_navigates_and_shift_opens_the_sidebar`: a mermaid block → button text `↗ Mermaid diagram`; click → location is `pagePath("Reading List")#cell-uid-1`; shift-click → `openInSidebar` called with `("Reading List", "cell-uid-1")`.
  - `line_label_without_a_page_is_text`: provider `page: null` → no button, text `↗ Mermaid diagram`.
  - `outside_a_cell_nothing_changes`: same PDF text without the provider renders `.pdf-embed`.

- [ ] **Step 2: Run to verify it fails**

  Run: `cd web && pnpm vitest run src/components/CellMediaLabel.test.tsx`
  Expected: FAIL, `CellMediaContext` not exported.

- [ ] **Step 3: Implement.** In `Segment`, read `CellMediaContext`; when it is non-null and `cellMedia(seg)` is non-null, return `<CellMediaLabel media={…} />` before the switch. `CellMediaLabel` renders one `<button type="button" className="cell-media-label">` whose `onClick` calls `event.stopPropagation()` first (the `<td>` opens the editor on click, and `ClickToLoad` stops for the same reason). PDF and image keep an `open` state and mount `PdfEmbed`/`ImageOverlay` only while open, with the button as `triggerRef` for the image. An image whose overlay errors closes and the label reads `🖼 <label> (unavailable)`. The line label navigates with `useNavigate` to `` `${pagePath(page)}#${uid}` ``, or `openInSidebar(page, uid)` on shift. Styling uses existing tokens only: inline, no border, `--color-link` text, the badge's font size.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd web && pnpm vitest run src/components/CellMediaLabel.test.tsx src/components/InlineSegments.test.tsx`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add web/src/contexts.ts web/src/components/CellMediaLabel.tsx \
    web/src/components/CellMediaLabel.test.tsx web/src/components/InlineSegments.tsx \
    web/src/styles.css
  git commit -m "web: media in a table cell renders as a label (pkm-4uv1)"
  ```

### Task 3: The hosts, and the jump into a plain table

**Files:**
- Modify: `web/src/tables/recordCells.tsx` (`CellValue` gains `page: RawTitle`; provides `CellMediaContext` with `{ page, uid: cell.uid }`)
- Modify: `web/src/tables/QueryTable.tsx`, `web/src/tables/QueryCards.tsx` (pass `record.page_title`)
- Modify: `web/src/tables/DataTable.tsx` (optional prop `cellAnchor?: (r: R, c: Column) => string | null`, written as `data-cell-uid` on the body `<td>`)
- Modify: `web/src/components/PlainTable.tsx` (`renderCell` wraps `content(cell.text)` in `CellMediaContext.Provider value={{ page, uid: cell.uid }}` with `page = useContext(OutlinePageContext)`; passes `cellAnchor` returning the cell's uid)
- Modify: `web/src/views/EditablePage.tsx` (provides `OutlinePageContext` with `title` around `EditableBlockTree`)
- Modify: `web/src/useScrollFlashTarget.ts` (selector `[data-uid="…"], [data-cell-uid="…"]`)
- Modify: `web/src/styles.css` (`td.flash-target` gets the `flash-target` animation, beside `.block-row.flash-target`)
- Test: `web/src/tables/DataTable.test.tsx`, `web/src/components/PlainTable.test.tsx` (or the nearest existing PlainTable test file), `web/src/useScrollFlashTarget.test.ts`, the existing `QueryTable`/`QueryCards` tests

**Interfaces:**
- Consumes: `CellMediaContext`, `OutlinePageContext`, `CellMediaLabel` (Task 2).
- Produces: `CellValue({ cell, page, depth })`; `DataTable`'s `cellAnchor` prop.

- [ ] **Step 1: Write the failing tests**
  - PlainTable: an editable table whose body cell is `[paper.pdf](/assets/<hex>/paper.pdf)`:
    - `label_click_does_not_open_the_cell`: click the label → a dialog opens and no `textarea` is in the table.
    - `escape_in_the_viewer_closes_it_not_the_cell`: open, press Escape → no dialog, no `textarea`, label focused.
    - `enter_in_the_viewer_does_not_open_the_cell`: open, focus the dialog's Close, press Enter → no `textarea` in the table.
    - `click_beside_the_label_still_opens_the_cell`: click the `<td>` itself → `textarea` present.
    - `a_rerender_keeps_the_viewer_open`: open, rerender with the same rows → dialog still present.
    - `td_carries_the_cell_uid`: the body `<td>` has `data-cell-uid` equal to that cell block's uid.
  - QueryTable and QueryCards: a record with a PDF cell renders the label, and its line label (mermaid cell) navigates to `pagePath(record.page_title)#<cell.uid>`.
  - `useScrollFlashTarget`: a `<td data-cell-uid="u1">` is scrolled to and gets `flash-target`.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd web && pnpm vitest run src/tables src/components/PlainTable src/useScrollFlashTarget`
  Expected: the new tests FAIL; existing ones pass.

- [ ] **Step 3: Implement** the file changes listed above. If Review Focus 2 fails (the portal's click or Enter reaching the `<td>`), stop it at `CellMediaLabel`'s wrapper around the open viewer (`onClick` and `onKeyDown` that `stopPropagation`), not in `DataTable`.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd web && pnpm vitest run src/tables src/components src/useScrollFlashTarget.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add web/src/tables web/src/components/PlainTable.tsx web/src/views/EditablePage.tsx \
    web/src/useScrollFlashTarget.ts web/src/styles.css <test files touched>
  git commit -m "web: query and plain table cells show media as labels (pkm-4uv1)"
  ```

### Task 4: End to end, docs, gates

**Files:**
- Create: `web/e2e/cell-media.spec.ts` (imports `test` from `./ownPage`; uploads `test-data/assets/sample.pdf` the way `web/e2e/pdf.spec.ts` does)
- Modify: `docs/architecture/frontend-rendering.md` (§ PDF embeds and the viewer, and the segment table: the cell rule, `CellMediaContext`, and that nothing fetches before the click)
- Modify: `docs/architecture/frontend-editor.md` § Tables (a row or sentence: labels in cells, the click never opens the editor, `data-cell-uid` as the jump target)
- Modify: `docs/architecture/styling.md` (`.cell-media-label`, `td.flash-target`)
- Modify: `docs/keyboard.md` § Query tables (one sentence for users: a 📄 or 🖼 label opens full screen, Escape returns; ↗ goes to the line, Shift-click opens it in the sidebar)
- Modify: `web/tooling/budgets.json` only if `pnpm verify` reports `initialEntryBytes` over; raise by the measured growth and say so in the commit

- [ ] **Step 1: Write the e2e spec** on the `ownPage` page: a block `Tags:: #CellMediaE2E<random>` and `Local copy:: [sample.pdf](<uploaded url>)` at the top level, a `{{query: {and: [[CellMediaE2E<random>]]}}}` block, and a `{{table}}` whose second row's cell holds a ```` ```mermaid ```` block. Assert:
  - the query table row's height is under 80px and shows `📄 sample.pdf`;
  - clicking it opens the dialog; Escape closes it and the table's Filter text typed before opening is still there;
  - in the plain table, clicking `↗ Mermaid diagram` keeps the URL's path and adds `#<cell uid>`, and that `<td>` gets `flash-target`;
  - shift-click opens a sidebar panel.

- [ ] **Step 2: Run it**

  Run: `cd web && pnpm build && E2E_PORT=8986 node tooling/runPlaywright.ts cell-media` (Playwright serves the last build, so build first)
  Expected: PASS

- [ ] **Step 3: Update the four docs** (invoke the `architecture-docs` skill for the `docs/architecture/` edits).

- [ ] **Step 4: Full web verification**

  Run: `cd web && set -o pipefail && pnpm verify 2>&1 | tail -30`
  Expected: exit 0.

- [ ] **Step 5: Perf, frontend side**

  Run (repo root, quiet machine): `perf/check.sh frontend`
  Expected: no regression; follow its `next:` lines otherwise.

- [ ] **Step 6: Commit, and complete the bean** with a `## Summary of Changes` (symptom as observed: a `Local copy::` PDF link made its query-table row the height of the PDF viewer).

  ```bash
  git add web/e2e/cell-media.spec.ts docs/architecture/frontend-rendering.md \
    docs/architecture/frontend-editor.md docs/architecture/styling.md docs/keyboard.md \
    .beans/pkm-4uv1--*.md [web/tooling/budgets.json]
  git commit -m "web: e2e and docs for media in table cells (pkm-4uv1)"
  ```
