---
# pkm-6phf
title: Web frontend hardening from recent-change review
status: todo
type: epic
priority: high
created_at: 2026-07-31T15:32:12Z
updated_at: 2026-07-31T15:32:12Z
---

## Context

A read-only review of `web/` after substantial recent churn was performed with five parallel review tracks: React views/components, editor/outline, sync/replica/API, styling/accessibility, and cross-cutting architecture. The strongest findings were checked against the current source and existing tests. No implementation changes were made and the full web verification suite was not run as part of the review.

This epic records the confirmed correctness, accessibility, duplication, over-generalisation, style, and complexity findings. Split independent items into child bugs/tasks before implementation where useful.

## High-priority findings

### 1. Preserve ordering and offline edits when local op persistence fails

**References:** `web/src/sync/opQueue.ts:437-463`

When `replica.enqueue()` fails because of quota, OPFS access-handle contention, or SAH pool exhaustion, the queue posts the operation directly with `postOps()`. This bypasses offline state, retry/backoff, recovery barriers, and older durable batches. Offline failure leaves the operation neither persisted nor retryable; online delivery can overtake dependent operations.

**Direction:** Add an ordered in-memory fallback lane governed by the existing connectivity, retry, and recovery policy. Freeze or clearly degrade editing when local durability is unavailable, and retain operations until delivery or an explicit discard decision.

- [ ] Add regression tests for offline persistence failure and ordering behind older durable batches
- [ ] Implement ordered fallback delivery without bypassing queue policy

### 2. Prevent New chat from racing an active assistant turn

**References:** `web/src/assistant/useAssistant.ts:132-178,212-227`; `web/src/assistant/AssistantPanel.tsx:100-102`

`newChat()` clears state and the conversation ID without aborting or superseding the active stream. Old SSE events and finalizers can repopulate the new transcript, clear a newer abort controller, reset a newer turn to idle, or overwrite confirmation state.

**Direction:** Give each turn a generation/token and ignore updates from superseded turns. Abort and await the active turn before resetting, and identity-check abort-controller cleanup. Alternatively, disable New chat until Stop has completed.

- [ ] Add active-turn/new-chat race tests
- [ ] Make turn cleanup generation- and controller-safe

### 3. Block deletion of read-only multi-block selections

**References:** `web/src/components/EditableBlockTree.tsx:149-180`

Movement and indentation check `readOnly`, but Backspace/Delete unconditionally invokes `onDeleteBlockSelection()`. A selection created while editable can still be destroyed after synchronization changes the outline to read-only.

**Direction:** Gate selection deletion on `!readOnly` and test the editable-to-read-only transition.

- [ ] Add a read-only transition regression test
- [ ] Gate destructive selection handling

### 4. Remove closed mobile navigation from the keyboard focus order

**References:** `web/src/styles.css:698-706`; `web/src/App.tsx:128-173`

The closed phone navigation is hidden only with `transform: translateX(-100%)`; descendants remain tabbable off-screen. The hamburger also lacks `aria-expanded` and `aria-controls`.

**Direction:** Apply `inert` or `visibility:hidden` while closed, restore visibility for `.open`, add expanded/control semantics, and manage focus restoration.

- [ ] Add mobile keyboard-order and focus-restoration coverage
- [ ] Make closed navigation inert and expose correct ARIA state

### 5. Make clickable headings keyboard-accessible

**References:** `web/src/components/PageTitle.tsx:62-67`; `web/src/components/UnlinkedSection.tsx:127-130`

Page-title editing and Unlinked References expansion use `onClick` on non-focusable headings, leaving those interactions unavailable from the keyboard.

**Direction:** Prefer semantic buttons inside the heading structure, including `aria-expanded` for collapsible content, with themed `:focus-visible` styling.

- [ ] Add keyboard interaction tests for title editing and Unlinked References
- [ ] Replace mouse-only heading interactions with semantic controls

## Medium-priority findings

### 6. Consolidate duplicated outline page-loading controllers

**References:** `web/src/views/PageView.tsx:46-139`; `web/src/components/EditableSidebarPanel.tsx:40-105`

Both modules independently coordinate request generations, `ReadToken`, `ParentReadiness`, cancellation, session acceptance, loader/controller registration, errors, and cleanup. They already differ: `PageView` treats missing daily pages as editable empty pages while the sidebar reports an error for the same page.

**Direction:** Extract one shell-level outline-loading controller/hook with an explicit missing-page policy. Keep main-pane/sidebar differences limited to presentation and scoped scrolling.

- [ ] Specify shared loading lifecycle and daily-page behavior
- [ ] Add parity tests for main-pane and sidebar daily pages
- [ ] Replace the duplicate controllers

### 7. Guard Files pagination and select-all against stale filters

**References:** `web/src/views/Files.tsx:100-164`

`reload()` has a generation guard, but `loadMore()` and `selectAll()` do not. Responses started before a filter change or refresh can mix result sets, overwrite totals, and select files outside the visible filters.

**Direction:** Guard every list operation with the same generation/query key or cancellation mechanism.

- [ ] Add in-flight pagination/select-all filter-change tests
- [ ] Centralize request-generation handling for all Files list operations

### 8. Reset and generation-guard PdfViewer when `href` changes

**References:** `web/src/components/PdfViewer.tsx:147-215`; `web/src/components/InlineSegments.tsx:52-54`

`failed`, document metadata, expansion, and current-page state are retained when `href` changes. A slow `getPage(1)` from the previous PDF can overwrite metadata for the new document.

**Direction:** Reset viewer state in an effect keyed by `href`, and generation-guard both document load and page metadata callbacks.

- [ ] Add rerender and old-document completion race tests
- [ ] Reset and guard per-document state

### 9. Share autocomplete state handling and track the live caret

**References:** `web/src/components/Composer.tsx:15-54`; `web/src/components/EditableBlockTree.tsx:397-399,558-618,786-792`

Both editors update caret and autocomplete context only from `onChange`. Mouse clicks and selection-only caret movement can leave an old completion active, allowing Enter/Tab to edit the wrong location or consume an intended newline.

**Direction:** Recompute on selection changes or derive completion context from the textarea's live selection when executing a pick. Prefer a shared autocomplete-controller hook.

- [ ] Add selection-only caret movement tests in both editors
- [ ] Implement shared/live autocomplete context handling

### 10. Stop autocomplete from consuming modified shortcuts

**References:** `web/src/outline/keyboardPolicy.ts:110-121`; `web/src/components/Composer.tsx:48-54`

The editor policy says autocomplete owns unmodified arrows/Enter/Tab/Escape, but Cmd/Ctrl/Shift variants are not rejected. Modified keys can navigate or pick autocomplete instead of performing native selection/navigation or editor commands. Composer duplicates the same modifier-insensitive behavior.

**Direction:** Explicitly validate the allowed modifier set and reuse one keyboard policy in both editors.

- [ ] Add modifier-combination tests
- [ ] Enforce unmodified autocomplete commands through a shared policy

### 11. Make generated OpenAPI types enforce the API boundary

**References:** `web/src/api/client.ts:69-108`; `web/src/replica/localApi/router.ts:24-27`; `web/src/replica/localApi/tree.ts:24-35`; `web/src/replica/localApi/pages.ts:91-116`; `web/src/replica/localApi/search.ts:9-24`; `web/src/components/PageTitle.tsx:14-17`; `web/src/api/types.d.ts:1590-1605`

Callers choose `apiFetch<T>` independently of the URL and method, while offline gateway bodies are `unknown` cast to `T`. TypeScript cannot detect online/offline response drift, an obsolete caller type, or an incorrect request body/method. Several local and component models duplicate generated server shapes.

**Direction:** Build a path/method-aware client from generated OpenAPI `paths`. Give local response builders explicit generated return types, add a concrete rename response model server-side, regenerate the schema, and remove handwritten duplicates.

- [ ] Design a path/method-aware API client without weakening local gateway support
- [ ] Type local API response builders with generated models
- [ ] Replace handwritten duplicate response types

### 12. Simplify the oversized, directionally inverted editor boundary

**References:** `web/src/outline/useOutline.ts:10,38-52`; `web/src/components/EditableBlockTree.tsx:36-91,147-201,390-801`

The outline engine imports its roughly 30-callback command interface from a UI component. `EditableBlockTree` defines the engine's port while `BlockInput` combines draft adoption, IME state, autocomplete, uploads, date picking, navigation, paste arming, and keyboard execution. Selection keyboard policy also remains ad hoc in the component despite the separate keyboard-policy core.

**Direction:** Move the editor command/port type into `outline/`, consider a discriminated command dispatcher plus a small set of imperative capabilities, extract the input shell/controller, and move selection decisions into the shared keyboard policy.

- [ ] Define the intended editor dependency direction and command boundary
- [ ] Extract cohesive input/session responsibilities without creating speculative abstractions
- [ ] Move remaining keyboard decisions into the functional core

### 13. Centralize route labels, browser titles, and actions

**References:** `web/src/components/TopBar.tsx:20-29`; `web/src/App.tsx:179-187`; title effects in `web/src/views/CurrentWork.tsx`, `Journal.tsx`, `Files.tsx`, `Help.tsx`, `Settings.tsx`, and `PageView.tsx`

Route declarations, top-bar labels, browser titles, and page-action recognition are maintained separately. `/files` and `/settings` already exist in the router but have no top-bar labels.

**Direction:** Define route metadata once and consume it from routing, TopBar, and one route-aware title effect, retaining dynamic page-title resolution for `/page/*`.

- [ ] Add route metadata consistency coverage
- [ ] Consolidate static route labels/titles/actions

### 14. Keep focused search inside narrow phone viewports

**References:** `web/src/styles.css:400-407,698-710`; `web/src/components/SearchBar.tsx:184-196`; `web/src/components/TopBar.tsx:80-114`

Focus forces a fixed `320px` search width. With the other top-bar controls present, the input extends left of 320px and 390px viewports.

**Direction:** At the phone breakpoint, cap expansion to available space, allow the field to shrink, and retain a visible themed focus ring.

- [ ] Add 320px and 390px page-route geometry tests
- [ ] Make focused width responsive

## Lower-priority cleanup

### 15. Remove or adopt production-dead compatibility implementations

**References:** `web/src/components/BlockTree.tsx:14-88`; `web/src/outline/activeOutlines.ts:1-19`

Both parallel active implementations while apparently being imported only by tests, increasing drift risk without serving runtime code.

- [ ] Confirm runtime call sites
- [ ] Remove the compatibility paths and migrate tests, or deliberately make them shared runtime implementations

### 16. Fix Files note selector mismatch

**References:** `web/src/styles.css:503`; `web/src/views/Files.tsx:214-216,296-302`

Only `.settings-section p.settings-note` is defined, but Files applies `settings-note` outside `.settings-section`, so the class has no effect there.

- [ ] Promote the note style to a shared selector or add a Files-specific class
- [ ] Add selector-usage coverage

### 17. Style disabled danger buttons consistently

**References:** `web/src/styles.css:218-225`; `web/src/views/Files.tsx:281-283`

`.btn-danger` retains pointer and hover styling while disabled, unlike `.btn-secondary`.

- [ ] Add disabled danger-button styling and guard hover with `:not(:disabled)`
- [ ] Add stylesheet/component coverage

## Verification and documentation

- [ ] Use test-driven development for each behavior change
- [ ] Run `cd web && pnpm verify`
- [ ] Review and update `docs/architecture/frontend.md` for route metadata, API typing, editor boundaries, loading-controller, control-class, or stylesheet invariant changes
- [ ] Split independent work into child beans where implementation should proceed separately
