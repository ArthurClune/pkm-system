---
# pkm-gk7d
title: QueryResults' load, edit and groups-fetch rules move into one pure reducer
status: completed
type: task
priority: low
created_at: 2026-11-16T21:55:59Z
updated_at: 2026-11-16T22:32:13Z
---

An FCIS review of the query-table hold work found two gaps that one change closes.

**Groups-fetch rule lives in the shell.** In `web/src/components/QueryResults.tsx`, whether to start `/api/query` is decided inline in the groups effect from `wantsBlocks`, `savedBlocks`, `recordsFor === want`, the `groupsFor` and `groupsTried` refs, and a reset of `groupsTried` when the reader leaves the blocks view. That is a small state machine spread over refs and an effect, reachable only through component tests (`QueryBlock.test.tsx`).

**The property suite runs a copy of the shell's wiring.** `web/src/props/tables/queryRun.ts`'s `load()` re-implements what `QueryResults` does when a records load lands: `queryDefaults` -> `viewFromOptions` -> `holdRecords(prev, held, next, frozen)` -> `stepQueryView({kind: "loaded"})`. In the component that sequence is split across the records effect, the view effect and the `frozenNow` ref, so the property checks the pure functions but not the order the shell calls them in: a shell that read `frozen` from a stale render would still pass.

Aim: one Functional Core reducer (in `web/src/tables/queryViewState.ts` or beside it) whose state is the block's records, held records, key stats, defaults, view state and groups-load bookkeeping, with events for a records load landing (payload or error), a groups load landing, the options changing, a reader step and a cell edit; plus a pure "should the groups fetch start now" answer. `QueryResults` holds that state and runs the fetches; `queryRun.ts` drives the same reducer instead of its own `load()`.

- [x] Write the reducer and the groups-fetch decision as Functional Core, with unit tests
- [x] `QueryResults` uses it; its effects only fetch and dispatch
- [x] `queryRun.ts` drives the reducer, deleting its hand-written `load()`; add the groups-fetch decision to the property if it has transitions worth modelling
- [x] Property rule changes shown to reach and to fail (docs/architecture/checks.md, Property gate)
- [x] `pnpm verify`, `proptest/check.sh web`
- [x] `perf/check.sh frontend` (no changes against the baseline)


## Summary of Changes

- `web/src/tables/queryBlock.ts` (Functional Core) holds a mounted query block's whole state (`QueryBlockState`: options, loaded stats and defaults, view state, records, held records, errors, `recordsFor`, groups, `groupsFor`, `groupsTried`) and one step function, built by `makeQueryBlock(machine)` over the `QueryMachine` view functions (`stepQueryView`, `showQuery`, `holdRecords`) so the property's mutants can swap them. Selectors: `shown`, `wantsBlocks`, `groupsFetchDue`. A records load holds records under the frozen rows in the state it steps, then steps the view, in one step; the `frozenNow` ref is gone. `shownNow` stays in the shell, since which render a cell write came from is a commit-timing question.
- `showQuery`'s view choice is factored into `shownView` (`queryViewState.ts`), which `wantsBlocks` uses so a dispatch does not recompute the rows.
- Groups answers: one is taken only when it answers the fetch still out in this stay in the blocks view (`groupsTried === load`). Records that carry the groups clear `groupsTried`, which drops any answer still out, for the same load or an older one. A plain "ignored when groupsFor === load" guard would let an older load's /api/query answer replace the groups a newer load's records carried, once the shell no longer called `groupsGuard.begin()` from the records handler.
- `QueryResults` uses `useReducer`; its effects only fetch and dispatch. The options dispatch is a layout effect, so no frame shows new options over the old view.
- `web/src/props/tables/queryRun.ts` drives the reducer and `groupsFetchDue` as the shell does; `queryFetch.ts` models the requests out and checks the rules in `contracts/frontend-editor.md` § What a query block fetches (fetch-unwanted, fetch-early, fetch-twice, fetch-carried, groups-replaced, stall). The draws add resyncs with records answers that land later or fail and /api/query answers that land or fail, plus moves into and out of the blocks view. Each new rule has a mutant in `queryTeeth.prop.ts` and a reach label with a floor. The step mix changed, so all reach floors were re-derived from 30 unseeded runs.
