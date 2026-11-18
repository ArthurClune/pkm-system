# Floating Table of Contents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the main page, a page with a `{{toc}}` block shows its contents
in a sticky column on the right while the right sidebar is closed and the
pane has room; the block itself then shrinks to a marker.

**Architecture:** App measures the main pane (it already owns `mainRef`)
and publishes one boolean, "the pane has room for a floating toc", through a
new context; the decision is a pure function of (sidebar open, pane content
width). `EditablePage`, when its host opts in (`floatToc`, PageView only),
combines that boolean with the first `{{toc}}` uid in its live tree. If it
floats, it lays the tree out beside an `<aside>` holding the list and tells
the rows which toc uid is floating through a second context that only
`TocBlock` reads, so no other row's memo breaks.

**Tech Stack:** React 19, TypeScript, vitest + Testing Library (jsdom),
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-floating-toc-design.md`

## Global Constraints

- Floating list entries are 13px; its "Table of Contents" header keeps the
  card's 12px. The in-place card is unchanged.
- The list is on screen exactly once: floating aside XOR in-place card.
- Only `PageView` opts in. Sidebar panels and Journal days never float.
- First `{{toc}}` in outline order (pre-order, collapsed subtrees included)
  floats; any other renders its card in place.
- No scroll-spy / active-section highlighting.
- Every new file declares its FCIS pattern; comments ≤ 80 columns, no bean
  ids or line numbers (AGENTS.md).
- Web verification is `cd web && pnpm verify`, not typecheck + unit alone.

## Review Focus

1. The pane crosses the width threshold while the page is open (window
   resize, left nav collapse): float and card swap in one render, never
   both, never neither. → Task 2 hook test, Task 3 swap test.
2. The floating toc block is being edited (focused): the row shows its
   textarea and the floating list stays. → Task 3 test.
3. The `{{toc}}` macro is edited away or the block deleted: the aside goes
   and the outline returns to full width. → Task 3 test.
4. Two `{{toc}}` blocks: the second keeps its card while the first floats.
   → Task 3 test.
5. A contents list taller than the window scrolls inside its column rather
   than being cut off. → Task 4 e2e asserts `overflow-y: auto` and a
   `max-height` on the aside.

---

### Task 1: Functional Core — which toc floats, and whether there is room

**Files:**
- Modify: `web/src/components/tocEntries.ts` (add `firstTocUid`)
- Create: `web/src/components/tocFloat.ts` (`// pattern: Functional Core`)
- Test: `web/src/components/tocEntries.test.ts`,
  `web/src/components/tocFloat.test.ts`

**Interfaces:**
- Produces:
  - `firstTocUid(blocks: BlockNode[]): BlockUid | null` — pre-order walk,
    collapsed subtrees included, first node with `isTocMacro(node.text)`.
  - `FLOATING_TOC_MIN_PANE_PX = 860` — main-pane content-box width needed:
    the 220px column + 32px gap + a ~600px reading column. The CSS in
    Task 3 uses those two numbers; the comment on the constant names
    `.outline-with-toc` as the rule they must match.
  - `tocFloatRoom(sidebarOpen: boolean, paneContentWidth: number): boolean`
    — `!sidebarOpen && paneContentWidth >= FLOATING_TOC_MIN_PANE_PX`.

- [ ] **Step 1: Write the failing tests**

`tocEntries.test.ts`, new `describe("firstTocUid")`:
- `[block("a","x"), block("b","{{toc}}"), block("c","{{[[toc]]}}")]` →
  `uidOf("b")`.
- a toc nested under a collapsed block that precedes a top-level toc:
  `[block("p","parent",{collapsed:true, children:[block("n","{{toc}}")]}),
  block("t","{{toc}}")]` → `uidOf("n")`.
- no toc → `null`; `"see {{toc}}"` → `null`.

`tocFloat.test.ts`:
- `tocFloatRoom(false, 860)` → `true`; `(false, 859)` → `false`;
  `(true, 2000)` → `false`; `(false, 0)` → `false`.

- [ ] **Step 2: Run, expect FAIL** —
  `cd web && pnpm vitest run src/components/tocEntries.test.ts src/components/tocFloat.test.ts`
  (missing exports).
- [ ] **Step 3: Implement** `firstTocUid`, `FLOATING_TOC_MIN_PANE_PX`,
  `tocFloatRoom`.
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit** — `feat(web): core for the floating toc (pkm-uwo5)`

### Task 2: App publishes whether the pane has room

**Files:**
- Modify: `web/src/contexts.ts` (add `TocFloatRoomContext`)
- Create: `web/src/useTocFloatRoom.ts` (`// pattern: Imperative Shell`)
- Modify: `web/src/App.tsx` (call the hook, provide the context around
  `<MainRoutes />` — inside `.main-pane` is enough)
- Test: `web/src/useTocFloatRoom.test.tsx`

**Interfaces:**
- Consumes: `tocFloatRoom` (Task 1).
- Produces:
  - `TocFloatRoomContext = createContext(false)` — doc comment: true when
    the main pane has room for a floating toc and the right sidebar is
    closed; only `EditablePage` with `floatToc` reads it.
  - `useTocFloatRoom(pane: RefObject<HTMLElement | null>, sidebarOpen:
    boolean): boolean` — measures the pane's content-box width
    (`clientWidth` minus computed horizontal padding) on mount, on every
    `ResizeObserver` callback, and when `sidebarOpen` changes; stores only
    the boolean (`useState<boolean>`), so App re-renders only on a flip.
    No `ResizeObserver` (old jsdom paths) → measure once.

- [ ] **Step 1: Write the failing tests** in `useTocFloatRoom.test.tsx`,
  reusing the `FakeResizeObserver` idiom from
  `useHistoryScrollRestore.test.tsx` and stubbing the element's
  `clientWidth` / computed padding:
  - width 1000, padding 50+50 (content 900), sidebar closed → `true`.
  - same, then `rerender` with `sidebarOpen: true` → `false`; back to
    `false` → `true`.
  - content 900 then the stub shrinks to content 800 and
    `FakeResizeObserver.resize()` → `false` (Review Focus 1).
  - a render counter in the harness: three resizes that keep content ≥ 860
    cause no extra harness render.
- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run src/useTocFloatRoom.test.tsx`
- [ ] **Step 3: Implement** the hook and context; wire App:
  `const tocFloatRoom = useTocFloatRoom(mainRef, rightSidebarOpen);` and
  `<TocFloatRoomContext.Provider value={tocFloatRoom}>` around
  `<MainRoutes />`.
- [ ] **Step 4: Run, expect PASS**, then `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(web): App measures room for a floating toc (pkm-uwo5)`

### Task 3: EditablePage floats the toc; TocBlock becomes a marker

**Files:**
- Modify: `web/src/contexts.ts` (add `FloatingTocContext`)
- Modify: `web/src/views/EditablePage.tsx` (`floatToc` prop, layout, aside)
- Modify: `web/src/views/PageView.tsx` (pass `floatToc`)
- Modify: `web/src/components/TableOfContents.tsx` (`TocBlock` marker
  branch; `TableOfContents` gains an optional `className`)
- Modify: `web/src/styles.css` (next to the `{{toc}}` rules)
- Test: `web/src/views/EditablePage.floatingToc.test.tsx`,
  `web/src/components/TableOfContents.test.tsx`

**Interfaces:**
- Consumes: `firstTocUid`, `tocEntries`, `TocFloatRoomContext`.
- Produces:
  - `FloatingTocContext = createContext<BlockUid | null>(null)` — the uid
    of the toc block whose list is floating; read only by `TocBlock`
    (same memo reasoning as `RootBlocksContext`'s comment).
  - `EditablePage` prop `floatToc?: boolean` — doc comment in the style of
    `stamps`: only the main-pane PageView passes it.
  - `TocBlock`: when `useContext(FloatingTocContext) === selfUid`, renders
    `<div className="toc toc-marker"><div className="toc-header">Table of
    Contents</div></div>` instead of the list.
  - Markup when floating: inside EditablePage's container, the tree and
    `<aside className="toc-float"><TableOfContents className="toc-float-card"
    entries={…} /></aside>` share a `<div className="outline-with-toc">`.
    Notices and the drop indicator stay outside that div. Entries come from
    `useMemo(() => tocEntries(outline.blocks, uid), [outline.blocks, uid])`.
    The "Click to start writing…" branch never floats (no blocks, no toc).
  - CSS:
    ```css
    .outline-with-toc { display: grid;
      grid-template-columns: minmax(0, 1fr) 220px; column-gap: 32px; }
    .toc-float { position: sticky; top: 16px; align-self: start;
      max-height: calc(100vh - 32px); overflow-y: auto; }
    .toc-float .toc { display: block; min-width: 0; margin: 0; }
    .toc-float .toc-list { font-size: 13px; }
    .toc-marker { padding-bottom: 10px; }
    .toc-marker .toc-header { margin: 0; }
    ```
    (The marker's exact padding is the builder's call; it must read as the
    card's header alone.)

- [ ] **Step 1: Write the failing tests** in
  `EditablePage.floatingToc.test.tsx` (copy `mount`'s `MemoryRouter` +
  `SyncContext` + `makeSync` setup from `EditablePage.test.tsx`; wrap in
  `TocFloatRoomContext.Provider value={room}`). Page:
  `[block("h","Intro",{heading:1}), block("t","{{toc}}"),
  block("h2","Body",{heading:2})]` (with distinct `order_idx`).
  - `floatToc` + room true → `aside.toc-float` exists and its `a.toc-link`
    texts are `["Intro","Body"]`; the row `[data-uid="t"]` contains
    `.toc-marker` and no `a.toc-link`. Exactly one `nav.toc` on screen.
  - room false → no `aside.toc-float`; row `t` holds the links.
  - room true but no `floatToc` prop → no aside; row `t` holds the links.
  - rerender room true → false → true: after each, exactly one element
    containing `a.toc-link` (Review Focus 1).
  - click the marker row → row `t` shows the textarea; the aside is still
    there with both links (Review Focus 2).
  - focus row `t`, change the text to `notes`, blur → no aside, and
    `.outline-with-toc` is gone (Review Focus 3).
  - two toc blocks (`t` and `t2`) → `t` is the marker, `t2` renders the
    links in place, aside renders them too (Review Focus 4).
  - edit heading `h` to `Introduction`, blur → aside's first link reads
    `Introduction`.

  `TableOfContents.test.tsx`: `TocBlock` under
  `FloatingTocContext.Provider value={uidOf("tuid-self")}` renders
  `.toc-marker` with text `Table of Contents` and no list; under a
  different uid it renders the list.
- [ ] **Step 2: Run, expect FAIL** —
  `pnpm vitest run src/views/EditablePage.floatingToc.test.tsx src/components/TableOfContents.test.tsx`
- [ ] **Step 3: Implement** the context, `TocBlock` branch, `EditablePage`
  layout, `PageView`'s `floatToc`, and the CSS.
- [ ] **Step 4: Run, expect PASS**; then `pnpm test:unit` (coverage gate).
- [ ] **Step 5: Screenshot check** with the `verify` skill on a scratch
  server (port 8975): a page with headings and `{{toc}}` at a wide window
  shows the column at right with 13px entries and the marker in place;
  shift-click a page link to open the sidebar and the card returns.
- [ ] **Step 6: Commit** — `feat(web): float the {{toc}} beside the main page (pkm-uwo5)`

### Task 4: End-to-end spec, docs, gates

**Files:**
- Create: `web/e2e/toc-float.spec.ts` (imports `test` from
  `./ownPage`)
- Modify: `docs/architecture/frontend-rendering.md` (the `{{toc}}`
  sentence in the rendering section)
- Modify: `docs/architecture/styling.md` only if it lists layout rules
  that `.outline-with-toc` / `.toc-float` belong beside
- Modify: `.beans/pkm-uwo5--float-the-toc-on-the-right-of-the-main-page.md`

- [ ] **Step 1: Write the spec** (`test.use({ viewport: { width: 1440,
  height: 900 } })`), using `ownPage`; build the page via the UI as
  `e2e/toc.spec.ts` does (h1 "Intro", `/toc`, enough plain blocks and an h2
  "Later" far down that the page scrolls):
  - `aside.toc-float a.toc-link` has text `["Intro","Later"]`;
    `.toc-marker` is visible; `nav.toc` count is 1.
  - aside computed `overflow-y` is `auto` and `max-height` is not `none`
    (Review Focus 5).
  - scroll the window by 1500px → the aside's `boundingBox().y` stays
    within `[0, 40]` (sticky works: no ancestor clips it).
  - click "Later" in the aside → the "Later" heading row is in the
    viewport.
  - shift-click a page ref on the page to open the sidebar → no
    `aside.toc-float`, the in-place card shows both links; close the panel
    → the aside returns.
  - `page.setViewportSize({ width: 900, height: 900 })` → no aside, card
    in place.
- [ ] **Step 2: Run it alone** — `cd web && E2E_PORT=<free> pnpm e2e e2e/toc-float.spec.ts`
  → PASS; then `pnpm e2e e2e/toc.spec.ts` → PASS (it runs at the default
  1280 width, where the toc may now float; fix its locators if they
  assumed the in-place card).
- [ ] **Step 3: Docs** — invoke `architecture-docs`; in
  `frontend-rendering.md` state that on the main page the first `{{toc}}`
  floats beside the outline when `TocFloatRoomContext` says there is room,
  the row then rendering a marker, so the list appears once; name
  `tocFloatRoom` and `FloatingTocContext` rather than copying the width.
- [ ] **Step 4: Gates** — `cd web && set -o pipefail && pnpm verify`;
  `perf/check.sh frontend` (foreground, long timeout); follow its `next:`
  lines. Not proptest: nothing here touches sync, ops or edit commands.
- [ ] **Step 5: Bean** — tick the checklist, add `## Summary of Changes`,
  set `completed`; create a draft follow-up bean "Highlight the section
  being read in the floating toc".
- [ ] **Step 6: Commit** — `feat(web): e2e and docs for the floating toc (pkm-uwo5)`
