---
# pkm-jk21
title: Make outline loading and write-replay policies explicit and type-safe
status: completed
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-18T18:10:43Z
parent: pkm-wvvu
---

## Review findings

Frontend A3, B2, B3, and the `transitionOutline` exhaustiveness observation.

The missing-daily-page policy is duplicated, write replay is optional despite being required for safe rebasing, and authoritative loader selection depends on last-mounted registration order.

## Acceptance criteria

- [x] Route the registered loader missing-page case through `substituteMissingDaily`
- [x] Remove the dead `write-started.ops` variant, require replay data, and eliminate the empty replay default
- [x] Add tests that fail if local write tracking can erase a previously recorded replay
- [x] Replace registration-order loader election with named loader kinds and explicit precedence
- [x] Make outline transition handling compiler-exhaustive so new events cannot fall through as write settlement
- [x] Preserve page/day loading, repair epochs, parent reads, and optimistic replay with focused race tests
- [x] Document loader precedence and replay ownership in frontend/sync architecture


## Summary of Changes

**Loader election by named kinds.** `setAuthoritativeLoader` now takes an
`OutlineLoaderKind` — `page` (`useOutlinePageLoad`), `day` (`Journal`),
`editable` (`useOutline`) — and `electLoader` walks `LOADER_PRECEDENCE` in that
order, newest registration within the winning kind. Both session-started read
paths use it: `requestAuthoritative` and `repairEpochSession`.

**One missing-page policy, one fetch.** New `outline/loadOutlineBlocks.ts`
(Imperative Shell) holds the blocks-only page read every registered loader now
shares; it takes a `MissingPagePolicy`. `useOutline` no longer re-inlines the
404-on-a-daily predicate, and `useOutline`'s `refetch` goes through the same
helper. `substituteMissingDay` joins `substituteMissingDaily` in
`missingPage.ts` for titles `/api/journal` already named as days.

**Replay data required.** `write-started` lost its dead `ops?` variant and its
`replay?` is now required. `trackWrite` has no `replay` default: `applyLocal`
passes the ops it just applied, and the delivery registry computes each title's
replay through `replayFor` (captured optimistic metadata, else the batch wire
ops). `trackActiveOutlineWrite`'s `ops` is required too.

**Compiler-exhaustive transitions.** `transitionOutline` is a `switch` over
`event.type` with a `const exhaustive: never` default, so `write-settled` is
handled by its own case rather than by fallthrough. Verified: adding an
unhandled event variant is a TS2322 error.

Tests: 2098 unit (13 new) + 53 E2E green; typecheck, lint, FCIS, coverage
thresholds and the precache budget all pass. Mutation-checked — removing the
already-relevant guard in `write-started` fails the two new erasure tests, and
reverting election to last-registered fails two precedence tests.

Observations for other beans: `RepairEpoch.id`/`nextRepairEpoch` are still dead
state, and `scopeContainsTitle` is still duplicated between `outlineState.ts`
and `outlineSessions.ts`.
