# Page Templates on Create and Link-Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search's "Create page" and following a `[[link]]`/`#tag` (click,
shift-click, Ctrl-O, Ctrl-Shift-O) to an empty Paper/ or Book/ page seed its
template on arrival.

**Architecture:** The navigation carries a one-time marker (router state for
the main view, a field on the sidebar stack entry for a panel).
`EditablePage` takes `seedTemplate`; once it owns an editable outline that is
empty and the title has a template, it calls the existing
`useOutline.createFirstBlock`, then reports back so the host drops the marker.

**Tech Stack:** React 19, react-router 7, vitest + Testing Library,
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-template-on-create-design.md`

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.worktrees/template-on-create`
  (branch `feat/template-on-create`). Never touch the main checkout.
- No page is written by opening it any other way (sidebar list, history,
  back/forward, bookmark, reload); a page with blocks never gets a template.
- Seeding goes through `createFirstBlock` only: caret at the end of the first
  block, one undo removes the template.
- Verification is `cd web && pnpm verify`, never typecheck + unit alone.
- Comment rules from AGENTS.md (no bean ids, ≤80 cols in comments).

## Review Focus

1. Reload after seeding then undoing: the page must stay empty (marker
   consumed). Pinned in Task 2's e2e.
2. Following a link to a Paper/ page that already has blocks: nothing is
   written. Pinned in Task 1 (`seedTemplate` on a filled page).
3. Marker arrives while the outline is read-only (socket not connected):
   no seed until editable, then exactly one. Pinned in Task 1.
4. Hiding and re-showing the sidebar remounts panels: a consumed panel
   marker must not seed again. Pinned in Task 3.
5. A non-template title followed by link: no state is attached, so no
   replace navigation happens. Pinned in Task 2 (`PageLink` state test).

---

### Task 1: `seedTemplate` on EditablePage, and the marker helpers

**Files:**
- Modify: `web/src/templates/pageTemplates.ts`
- Modify: `web/src/views/EditablePage.tsx`
- Test: `web/src/templates/pageTemplates.test.ts`,
  `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Produces (in `pageTemplates.ts`, Functional Core):
  - `templateFor(title: RawTitle, templates: PageTemplates): readonly string[] | null`
    — the namespace lookup `firstBlockTexts` does today; `firstBlockTexts`
    becomes `templateFor(title, templates) ?? [""]`.
  - `type SeedTemplateState = { readonly seedTemplate: true }`
  - `seedTemplateState(title: RawTitle, templates: PageTemplates): SeedTemplateState | undefined`
    — the marker, only for a title with a template.
  - `wantsTemplateSeed(state: unknown): boolean` — true only for an object
    whose `seedTemplate` is `true` (router state is `unknown`).
- Produces (`EditablePage` props): `seedTemplate?: boolean`,
  `onSeedTemplateHandled?: () => void`.

- [ ] **Step 1: Failing tests in `pageTemplates.test.ts`**
  - `templateFor` returns the Paper texts for `rawTitleOf("Paper/x")`, null
    for `"Papers/x"`, `"paper/x"`, `"Paper"`.
  - `seedTemplateState(rawTitleOf("Book/y"), t)` equals
    `{ seedTemplate: true }`; for `"Page"` it is `undefined`.
  - `wantsTemplateSeed` is true for `{ seedTemplate: true }`, false for
    `null`, `undefined`, `"x"`, `{}`, `{ seedTemplate: "yes" }`.
  - Existing `firstBlockTexts` cases still pass unchanged.

- [ ] **Step 2: Failing tests in `EditablePage.test.tsx`** (extend `mount`
  with `seedTemplate` and `onSeedTemplateHandled` arguments):
  - `"seedTemplate on an empty Paper/ page seeds the template once"`: mount
    `[]`, `"Paper/X"`, `seedTemplate: true` → `sync.sent` has one batch
    whose create texts are the four Paper lines (same assertion as the
    existing start-writing test), the textbox holds `"Tags:: #Paper"` with
    `selectionStart` at its end, and `onSeedTemplateHandled` was called once.
    A rerender with the same props sends nothing more.
  - `"seedTemplate on a page with blocks writes nothing"`: default blocks,
    `"Paper/X"`, `seedTemplate: true` → `sync.sent` empty, handler called.
  - `"seedTemplate on a title without a template writes nothing"`: `[]`,
    `"Page"` → `sync.sent` empty, start-writing button still shown,
    handler called.
  - `"seedTemplate waits for an editable outline"`: `makeSync("connecting")`,
    `[]`, `"Paper/X"` → nothing sent and handler not called; switch the sync
    to connected (as the existing read-only tests do) → one batch, handler
    called once.

- [ ] **Step 3: Run** `cd web && pnpm vitest run src/templates src/views/EditablePage.test.tsx`
  — expected: the new tests fail (missing exports/props).

- [ ] **Step 4: Implement** the helpers, then in `EditablePage` one effect
  keyed on `seedTemplate`, `ownsEditor`, `outline.readOnly`: when all allow
  and a ref says it has not run for this mount, set the ref, call
  `outline.createFirstBlock()` if `outline.blocks.length === 0` and
  `templateFor(title, PAGE_TEMPLATES) !== null`, then
  `onSeedTemplateHandled?.()`. Read blocks through the existing
  `blocksRef` so the effect does not re-run on every edit.

- [ ] **Step 5: Run** the Step 3 command — expected: PASS.

- [ ] **Step 6: Commit** `web: EditablePage seeds a template when the
  navigation asks (pkm-xmb1)`.

### Task 2: Main-view triggers (search create, link click, Ctrl-O)

**Files:**
- Modify: `web/src/views/PageView.tsx`, `web/src/components/SearchBar.tsx`,
  `web/src/components/PageLink.tsx`, `web/src/components/BlockInput.tsx`
- Test: `web/src/components/SearchBar.test.tsx`,
  `web/src/components/PageLink.test.tsx`,
  `web/src/components/BlockInput.test.tsx`,
  `web/src/views/PageView.test.tsx`, `web/e2e/page-template.spec.ts`

**Interfaces:**
- Consumes: `seedTemplateState`, `wantsTemplateSeed`, `PAGE_TEMPLATES`
  (`templates/load.ts`), the `EditablePage` props from Task 1.

- [ ] **Step 1: Failing unit tests.** In each, the route element is a probe
  that renders `JSON.stringify(useLocation().state)`.
  - SearchBar: creating `"Paper/new"` lands with state
    `{"seedTemplate":true}`; creating `"papers"` lands with no state
    (`undefined` → probe renders nothing / `"undefined"`, match whichever the
    probe prints).
  - PageLink: clicking a link to `"Paper/x"` lands with
    `{"seedTemplate":true}`; to `"Machine Learning"` with no state.
  - BlockInput: Ctrl-O inside `[[Paper/World]]` lands with
    `{"seedTemplate":true}` (copy the existing Ctrl-O test's setup with that
    text).
  - PageView: a payload for an empty `"Paper/X"` page opened with state
    `{ seedTemplate: true }` sends the template batch and afterwards
    `useLocation().state` is null/undefined with the same pathname; opened
    without state, it sends nothing.

- [ ] **Step 2: Failing e2e in `page-template.spec.ts`** (both delete the
  pages they create in `finally`/`afterEach`, via
  `page.request.delete("/api/page/<encoded>")`):
  - `"search create seeds a Paper/ page"`: log in via `ownPage`; open search
    (Ctrl-U), type a unique `Paper/e2e search <timestamp>` title, choose the
    `Create page` row; expect `.attribute` texts
    `["Tags", "URL", "Date", "Local copy"]`;
    `waitForServerText(page, title, "Local copy:: ")`. Then press
    Escape, undo (Cmd/Ctrl-Z as the existing undo specs do), wait until the
    server has no blocks for the page, `page.reload()`, and expect
    "Click to start writing…" to be visible (marker consumed).
  - `"following a link seeds a Paper/ page"`: on the `ownPage` page, type
    `[[Paper/e2e link <timestamp>]]` into the first block, Escape, click the
    rendered link; expect the four attributes and
    `waitForServerText(page, linked, "Tags:: #Paper")`.

- [ ] **Step 3: Run** `cd web && pnpm vitest run src/components/SearchBar.test.tsx src/components/PageLink.test.tsx src/components/BlockInput.test.tsx src/views/PageView.test.tsx`
  — expected: new tests FAIL.

- [ ] **Step 4: Implement.**
  - SearchBar's create row:
    `navigate(pagePath(row.title), { state: seedTemplateState(row.title, PAGE_TEMPLATES) })`.
  - PageLink: `<Link state={seedTemplateState(title, PAGE_TEMPLATES)}>`.
  - BlockInput `ensureRefPageThenOpen`'s main-view branch: same `state`.
  - PageView: pass `seedTemplate={wantsTemplateSeed(state)}` and an
    `onSeedTemplateHandled` that does
    `navigate({ pathname, search, hash }, { replace: true })`, so the
    entry's state is gone for reloads and back/forward.

- [ ] **Step 5: Run** the Step 3 command — PASS; then
  `cd web && E2E_PORT=8975 pnpm e2e page-template` — PASS.

- [ ] **Step 6: Commit** `web: search create, link clicks and Ctrl-O seed a
  page's template (pkm-xmb1)`.

### Task 3: Sidebar triggers (shift-click, Ctrl-Shift-O)

**Files:**
- Modify: `web/src/contexts.ts`, `web/src/App.tsx`,
  `web/src/components/SidebarPanel.tsx`,
  `web/src/components/EditableSidebarPanel.tsx`,
  `web/src/components/PageLink.tsx`, `web/src/components/BlockInput.tsx`
- Test: `web/src/components/PageLink.test.tsx`,
  `web/src/components/BlockInput.test.tsx`,
  `web/src/components/EditableSidebarPanel.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Produces: `SidebarApi.openInSidebar(title: RawTitle, uid?: BlockUid, seed?: SeedTemplateState): void`;
  `SidebarEntry.seed?: SeedTemplateState`; `SidebarPanel` and
  `EditableSidebarPanel` take `seedTemplate?: boolean` and
  `onSeedTemplateHandled?: () => void`, passed through to `EditablePage`.

- [ ] **Step 1: Failing tests.**
  - PageLink: shift-click on `"Paper/x"` calls `openInSidebar` with
    `(title, undefined, { seedTemplate: true })`; on `"Machine Learning"`
    with `(title, undefined, undefined)`.
  - BlockInput: Ctrl-Shift-O inside `[[Paper/World]]` calls
    `openInSidebar` with that marker.
  - EditableSidebarPanel: an empty `"Paper/X"` payload with
    `seedTemplate` sends the template batch and calls the handler.
  - App: open a `Paper/` panel with the marker over an empty page → one
    template batch; hide and re-show the sidebar (the existing hide
    control) → no second batch.

- [ ] **Step 2: Run** `cd web && pnpm vitest run src/components/PageLink.test.tsx src/components/BlockInput.test.tsx src/components/EditableSidebarPanel.test.tsx src/App.test.tsx`
  — expected: FAIL.

- [ ] **Step 3: Implement.** `openInSidebar` stores `seed` on the new
  entry; App renders `SidebarPanel` with `seedTemplate={entry.seed !== undefined}`
  and an `onSeedTemplateHandled` that clears `seed` on that entry id in
  `setStack`. PageLink's shift-click and Ctrl-Shift-O pass
  `seedTemplateState(title, PAGE_TEMPLATES)`.

- [ ] **Step 4: Run** the Step 2 command — PASS.

- [ ] **Step 5: Commit** `web: sidebar opens from a link seed a page's
  template (pkm-xmb1)`.

### Task 4: Docs, full verification, bean

**Files:**
- Modify: `docs/architecture/frontend-editor.md` § Page templates (via the
  `architecture-docs` skill),
  `.beans/pkm-xmb1--page-templates-search-create-and-link-follow-seed.md`

- [ ] **Step 1:** Rewrite § Page templates: seeding happens on the click,
  or on arrival from search create or a link-follow carrying the marker
  (`seedTemplateState`); the marker is consumed (router `replace`, or the
  sidebar entry's `seed` cleared) so reload and back/forward never seed;
  only an editable, empty outline of a templated title seeds. Keep the
  reason: opening a page by any other route must not write.
- [ ] **Step 2:** `cd web && set -o pipefail && pnpm verify` — exit 0.
- [ ] **Step 3:** `perf/check.sh frontend` (entry bytes may move); follow
  its `next:` lines.
- [ ] **Step 4:** Bean: check off its checklist, add `## Summary of
  Changes` naming the symptom ("Paper/ page created from search had no
  Tags::/URL::/Date:: attributes"), cause, and doc section; set
  `completed`. Commit docs + bean.
