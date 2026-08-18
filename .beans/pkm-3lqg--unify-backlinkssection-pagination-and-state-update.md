---
# pkm-3lqg
title: Unify BacklinksSection pagination and state updates
status: completed
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-18T16:36:05Z
parent: pkm-wvvu
---

## Review findings

Frontend A4. Initial load and refresh independently implement the same batched fetch, merge, epoch guard, and no-growth termination loop, while three coupled values are maintained in separate state updates.

## Acceptance criteria

- [x] Extract one tested backlink batch-walk used by initial load and refresh
- [x] Keep epoch/supersession checks at every asynchronous boundary
- [x] Store groups, total page count, and extra reference texts as one atomic state value
- [x] Preserve incremental pagination, deduplication, ordering, refresh, and no-growth termination
- [x] Add tests for stale refreshes, multi-batch results, duplicates, and partial failures

## Summary of Changes

Extracted the batched-fetch/merge/epoch-guard/no-growth-termination algorithm
that `loadAll` and `refresh`'s inner loop both implemented into a single pure
function, `walkBacklinkBatches` (new file `web/src/components/backlinkBatchWalk.ts`,
FCIS Functional Core). It takes an injected `fetchBatch`, a starting
`BacklinkBatchState { groups, totalPages, refTexts }`, a `nextLimit(state,
batchesFetched)` callback that decides the next batch's size or `null` to
stop, and an `isStale()` callback polled right after every await so a
superseded caller discards the in-flight batch instead of committing it
(returns the literal `"stale"`).

`nextLimit` alone expresses every caller's shape, so `loadMore`, `loadAll`,
and `refresh` in `BacklinksSection.tsx` are now thin wrappers around one walk:
- `loadMore`: one batch of `initial.limit`.
- `loadAll`: loop in batches of 100 until `groups.length >= totalPages`.
- `refresh`: a from-scratch walk (empty starting state) whose first batch is
  sized `panelOpen ? 100 : initial.limit`, then (only while the panel stays
  open) loops in batches of 100.

`groups`, `totalPages`, and `refTexts` (renamed from `extraRefTexts`) are now
one `useState<BacklinkBatchState>` instead of three separate `useState`s, so
a partial update across them is no longer representable. As part of this,
`loadMore`'s prior functional-setState commit style (reading latest state at
commit time) was aligned to the snapshot-based commit style `loadAll` and
`refresh` already used, removing the one inconsistency the finding called out
between the three functions -- the walk's starting state is necessarily a
snapshot taken before the first await, so there's no meaningful difference
in the guarded (non-concurrent) path.

Files changed:
- `web/src/components/backlinkBatchWalk.ts` (new, Functional Core)
- `web/src/components/backlinkBatchWalk.test.ts` (new): multi-batch walk,
  cross-batch item dedup, stale-mid-walk discard, batch-fetch rejection
  propagates without partial commit, empty-batch termination, no-growth
  termination, cross-batch ref-text merge, single-batch (loadMore-shape)
  walk, zero-fetch short-circuit.
- `web/src/components/BacklinksSection.tsx`: atomic state, all three pagination
  functions now call `walkBacklinkBatches`.
- `docs/architecture/frontend.md`: added `backlinkBatchWalk` to the
  `components/` pure-halves list.

All 26 pre-existing `sections.test.tsx` component tests (epoch-guard wiring,
stale-refresh, filter-panel loadAll, batch merging, retry-on-failure, etc.)
pass unchanged -- no test needed to be touched at that layer.

Verification: `pnpm typecheck`, `pnpm test:unit` (130 files / 2097+ tests),
and `CI=true E2E_PORT=8981 pnpm verify` (typecheck + lint + FCIS check +
coverage + build + Playwright e2e, 53/53) all passed. One pre-existing,
already-documented load-sensitive flake (`tooling/lintConfig.test.ts` timing
out under coverage-instrumentation + parallel-worker CPU contention) was hit
on 2 of 4 verify attempts and confirmed unrelated: it passes in isolation
without coverage (887ms) and passes fully instrumented alone with no
contention (4571ms, under its own 5000ms budget); the full gate passed clean
on the final attempt.

## Fix round 1 (review finding)

`loadMore`/`loadAll` guarded only against a concurrent `refresh`, not
against each other, so two ordinary clicks (Show more, then Filter, before
the first request resolved) could race; whichever walk committed last did
an outright `setBacklinks(result)` replace and silently discarded the
other's already-loaded groups, potentially wedging the filter panel in a
permanent loading state. Fixed by merging each walk's result onto the
latest state (`mergeBacklinkResult`, new export in `backlinkBatchWalk.ts`)
for `loadMore`/`loadAll`; `refresh` keeps its full replace since dropping
stale groups is its whole point, and stays safe because a concurrent
refresh already turns any in-flight loadMore/loadAll into `"stale"`. Added
2 unit tests for `mergeBacklinkResult` and 1 component-level regression
test reproducing the exact race; confirmed the regression test fails
without the fix and passes with it.
