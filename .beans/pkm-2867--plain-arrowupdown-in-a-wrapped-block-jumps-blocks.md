---
# pkm-2867
title: Plain ArrowUp/Down in a wrapped block jumps blocks instead of moving a display line
status: todo
type: bug
priority: low
created_at: 2026-07-22T18:29:27Z
updated_at: 2026-07-22T18:29:27Z
---

keyboardPolicy decides boundary arrows from logical newlines only, so in a block that wraps onto several display lines, plain ArrowUp/Down from any display line jumps focus to the neighbouring block instead of moving the caret one visual line. Fixing needs display-line awareness in the shell (e.g. compare caret rect before/after letting the native move happen, or measure with getClientRects) since the functional core cannot see wrapping. Found during pkm-am54; pre-existing, unchanged there.
