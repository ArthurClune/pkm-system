---
# pkm-j3uw
title: visibleUids treats a collapsed Roam table's cells as hidden
status: todo
type: bug
priority: normal
created_at: 2026-10-05T11:01:51Z
updated_at: 2026-10-05T11:06:23Z
---

tree.ts visibleUids skips the children of every collapsed block, but the renderer (EditableBlockTree) shows the cells of a valid Roam {{table}} block even when it is collapsed (imported tables are collapsed). So keyboard navigation and selection ranges that read visibleUids disagree with what is on screen inside tables. Pre-existing; found in review of the restored-focus fix on feat/pkm-f7zv-outline-props, which introduced a shared 'hides its children' predicate that visibleUids could adopt.


Also: web/src/props/outline/reading.ts readingRows' `hidden` has the same mismatch (harmless while sequenceArb draws no table macros). tree.ts hidesChildren is the shared predicate to adopt.
