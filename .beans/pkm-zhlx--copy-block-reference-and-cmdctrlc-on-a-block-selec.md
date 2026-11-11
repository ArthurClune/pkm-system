---
# pkm-zhlx
title: Copy block reference and Cmd/Ctrl+C on a block selection show nothing when the copy fails
status: completed
type: bug
priority: normal
created_at: 2026-11-11T09:51:07Z
updated_at: 2026-11-11T14:02:06Z
parent: pkm-4gda
---

Found by the 2026-11-11 docs re-check. In web/src/components/EditableBlockTree.tsx the block menu's Copy block reference and the Cmd/Ctrl+C handler for a block selection call copyText and ignore a false result, so a failed clipboard write is silent. Files and DroppedDraftNotice show the text to copy by hand instead. frontend.md § Popovers and menus names which callers do which. Decide whether these two should show a notice (the outline notice slot) and add a test per caller.
