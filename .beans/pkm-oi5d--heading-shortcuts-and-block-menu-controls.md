---
# pkm-oi5d
title: Heading shortcuts and block-menu controls
status: in-progress
type: feature
priority: normal
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-14T14:24:19Z
---

Blocks already store and render heading levels 1-3, and pkm-kiip added the `set_heading` op plus slash commands. Add faster keyboard and context-menu controls for new and imported blocks.

## Acceptance Criteria

- [ ] `Ctrl-Alt-1`, `Ctrl-Alt-2`, and `Ctrl-Alt-3` set the focused block to heading levels 1, 2, and 3 respectively.
- [ ] `Ctrl-Alt-0` sets the focused block to plain text (`heading: null`).
- [ ] Shortcuts work while editing a newly created block and when focusing an imported/existing block.
- [ ] The block right-click menu includes controls for Plain text, Heading 1, Heading 2, and Heading 3.
- [ ] Menu choices and shortcuts dispatch the existing `set_heading` operation and update optimistically without changing block text.
- [ ] The current heading level is indicated in the menu.
- [ ] Tests cover all four shortcuts, menu actions, optimistic rendering, persistence, and remote updates.
