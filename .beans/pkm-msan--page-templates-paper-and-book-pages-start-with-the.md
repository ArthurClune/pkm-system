---
# pkm-msan
title: 'Page templates: Paper/ and Book/ pages start with their attribute blocks'
status: completed
type: feature
priority: normal
created_at: 2026-11-15T14:23:22Z
updated_at: 2026-11-15T14:54:37Z
---

Clicking 'Click to start writing…' on an empty Paper/ or Book/ page seeds the attribute blocks from a markdown template in web/src/templates/, so those pages share one consistent layout.


## Checklist
- [x] Template files + pure parser/picker (web/src/templates)
- [x] createFirstBlock seeds the template
- [x] e2e spec + frontend-editor.md
- [x] pnpm verify, proptest web, perf frontend


## Summary of Changes
"Click to start writing…" on an empty Paper/ or Book/ page now seeds that namespace's attribute blocks (Tags:: first, #Paper/#Book pre-filled) in one undoable step, caret at the end of Tags::. Templates are markdown files in web/src/templates/ (file name = namespace), parsed by templates/pageTemplates.ts and bundled by templates/load.ts. Rule stated in docs/architecture/frontend-editor.md § Page templates. initialEntryBytes raised to 495200.

Deferred (not fixed): if another device deletes the page while this one seeds it, the non-blank seeds land as conflict entries on today's journal; a template can't contain an intentionally empty block; any .md in web/src/templates/ is treated as a template.
