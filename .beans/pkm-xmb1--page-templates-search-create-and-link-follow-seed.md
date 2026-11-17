---
# pkm-xmb1
title: 'Page templates: search create and link-follow seed the template'
status: completed
type: feature
priority: normal
created_at: 2026-11-17T19:19:04Z
updated_at: 2026-11-17T19:58:27Z
---

Creating a Paper/ or Book/ page from search's "Create page" left it empty: the template went in only on "Click to start writing…", so blocks dropped onto the new page arrived with no Tags::/URL::/Date:: attributes. Search create and following a [[link]] (click or Ctrl-O) to an empty templated page now seed the template on arrival.

## Checklist
- [x] EditablePage seedTemplate + marker helpers
- [x] Main-view triggers: search create, link click, Ctrl-O (+ e2e)
- [x] Sidebar triggers: shift-click, Ctrl-Shift-O
- [x] frontend-editor.md, pnpm verify, perf frontend

## Summary of Changes
Symptom: a Paper/ page created from search's "Create page" stayed empty, so blocks dragged onto it arrived without the Tags::/URL::/Date:: attributes. Cause: the template was seeded only by clicking "Click to start writing…".

Search create, a page link or tag click, Ctrl-O, shift-click and Ctrl-Shift-O now carry a one-time marker (`seedTemplateState`: router state, or the sidebar entry's `seed`). `EditablePage` acts on `seedTemplate` once its outline is editable, seeding through `createFirstBlock` only if the page is empty and has a template, then drops the marker (`PageView` replaces the history entry; `App` clears the entry's `seed`), so reload, back/forward and a re-shown sidebar never seed. Rule in docs/architecture/frontend-editor.md § Page templates. initialEntryBytes raised to 506800.
