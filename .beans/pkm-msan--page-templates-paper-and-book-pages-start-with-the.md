---
# pkm-msan
title: 'Page templates: Paper/ and Book/ pages start with their attribute blocks'
status: in-progress
type: feature
priority: normal
created_at: 2026-11-15T14:23:22Z
updated_at: 2026-11-15T14:31:42Z
---

Clicking 'Click to start writing…' on an empty Paper/ or Book/ page seeds the attribute blocks from a markdown template in web/src/templates/, so those pages share one consistent layout.


## Checklist
- [ ] Template files + pure parser/picker (web/src/templates)
- [ ] createFirstBlock seeds the template
- [ ] e2e spec + frontend-editor.md
- [ ] pnpm verify, proptest web, perf frontend
