---
# pkm-pekk
title: Support mermaid diagrams
status: todo
type: feature
created_at: 2026-07-10T17:50:54Z
updated_at: 2026-07-10T17:50:54Z
---

Add support for rendering mermaid diagrams in pages.

## Notes
- A fenced code block with language `mermaid` should render as a diagram
- Consider render-on-view (read mode) vs raw text while editing
- Handle invalid mermaid syntax gracefully (show error or fall back to raw text)

## Acceptance criteria
- [ ] ```mermaid fenced blocks render as diagrams
- [ ] Invalid diagram source degrades gracefully
- [ ] Editing experience unaffected (raw text editable)
- [ ] Web tests and typecheck pass
