---
# pkm-v3ub
title: Typing a link to a title with a forbidden character loses the draft
status: completed
type: bug
priority: normal
created_at: 2026-10-25T15:23:08Z
updated_at: 2026-10-29T11:28:58Z
---

Found by the pkm-ax2j planner (2026-10-25), not yet reproduced. The editor does not pre-check link titles for characters the server's title rules refuse: a typed [[a#b]] is refused when the queue judges it, the outline resets to the server's copy, and the draft text is lost. The editor already refuses depth, text-limit and (pkm-ax2j) title-length violations up front with a notice; forbidden title characters should take the same path.

- [x] Reproduce (unit test in useOutline or an e2e typing [[a#b]]): confirmed lost, the block reset with "Server rejected a change"
- [x] Refuse up front with a notice, keeping the draft, using the shared title rules
- [x] troubleshooting.md row


## Ruling (2026-10-29)

Arthur: keep refusing `#` in titles (C#, F# included); the fix only refuses up front and keeps the draft. Do not reopen the title rule.

## Summary of Changes

- One shared per-text judgement (`web/src/replica/titles.ts`) mirrors the server's `find_op_title_violation`: every ref `extract` returns (links, bare tags, attributes) is judged for length and syntax. The keystroke/paste path (`useBlockDraft.admit`), commands and outline paste (`commandRefusal` in `useOutline.ts`) and undo/redo (`undoManager`) all use it; the dead `linkedTitleLengthOver` is gone and the title-length fixture now pins the live function.
- The link enclosing the caret while the flush is held is not judged per keystroke; the whole text is judged in `run()` when the draft saves. A refused draft stays in its block with `TITLE_SYNTAX_NOTICE`, the block stays focused, Ctrl-O does not follow the refused link, and global undo waits with a notice.
- A refused draft that cannot stay on screen (outline unmounts, block removed or moved remotely, block hidden under a collapsed ancestor) is dropped from the outline into an app-level notice (`outline/droppedDrafts.ts`, `components/DroppedDraftNotice.tsx`) with its full text and a Copy button (a failed copy leaves the text selectable); the outline never locks. A beforeunload prompt is armed while a refused or dropped draft exists (desktop browsers only).
- Tests: unit (titles parity, useOutline, undoManager, EditablePage, DroppedDraftNotice) and e2e (`web/e2e/text-limits.spec.ts`), each red before its fix.
- Docs: `docs/architecture/frontend-editor.md` (refused drafts and when they are judged), `docs/troubleshooting.md` row.

Rulings:
- Arthur: `#` stays forbidden in titles.
- Arthur: judge the caret's enclosing link at save, not per keystroke (so `[[Meeting [draft] notes]]` types normally).
- Arthur: no in-memory resume store; an unshowable refused draft goes to a notice with Copy.
- Prod scan (copy): 0 of 58,082 blocks hold a refused ref; 0 of 4,508 page titles refused.
- Left as known: a killed tab (or iPad reload) loses a refused draft; Cmd-Z with no textarea focused gives no extra notice; the notice sits at the top of the page.

