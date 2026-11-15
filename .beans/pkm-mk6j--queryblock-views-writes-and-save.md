---
# pkm-mk6j
title: QueryBlock views, writes and Save
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T19:40:06Z
parent: pkm-l79g
---

Task 12 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

A {{query}} block now shows its records as a table (the default when any record has :: lines), cards, or the grouped blocks it showed before. A filter box, header sort, column menus (hide, add, move), and Reset / "Save this view" sit above the results, with the count "N of M results". Table cells write back to the record's page through the op queue, scoped ["page", page_title]. A write shows at once in an open copy of that page through applyLocal, patches the local record once it has persisted, and leaves a notice whose Undo sends the inverse captured at write time.

- QueryBlock.tsx is an eager shell. It lazy-loads QueryResults.tsx, so the table code stays out of the entry chunk.
- The macro-option writers moved to grammar/macroOptionsWrite.ts, so the tokenizer no longer pulls them into the entry chunk.
- OutlineHandlers.onSetText(uid, text) runs through useOutline.run and records undo history.
- BlockEditApi gains text, setText and editAsText.
- Query results get a null BlockEditContext, so a TODO or nested query inside them never acts on the host block.
- Save finds its macro again in the host block's own text (planQuerySave), refuses when the macro cannot be found exactly once, and refuses when the rewritten options would not read back as written.

Cmd-Z is not wired. pkm-nny4 says why: undoManager navigates to the record's page, and the notice's Undo cannot take its history entry off the stack.

Rules are in docs/architecture/frontend-rendering.md § Segment dispatch and § Lazy renderers and their caches.
