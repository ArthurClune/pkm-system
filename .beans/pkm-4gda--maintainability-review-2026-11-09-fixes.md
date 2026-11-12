---
# pkm-4gda
title: 'Maintainability review (2026-11-09): fixes'
status: completed
type: epic
priority: normal
created_at: 2026-11-09T21:39:23Z
updated_at: 2026-11-12T17:25:38Z
---

Found by the maintainability review of 2026-11-09 (eight area reviewers:
server write path, server routes and domain, assistant, web sync and
replica, outline editor, web UI, gates and tooling, the docs set). Reviewed
at main @ 09e433e8. The lead findings were re-checked against the code by
the orchestrating session; nothing was run.

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md
(one section per child, W1 to W19). The eight full reports are kept
locally, uncommitted, under
docs/superpowers/handoffs/2026-11-09-maintainability-review/.

## Recurring shapes the review found

- One rule with several judges that drifted (undo's refusal check vs the
  editor's; five routes outside write_txn; interrupt-then-drain written
  twice; single-flight "late caller" logic written six times; a second
  /api/ops POST path; four modal keyboard handlers; six stale-fetch idioms).
- Property harnesses that copy the composition they check (outline runner,
  sync harness), and reach/teeth evidence that is printed, not asserted;
  the server gate suites have no mutants.
- State carried beside an explicit machine (assistant turn flags; the
  poison claim's second flag; Files' three "which filter" fields).
- Docs regrown from about 30k to 47.5k words in 18 days, with a size check
  that cannot see it, and a handful of sentences the code contradicts.

## Ruling for this epic (Arthur, 2026-11-09)

Property tests for state machines remain the ideal, but a child that
converts an implicit machine to an explicit one may merge without a new
property suite. It keeps existing suites green (updating a model where the
machine it models changed) and adds the conversion to pkm-ygyx.

## Children, in suggested order

- [x] pkm-rmdl W6  Docs: correct statements the code contradicts
- [x] pkm-ey0s W1  Undo, redo and cross-page drops judge batch size
- [x] pkm-t57n W2  Every journal-advancing route under write_txn
- [x] pkm-60go W3  Assistant turn: interrupting phase, one stop path
- [x] pkm-t6xh W4  Small web bugs
- [x] pkm-3kbm W5  Small server and deploy bugs
- [x] pkm-eek2 W16 e2e specs write to pages they create
- [x] pkm-i74o W7  Outline: one command core (after W1)
- [x] pkm-r0tz W8  Sync: createSyncSession
- [x] pkm-p9s2 W9  Sync: coalesce helper (after W8)
- [x] pkm-onr2 W10 Sync: poison claim, mode writer, leased delivery (after W9)
- [x] pkm-3iwm W11 Recovery lease across network I/O (after W10)
- [x] pkm-wqnv W12 Server write path
- [x] pkm-7rxj W13 Server routes and domain cleanups (after W2, W12)
- [x] pkm-21bj W14 Assistant: contract, preview, confirm state (after W3)
- [x] pkm-nbl3 W15 Web UI (after W4)
- [x] pkm-elb2 W17 Gates and tooling (e2e typecheck after W16)
- [x] pkm-3m1g W18 Docs structure (after W2, W12, W13)
- [x] pkm-ygyx W19 Property suites for converted machines (deferred)

## Not fixed, and why

Listed in the plan's "Not in this plan" section: socket.ts as a phase
union; retiring the strict-hash ack path; splitting styles.css; renaming
commentlint.run.

## Summary of Changes

Every child is completed or scrapped; pkm-3ono (a terminal rejection on a recovery's leased POST) was the last. Gate problems found while closing it are filed on their own: pkm-9hki, pkm-j5wi, pkm-mgc0.
