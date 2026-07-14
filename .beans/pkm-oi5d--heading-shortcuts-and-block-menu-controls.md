---
# pkm-oi5d
title: Heading shortcuts and block-menu controls
status: completed
type: feature
priority: normal
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-14T15:05:23Z
---

Blocks already store and render heading levels 1-3, and pkm-kiip added the `set_heading` op plus slash commands. Add faster keyboard and context-menu controls for new and imported blocks.

## Acceptance Criteria

- [x] Ctrl-Alt-1, Ctrl-Alt-2, and Ctrl-Alt-3 set the focused block to heading levels 1, 2, and 3 respectively.
- [x] Ctrl-Alt-0 sets the focused block to plain text (`heading: null`).
- [x] Shortcuts work while editing a newly created block and when focusing an imported/existing block.
- [x] The block right-click menu includes controls for Plain text, Heading 1, Heading 2, and Heading 3.
- [x] Menu choices and shortcuts dispatch the existing `set_heading` operation and update optimistically without changing block text.
- [x] The current heading level is indicated in the menu.
- [x] Tests cover all four shortcuts, menu actions, optimistic rendering, persistence, and remote updates.

## Summary of Changes

Added Ctrl-Alt-0/1/2/3 shortcuts using physical digit codes so Alt-modified keyboard glyphs still work, plus accessible checked block-menu controls for Plain text and Heading 1-3. Both paths dispatch the existing `set_heading` operation without changing draft text; read-only outlines disable mutations. Tests cover all shortcuts, physical-key behavior, menu state and actions, read-only behavior, optimistic application, persistence, and remote updates.
