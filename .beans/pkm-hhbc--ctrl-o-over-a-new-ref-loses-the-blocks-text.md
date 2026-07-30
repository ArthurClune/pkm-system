---
# pkm-hhbc
title: Ctrl-O over a new [[ref]] loses the block's text
status: completed
type: bug
priority: normal
created_at: 2026-07-30T18:50:09Z
updated_at: 2026-07-30T19:08:49Z
---

Navigating to a [[ref]] with Ctrl-O / Ctrl-Shift-O while the caret is still inside the ref token discards the block's held draft: the block persists EMPTY and the typed text is lost.

## Evidence (prod access log + DB, 2026-07-30)

Two independent occurrences today on two different devices, plus a third that survived only because the draft happened to flush first:

- 10:11:38 (100.104.173.117) Project/SAP: GET /api/titles?q=Project/SAP/Meetings -> POST /api/pages -> GET /api/page/Project/SAP/Meetings. No POST /api/ops carrying the text. Block zCs8sW3nejc5y3Xx left empty at order_idx 1 inside the See Also link list.
- 19:27:56 (100.113.95.109) LLM Economics: GET /api/titles?q=AI Bubble -> POST /api/pages -> GET /api/page/AI Bubble. Block _58r54CrzNcwoCGP left empty as first child of See Also. User retyped [[AI Bubble]] at 19:37.
- 2026-07-29 21:16 (control): same sequence BUT a POST /api/ops landed 2.5s before POST /api/pages -- caret had left the token so the draft flushed. Text survived.

Gap between last keystroke and POST /api/pages was 0.9s and 1.16s in the two losses.

## Repro (user-confirmed 2026-07-30)

1. In any block, type `[[Some Page That Does Not Exist` -- leave the caret INSIDE the token, do not close the brackets, do not pause.
2. Press Ctrl-O (or Ctrl-Shift-O for the sidebar variant).
3. The new page is created and opened; going back to the source page shows the block still there but EMPTY.

Confirmed by the user against prod after the diagnosis below. Picking a row from the autocomplete with Enter is NOT affected -- `pick()` moves the caret past `]]`, which releases the hold and lets the normal debounce flush.

## Root cause

web/src/components/EditableBlockTree.tsx ensureRefPageThenOpen (line ~533, added for pkm-a1e4) does POST /api/pages then navigate()/openInSidebar(), reached from the navigate-ref keyboard decision at line ~665. It never flushes the pending draft.

The draft is deliberately flush-held while the caret sits inside a [[ref / #tag token (pkm-xlah, holdsDraftFlush in outline/autocomplete.ts:56, honoured at useOutline.ts:270). useOutline's comment claims 'blur, structural edits, undo, and tab-hide still flush it' -- navigation is the gap: navigate() unmounts the tree and React does not deliver onBlurBlock, so flushNow() never runs and pendingRef is dropped.

## Fix sketch

Flush the held draft before creating the page and navigating -- await a flush (new handler, or reuse onBlurBlock) at the top of ensureRefPageThenOpen. Ordering matters: the flush must land before POST /api/pages so the ref row is created by the normal ops path.

## Scope of damage found

Full DB scan: 20 empty client-created (16-char uid) blocks out of 731. 19 are trailing blocks (benign -- Enter pressed, nothing typed). The only two interior ones are the two cases above, both today, both directly under a See Also heading. 22 nightly markdown exports (07-09..07-30) show no other silent block loss.

## Todo

- [x] Failing test first: navigate-ref over an unflushed [[new page]] keeps the block text
- [x] Flush the held draft before POST /api/pages in ensureRefPageThenOpen
- [x] Cover the sidebar variant (Ctrl-Shift-O) too
- [x] Check the equivalent click-on-ref path for the same gap
- [x] Update docs/architecture/frontend.md: the flush-held draft invariant should name navigation as a flush point

## Data repair

- LLM Economics: already repaired by the user (retyped [[AI Bubble]] into the surviving empty block _58r54CrzNcwoCGP).
- Project/SAP: the user is repairing the empty block zCs8sW3nejc5y3Xx (order_idx 1 under See Also, lost text almost certainly [[Project/SAP/Meetings]]).

No other repair outstanding -- see Scope of damage found.

## Notes for a fresh session

Everything needed to fix this is above; no separate handover doc. Worth knowing:

- Work in a worktree/branch per CLAUDE.md, write the failing test first.
- The two safety mechanisms that combine into this bug are each individually correct. Do NOT weaken the pkm-xlah flush-hold (it exists so a half-typed [[title does not create a junk page) and do NOT drop the pkm-a1e4 POST /api/pages (it exists because a held draft means the ref page has no row yet). The fix is purely about ordering: flush, then create, then navigate.
- Verify with `cd web && pnpm verify`. A unit test on the navigate-ref handler should be enough; an E2E would need a real Ctrl-O chord against a page that does not exist yet.
- How the empty-block scan was done, if recurrence needs checking later: copy the prod DB to a scratchpad (in-place open fails in the sandbox) and look for empty blocks with 16-char (client-generated) uids that are NOT the last sibling. Trailing empties are normal; interior ones are the signal. The user authorised the direct DB read for debugging -- normal PKM access still goes through the pkm CLI.

## Summary of Changes

Ordering fix, exactly as sketched -- neither safety mechanism weakened.

- `OutlineHandlers.onFlushDraft()`: commit the pending draft now, without
  touching focus (`onBlurBlock` would clear it, and Ctrl-Shift-O leaves the
  caret in the block). `useOutline` implements it as the existing `flushNow`.
- `ensureRefPageThenOpen` calls it synchronously, before `POST /api/pages` and
  before `navigate()`/`openInSidebar()`, so the ref row is still created by the
  normal ops path.

Tests (all four written failing first):

- `EditablePage.test.tsx` x2 -- full wiring, Ctrl-O and Ctrl-Shift-O over a
  held `see [[Fresh Idea]]` draft: the batch reaches `sync.sent`. Each first
  asserts `sync.sent === []` after 5s so the draft is provably *held*.
- `EditableBlockTree.test.tsx` -- the flush is requested, and
  `invocationCallOrder` proves it precedes `POST /api/pages`.
- `useOutline.draftHold.test.tsx` -- `onFlushDraft` commits a held draft,
  alongside the existing blur / structural-edit commit points.

Verified: `pnpm verify` fully green (typecheck, lint, fcis, 1700 unit tests,
coverage 97.34%, bundle budgets, 46 E2E). No server change, so no pytest run.

### Click-on-ref path: not affected

Only *unfocused* blocks render links, so there is no ref to click inside the
block being typed; reaching any other block's link blurs the textarea first,
and blur already flushes.

### Finding: the same gap is open on Ctrl-Shift-D (and browser back/forward)

Probed directly against `useOutline` (throwaway test, deleted):

- held draft + unmount, no blur -> `sync.sent` is `[]`. Text lost.
- ordinary debounced draft + unmount -> flushes fine, because nothing cancels
  the pending `setTimeout`; it fires after the outline is gone.

So a *held* draft is lost by any unmount-without-blur, not just Ctrl-O.
`App.tsx`'s global `Ctrl-Shift-D` handler calls `navigate("/")` with no flush,
and browser back/forward does the same. Same class, same severity, different
door -- filed as pkm-mvdx, then fixed in this same branch at the user's
request (unmount-time flush in `useOutline`). Both defences are kept: the
explicit flush here is what guarantees the ordering against POST /api/pages.
