---
# pkm-gk7d
title: QueryResults' load, edit and groups-fetch rules move into one pure reducer
status: in-progress
type: task
priority: low
created_at: 2026-11-16T21:55:59Z
updated_at: 2026-11-16T22:00:27Z
---

An FCIS review of the query-table hold work found two gaps that one change closes.

**Groups-fetch rule lives in the shell.** In `web/src/components/QueryResults.tsx`, whether to start `/api/query` is decided inline in the groups effect from `wantsBlocks`, `savedBlocks`, `recordsFor === want`, the `groupsFor` and `groupsTried` refs, and a reset of `groupsTried` when the reader leaves the blocks view. That is a small state machine spread over refs and an effect, reachable only through component tests (`QueryBlock.test.tsx`).

**The property suite runs a copy of the shell's wiring.** `web/src/props/tables/queryRun.ts`'s `load()` re-implements what `QueryResults` does when a records load lands: `queryDefaults` -> `viewFromOptions` -> `holdRecords(prev, held, next, frozen)` -> `stepQueryView({kind: "loaded"})`. In the component that sequence is split across the records effect, the view effect and the `frozenNow` ref, so the property checks the pure functions but not the order the shell calls them in: a shell that read `frozen` from a stale render would still pass.

Aim: one Functional Core reducer (in `web/src/tables/queryViewState.ts` or beside it) whose state is the block's records, held records, key stats, defaults, view state and groups-load bookkeeping, with events for a records load landing (payload or error), a groups load landing, the options changing, a reader step and a cell edit; plus a pure "should the groups fetch start now" answer. `QueryResults` holds that state and runs the fetches; `queryRun.ts` drives the same reducer instead of its own `load()`.

- [ ] Write the reducer and the groups-fetch decision as Functional Core, with unit tests
- [ ] `QueryResults` uses it; its effects only fetch and dispatch
- [ ] `queryRun.ts` drives the reducer, deleting its hand-written `load()`; add the groups-fetch decision to the property if it has transitions worth modelling
- [ ] Property rule changes shown to reach and to fail (docs/architecture/checks.md, Property gate)
- [ ] `pnpm verify`, `proptest/check.sh web`, `perf/check.sh frontend`
