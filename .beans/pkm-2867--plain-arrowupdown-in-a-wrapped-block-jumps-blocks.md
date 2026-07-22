---
# pkm-2867
title: Plain ArrowUp/Down in a wrapped block jumps blocks instead of moving a display line
status: in-progress
type: bug
priority: low
created_at: 2026-07-22T18:29:27Z
updated_at: 2026-07-22T18:55:27Z
---

keyboardPolicy decides boundary arrows from logical newlines only, so in a block that wraps onto several display lines, plain ArrowUp/Down from any display line jumps focus to the neighbouring block instead of moving the caret one visual line. Fixing needs display-line awareness in the shell (e.g. compare caret rect before/after letting the native move happen, or measure with getClientRects) since the functional core cannot see wrapping. Found during pkm-am54; pre-existing, unchanged there.

## Plan

- [ ] TDD: core tests for display-line-gated boundary arrows (new inputs on EditorKeyInput)
- [ ] Core: require first/last display line for plain ArrowUp/Down boundary jump
- [ ] Shell: mirror-div caret display-line measurement (imperative, lazy — only for unmodified ArrowUp/Down)
- [ ] E2E: wrapped block — plain ArrowUp/Down from inner display line stays in block; from edge display line jumps
- [ ] pnpm verify green
