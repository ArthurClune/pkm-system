---
# pkm-s1m8
title: Decide what the replica-unavailable banner should say now that ops are always retained
status: todo
type: task
created_at: 2026-08-04T18:19:09Z
updated_at: 2026-08-04T18:19:09Z
---

A product decision, not a bug. No code is wrong today.

## What changed

`OfflineIndicator`'s banner for a `replica-unavailable` problem renders only:

> Working online only — offline editing is unavailable for now.

It deliberately omits a second sentence promising the changes are still being saved. The recorded reason **used to be** that the promise was only true when the open failure was one `opQueue` retained for (quota / SAH contention / pool exhaustion) — outside that whitelist the ops were dropped, so the reassurance would have been false (pkm-9x6u).

Epic pkm-q2jj deleted that whitelist. `opQueue` now retains every replica failure except one the replica reports as a rejection of the op itself, and this banner renders only for `availabilityOf(error) === "unusable"` — a `ReplicaUnavailableError`, which is never `rejected`. **So in every session that shows this banner, the ops are retained.** The old reason for the omission is void, and the comment at `OfflineIndicator.tsx:49-58` has been corrected to say so.

## Why the copy was still left alone

There is a real remaining reason, and it is narrower than the old one: retained ops live in an in-memory fallback lane, and **there is no `beforeunload` anywhere in `web/src`**. So "your changes are still being saved" is true while the tab is online and delivering, and false the moment an offline session is reloaded or closed — the ops are gone.

So the honest reassurance is conditional, and what to show is a judgement call about which failure mode to optimise the wording for.

## Options

1. Leave as-is — silence is safe, but the user has lost offline editing and gets no word on whether their typing is safe.
2. Add the reassurance unconditionally — true in the common case (online, delivering), misleading in the reload-while-offline case.
3. Make it conditional on connection state — accurate, more moving parts in a banner.
4. Change the copy *and* add a `beforeunload` guard for undelivered lane ops, which would make the unconditional promise true. Largest scope; would need its own bean.

## Checklist

- [ ] Arthur decides which option
- [ ] Implement the chosen copy (and update `OfflineIndicator.test.tsx:156`, which currently asserts the second sentence is absent)
- [ ] Update `docs/architecture/sync-and-offline.md:493-496`, which quotes the rendered copy
