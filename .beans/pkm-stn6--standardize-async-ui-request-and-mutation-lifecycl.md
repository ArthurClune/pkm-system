---
# pkm-stn6
title: Standardize async UI request and mutation lifecycles
status: completed
type: bug
priority: high
tags:
    - web
    - ui
    - concurrency
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-16T08:30:00Z
parent: pkm-c1cg
---

## Problem

Async UI components use inconsistent stale-response, rerender, and mutation-serialization patterns. Confirmed risks include stale QueryBlock responses, BlockTree collapse drift, stale Bluesky actor/height state, and overlapping SidebarNav mutations.

## Scope

Introduce consistent request sequencing or cancellation, prop-state reconciliation, and serialized mutation behavior across affected components.

## Acceptance criteria

- [x] QueryBlock drops or aborts responses for obsolete expressions and pagination generations.
- [x] BlockTree reconciles authoritative collapsed changes while preserving intentional view-only toggles.
- [x] BlueskyEmbed derives actor state from the current href and resets post-specific height.
- [x] SidebarNav serializes conflicting mutations, disables unsafe controls, and reports failures.
- [x] Rerender and out-of-order-response tests cover each case.
- [x] Reusable async helpers are introduced only where they reduce duplication.
- [x] pnpm verify passes. (controller ran canonical `cd web && pnpm verify` at implementation head
      b5c6351 and again at review-fix head 7a2c1ff: typecheck, enforced unit coverage, and
      Playwright 6/6 all green)

## Summary of Changes

Each of the four components got its own component-specific concurrency mechanism — no shared
`useAsync` abstraction, since the four lifecycles genuinely differ (request identity vs. prop
reconciliation vs. actor/height identity vs. mutation serialization):

- **QueryBlock.tsx**: a monotonically increasing `requestIdRef`, stamped onto every fetch (initial
  load and each pagination page) and re-checked before any state update in the response, the
  catch, and the finally. This is the source of truth for staleness rather than an
  `AbortController`, because the offline-gateway fallback in `api/client.ts` can still complete a
  "cancelled" request without honoring an abort signal — the id check catches that regardless of
  how the response actually arrives. A separate synchronous `pageInFlightRef` blocks a second page
  request from ever being issued while one is outstanding (guards a double-clicked "Show more"
  even within a single React batch, before any `disabled` attribute could commit).
- **BlockTree.tsx** (`Block`): local `collapsed` view state now reconciles against a tracked
  `prevAuthoritative` value using React's "adjusting state during render" pattern — a real change
  in `node.collapsed`'s *value* (not just a new `blocks` array/object identity from an unrelated
  edit) overwrites the local view state; an unchanged value leaves a local toggle untouched.
- **BlueskyEmbed.tsx**: a raw-DID actor's `did` is now computed directly from `actor` every
  render (never stored, so it can't go stale). A handle actor's resolved DID is stored as
  `{actor, did}` and only used when `resolvedDid.actor === actor` — actor-keyed, so a late
  resolution for an actor the href has since moved away from is naturally ignored without an
  extra race guard. `height` is reset whenever `href` changes (post-keyed), so a previous post's
  reported height can't linger on the next one.
- **SidebarNav.tsx**: `addEntry`/`removeEntry`/`moveEntry` all now go through a single
  `runMutation` lane (`idle | running | failed`) built on a chained `laneRef` promise — a second
  mutation always waits for the previous mutation-plus-refresh to fully settle. Every rejection
  (mutation or refresh) is caught, surfacing as `mutationState === "failed"` instead of an
  unhandled rejection (previously `removeEntry`/`reorder` had no error handling at all). All
  mutating controls (`add`, `remove`, `move up/down`) are disabled while a mutation is running, and
  `moveEntry` computes its reorder from `entriesRef.current` (updated imperatively alongside
  `setEntries`) — the entries current when the lane actually begins, not the possibly-stale
  entries captured at click time.

New/expanded test files (all under `web/src/components/`): `QueryBlock.test.tsx` (+4 tests:
superseded-expr resolution, obsolete pagination after rerender, stale rejection while current
pending, double-click pagination), `BlockTree.test.tsx` (+2: preserved local toggle vs. adopted
real transition), `BlueskyEmbed.test.tsx` (+4: actor A/B inversion, DID href replacement,
post-height reset, invalid→valid href), `SidebarNav.test.tsx` (+5: disabled-while-in-flight,
reorder failure caught, remove failure + successful retry, reorder computed from current entries).
Added a small `defer<T>()` test helper to `test-helpers.ts` for controlling out-of-order
resolution precisely.
