---
# pkm-eydv
title: 'Outline: two independent ''draft dirty'' truths let a programmatic change be overwritten by the next keystroke'
status: in-progress
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:20:56Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding outline F4 and the "one owner for dirty"
recommendation. Verdict: HOLDS-NARROWER.

## Symptom
`/goodlinks`: pick it, click back into the same block and type "abc" while
the API call runs. It resolves; `run()` flushes "...abc" and splices the
attribute into the tree, but `useBlockDraft.tryAdopt` sees the textarea
dirty and keeps showing "...abc". Typing "d" captures base "...abc"; the
server's text is the spliced one, so it forks a conflict and the attribute
ends up in a conflict copy. Missed path: type a character, erase it, then a
remote edit to the block also yields a needless conflict.

## Cause
`useOutline` `pendingRef` and `useBlockDraft` `dirtyRef` are separate
records of "unsaved draft"; only three `settle()` calls keep them aligned.
pkm-22ay declined unifying them in 2026-07 because the pending state was not
reachable from BlockInput; `handlers.pendingDraft(uid)` is now passed in.

## Fix
- [ ] Red tests: the goodlinks retype sequence; type-then-erase then remote edit
- [ ] Derive "dirty" from `handlers.pendingDraft(uid)`; delete `dirtyRef`
- [ ] frontend-editor.md: the rule naming who owns "dirty"

## Property testing (required)

This bean introduces or changes a state machine, so it gets full property
testing, not only unit tests (Arthur, 2026-11-07). Per
docs/architecture/checks.md § Property gate:

- Write the model from the docs (sync-and-offline.md, backend.md,
  assistant.md, frontend-editor.md as relevant), never from the code under test.
- The generator draws the whole event alphabet below, freely interleaved, and
  must reach the interleaving that found this bug.
- Show it reaches: label each named path with `event()` (server) or the
  suite tally (web) and read the rates from a real run.
- Show it has teeth: reintroduce this bug as a mutant (or a teeth route) and
  confirm the named invariant fails; a clean run passes.
- Run `proptest/check.sh` before merge; a red-first unit test for the
  original sequence goes beside the code as usual.

Sketch (fast-check, `web/src/props/outline`):
- Model: `{treeText, shownText, pending: {text, base} | null, serverText}`.
- Alphabet: `type(ch)`, `erase`, `debounceFlush`, `remoteEdit(text)`,
  `runWithFlushAndSplice(text)` (goodlinks/upload shape), `undoKeypress`
  (flush and settle), `queuedReplayLands(text)`, `blur`, `refocus`, freely
  interleaved. Label the flush-then-splice-in-one-run and erase-to-base paths.
- Invariants: with no pending draft the textarea shows treeText once effects
  settle; every flushed update_text's base hash equals the text shown when
  that draft began; a conflict arises only when a remoteEdit or
  queuedReplayLands happened while a draft was pending.
- Teeth: restore the old `dirtyRef` and confirm the goodlinks shape fails.
