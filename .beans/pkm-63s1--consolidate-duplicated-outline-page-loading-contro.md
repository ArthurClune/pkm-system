---
# pkm-63s1
title: Consolidate duplicated outline page-loading controllers
status: todo
type: task
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T13:20:53Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 6.

**References:** web/src/views/PageView.tsx:46-139; web/src/components/EditableSidebarPanel.tsx:40-105

Both modules independently coordinate request generations, ReadToken, ParentReadiness, cancellation, session acceptance, loader/controller registration, errors, and cleanup. They already differ: PageView treats missing daily pages as editable empty pages while the sidebar reports an error for the same page.

**Direction:** Extract one shell-level outline-loading controller/hook with an explicit missing-page policy. Keep main-pane/sidebar differences limited to presentation and scoped scrolling.

- [ ] Specify shared loading lifecycle and daily-page behavior
- [ ] Add parity tests for main-pane and sidebar daily pages
- [ ] Replace the duplicate controllers
