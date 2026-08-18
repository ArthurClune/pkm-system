---
# pkm-tu5k
title: A known-rejected batch that cannot be repaired still strands edits in memory
status: completed
type: bug
priority: normal
created_at: 2026-08-04T11:32:28Z
updated_at: 2026-08-18T19:46:55Z
parent: pkm-q2jj
---

Split out of pkm-bjae, which fixed the common case (an unopenable replica now falls back to online-only). This is the remaining, deliberately-unfixed path.

Retained poison **mark intents** live in localStorage (opQueue.ts:54), not the replica, so they survive a database that cannot be opened. When `queue.retryPoisonMarks()` fails with intents present, SyncProvider's mount effect returns with the recovery barrier still held (SyncProvider.tsx, the `catch { return; }` after retryPoisonMarks).

That gate is CORRECT: an intent is evidence that the server already rejected a batch, and it cannot be repaired while the replica is unopenable, so delivering past it would post ahead of a known-bad batch. pkm-bjae's online-only fallback deliberately does not apply here, and a test pins that ("a KNOWN-rejected batch still holds the gate when it cannot be repaired").

What is NOT correct is the silence. The editor keeps accepting edits, they join the in-memory fallback lane, and the only signal is "Checking rejected changes failed: <error>" with a Retry button that never mentions unsaved work. A reload or a closed tab loses them.

Read-only is NOT the intended remedy (decided 2026-08-04: online-only is the preferred fallback shape, and a read-only second tab would be a daily tax). The likely answer is an honest signal instead.

Reachability: needs a batch rejected in a previous session whose marking did not complete, AND an unopenable replica now. Rare, hence low priority.

## Options

[ ] Say it plainly: a banner that states changes are not being saved, not just that a check failed
[x] beforeunload guard while the fallback lane is non-empty — shipped separately by pkm-0htf (`unloadGuard.ts`)
[x] Consider whether the intent itself can be repaired without the replica (post the rejection's repair through the server directly), which would remove the gate rather than annotate it — considered and rejected 2026-08-18: repair is client-local (rebase + `deleteBatch` inside the replica); the server already rejected the batch and holds nothing to fix, so there is no server-side repair to post. See Decision below.

## Decision (2026-08-18, approved)

Add a user-initiated **discard** of an unmarkable intent — the escape the adversarial
review asked for. Safe because the intent is belt-and-braces: if the replica ever
opens again, the unmarked bad batch redelivers, the server rejects it again, and the
existing in-session poison → repair flow handles it. Discard rejoins existing paths:
clear intents, then `continueStartup([])` (discovery → pkm-bjae online-only fallback
when the replica is unusable). Plain labeled button on the mark-failed banner, no
confirm dialog, following the replica-stalled "Discard and reset" precedent.

## Checklist

[x] Decide which signal to add — decided: explicit discard affordance (see Decision)
[x] opQueue: `discardPoisonIntents()` clears memory + localStorage intents
[x] SyncProvider: `discardProblem()` wired to `queue.discardPoisonIntents()` then `continueStartup([])` (startup-blocked arm) or `resume("recovery")` (mid-session arm)
[x] OfflineIndicator: "Discard rejected change" button on the mark-failed banner arm
[x] Cover with a SyncProvider unit test alongside the existing pin
[x] Update docs/architecture/sync-and-offline.md ("One case deliberately still holds the gate")


## Summary of Changes

The mark-failed banner now offers **Discard rejected change** alongside Retry —
the user-facing escape from the permanently-wedged profile:

- `opQueue.discardPoisonIntents()` drops retained intents from memory and
  localStorage without any replica call (the replica being unreachable is the
  scenario).
- `SyncProvider.discardProblem()` (Sync context) guards on the
  rejected-batch/mark-failed problem, discards, emits the new
  `poison-intents-discarded` core event, then rejoins startup via
  `continueStartup([])` (or `resume("recovery")` mid-session). An unopenable
  replica falls into the pkm-bjae online-only fallback; edits typed while
  wedged deliver instead of dying with the tab.
- `syncState` gained the `poison-intents-discarded` event because
  `replica-unavailable` never stomps another problem kind — without it the
  stale mark-failed banner would outlive its intents.
- Safety argument: an unmarked batch redelivers when the replica next opens;
  the server rejects it again into the normal poison → repair flow. The
  existing gate pin ("a KNOWN-rejected batch still holds the gate…") is
  unchanged — Retry alone still never lifts the gate.
- Docs: sync-and-offline.md gate paragraph gained the escape; corrected the
  stale banner quote; symptom row no longer says "open by design".

## The gate is STICKY, not transient (adversarial review, 2026-08-04)

This bean understated the severity. `POISON_MARK_INTENTS_KEY` is cleared in exactly one place -- `opQueue.ts:330`, after a successful `markPoisoned` against the database. So if the replica cannot be opened for that browser profile, the intent can NEVER clear, and **every future session is wedged at exit 1 permanently**, with no user-facing escape. It is not a rare transient state that a reload fixes; it is sticky by construction, and a reload reproduces it.

Also: `createQueueState(intents.length > 0)` (`opQueue.ts:168`) starts the queue in `recovering` before the mount effect even runs, so the wedge predates startup rather than being entered by it.

Not silent, to be fair to the current code: `onPoisonMarkFailed` raises `rejected-batch`/`mark-failed` with a role="alert" banner. But its Retry can never succeed while the replica stays unopenable, so the affordance is misleading.

This raises the priority of deciding the policy: any fix must give the user a way OUT of a permanently-wedged profile, not just a clearer message. Candidates: repair the rejection through the server without the replica (removing the need for the intent), or let the user explicitly discard a retained intent they can never mark.
