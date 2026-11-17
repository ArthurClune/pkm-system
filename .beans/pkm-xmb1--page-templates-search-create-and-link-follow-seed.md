---
# pkm-xmb1
title: 'Page templates: search create and link-follow seed the template'
status: in-progress
type: feature
created_at: 2026-11-17T19:19:04Z
updated_at: 2026-11-17T19:19:04Z
---

Creating a Paper/ or Book/ page from search's "Create page" left it empty: the template went in only on "Click to start writing…", so blocks dropped onto the new page arrived with no Tags::/URL::/Date:: attributes. Search create and following a [[link]] (click or Ctrl-O) to an empty templated page now seed the template on arrival.

## Checklist
- [ ] EditablePage seedTemplate + marker helpers
- [ ] Main-view triggers: search create, link click, Ctrl-O (+ e2e)
- [ ] Sidebar triggers: shift-click, Ctrl-Shift-O
- [ ] frontend-editor.md, pnpm verify, perf frontend
