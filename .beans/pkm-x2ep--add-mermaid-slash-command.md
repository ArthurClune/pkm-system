---
# pkm-x2ep
title: Add /mermaid slash command
status: completed
type: feature
priority: normal
created_at: 2026-07-10T18:27:44Z
updated_at: 2026-07-10T18:29:27Z
---

The slash menu has /python, /bash, /javascript code-block commands but no /mermaid, so there is no quick way to insert a mermaid diagram block (pkm-pekk added rendering). Add a Mermaid diagram entry that wraps the block content in a mermaid fence.

- [x] /mermaid entry in SLASH_COMMANDS, applies a ```mermaid fence
- [x] Unit + component tests (unit: match + apply; the pick machinery is shared with /python and already component-tested)
- [x] Web tests and typecheck pass

## Summary of Changes

Added `{ name: "mermaid", label: "Mermaid diagram" }` to SLASH_COMMANDS and extended the fence-wrapping case in applySlashCommand so /mermaid wraps the block content in a ```mermaid fence (cursor inside), which MermaidDiagram (pkm-pekk) then renders in read mode. 343 web tests + typecheck green.
