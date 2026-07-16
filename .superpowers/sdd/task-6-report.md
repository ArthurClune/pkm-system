# Task 6: Async UI lifecycle consistency (pkm-stn6) — Report

## Summary

Implemented component-specific concurrency/lifecycle hardening for four independent components, per
the brief's Interfaces section. No shared `useAsync` abstraction was introduced — each mechanism is
local to its component because the four lifecycles have genuinely different semantics.

### QueryBlock.tsx
- Added `requestIdRef` (monotonically increasing, stamped on every fetch — initial load and each
  pagination page) and re-checked before any state update in the `.then`, `.catch`, and `finally`
  blocks. This — not an `AbortController` — is the actual staleness guard: `api/client.ts`'s
  offline-gateway fallback can still complete a "cancelled" request without honoring an abort
  signal, so the id check is the single source of truth regardless of how a response arrives.
- Added `pageInFlightRef`, a synchronous guard that blocks a second "Show more" request from
  firing at all while one is outstanding (covers a double click even within a single React
  batch, before any `disabled` attribute could commit).

### BlockTree.tsx (`Block`)
- Replaced the one-time `useState(node.collapsed)` seed with React's "adjusting state during
  render" pattern: a `prevAuthoritative` value is tracked, and only a genuine *value* change in
  `node.collapsed` (not merely a new `blocks` array/object identity from an unrelated edit)
  overwrites the local view state. An unchanged authoritative value leaves a local user toggle
  untouched.

### BlueskyEmbed.tsx
- A raw-DID actor's `did` is now computed directly from `actor` every render (never stored, so it
  can't go stale).
- A handle actor's resolved DID is stored as `{actor, did}` and used only when
  `resolvedDid.actor === actor` (actor-keyed) — a late resolution for an actor the href has since
  moved away from is naturally ignored, no extra race-guard needed in the effect.
- `height` now resets whenever `href` changes (post-keyed), so a previous post's reported height
  can't linger on the next one until its own message arrives.

### SidebarNav.tsx
- `addEntry`/`removeEntry`/`moveEntry` now all go through a single `runMutation` lane
  (`mutationState: idle | running | failed`) built on a chained `laneRef` promise: a queued
  mutation always waits for the previous mutation-plus-refresh to fully settle before starting.
- Every rejection (from the mutation itself or the refresh after it) is now caught, surfacing as
  `mutationState === "failed"` — previously `removeEntry`/`reorder` had **no** error handling at
  all and would produce an unhandled promise rejection on any failure.
- All mutating controls (`add`, `remove`, `move up/down`) are disabled while `mutationState ===
  "running"`.
- `moveEntry` computes its reorder from `entriesRef.current` (updated imperatively alongside
  `setEntries` via a small `applyEntries` helper) — the entries current when the lane actually
  begins running, not the possibly-stale entries closed over at click time.

## Files changed

- `web/src/components/QueryBlock.tsx`
- `web/src/components/QueryBlock.test.tsx`
- `web/src/components/BlockTree.tsx`
- `web/src/components/BlockTree.test.tsx`
- `web/src/components/BlueskyEmbed.tsx`
- `web/src/components/BlueskyEmbed.test.tsx`
- `web/src/components/SidebarNav.tsx`
- `web/src/components/SidebarNav.test.tsx`
- `web/src/test-helpers.ts` (added a small `defer<T>()` test helper for controlling out-of-order
  promise resolution precisely — used by all four new test suites)
- `.beans/pkm-stn6--standardize-async-ui-request-and-mutation-lifecycl.md` (all criteria checked
  except "pnpm verify passes", left unchecked since the full e2e/Playwright suite was not re-run
  in this session; status set to `completed`)

## TDD evidence

### RED (Step 1) — QueryBlock

Command: `cd web && pnpm vitest run src/components/QueryBlock.test.tsx`

4 new tests failed against the pre-fix component (existing 5 tests still passed):

```
× keeps only the current expr's results when a superseded expr resolves late
  → expected <a class="page-link" …(1)></a> to be null   (Alpha page leaked through)
× drops an obsolete pagination response after a rerender changes the expr
  → expected <div class="query-item"></div> to be null   (stale page-2 item "a2" leaked through)
× ignores a stale generation's rejection while the current generation is still pending
  → expected <p class="error"></p> to be null             (stale rejection's error text leaked through)
× ignores a second show-more click while a page request is already in flight
  → expected 2 to be 1                                    (two page fetches fired instead of one)

Tests  4 failed | 5 passed (9)
```

Expected because every `.then`/`.catch`/`finally` in the original `load()` mutated current state
unconditionally, with no request-id/generation check, and no synchronous guard against a
double-fired pagination request.

### RED (Step 2) — BlockTree, BlueskyEmbed, SidebarNav

Command:
`cd web && pnpm vitest run src/components/BlockTree.test.tsx src/components/BlueskyEmbed.test.tsx src/components/SidebarNav.test.tsx`

- **BlockTree**: 1 new test failed (`adopts a real authoritative collapse transition even without a
  local toggle` — chevron never reflected `node.collapsed` changing after the initial mount,
  because `useState(node.collapsed)` only seeds once). The companion test (`preserves a local
  toggle...`) already passed against old code — expected, since the old code never re-syncs at all;
  it's kept as a regression guard for the new mechanism.
- **BlueskyEmbed**: 3 new tests failed:
  - `replaces the embedded DID immediately when href moves to a different raw-DID actor` → showed
    the old DID (`xxx...`) instead of the new one (`yyy...`) — `useState`'s did-actor initializer
    only ran once.
  - `resets the reported height when href changes to a different post` → height stayed `700px`
    from post A instead of resetting for post B.
  - `resolves the DID for a valid href after starting from an invalid href` → stayed on the
    plain-link fallback forever after transitioning from an invalid href to a valid raw-DID href,
    since the effect's `actor.startsWith("did:")` early-return meant `did` was never (re)set for a
    DID actor once state existed from a prior null.
- **SidebarNav**: 5 new tests failed, including 2 genuine **unhandled promise rejections** logged
  by Vitest (`request failed: 500 /api/sidebar` from `reorder`, `request failed: 500
  /api/sidebar/1` from `removeEntry`) — confirming `removeEntry`/`reorder` had no error handling at
  all in the original code. Failures: disabled-while-in-flight, reorder-failure-caught,
  remove-failure-then-retry, and reorder-computed-from-current-entries.

```
Test Files  3 failed (3)
     Tests  9 failed | 24 passed (33)
    Errors  2 errors (unhandled rejections)
```

(One early false-negative was fixed before treating it as RED evidence: the first BlockTree test
initially failed on `getByRole` matching two "toggle children" buttons — a test-authoring bug, not
the intended assertion — corrected to `getAllByRole(...)[0]`, matching the file's existing
convention.)

### GREEN (Step 4)

Command:
`cd web && pnpm vitest run src/components/QueryBlock.test.tsx src/components/BlockTree.test.tsx src/components/BlueskyEmbed.test.tsx src/components/SidebarNav.test.tsx`

```
✓ src/components/BlueskyEmbed.test.tsx (11 tests)
✓ src/components/BlockTree.test.tsx (8 tests)
✓ src/components/QueryBlock.test.tsx (9 tests)
✓ src/components/SidebarNav.test.tsx (14 tests)

Test Files  4 passed (4)
     Tests  42 passed (42)
```

No warnings (checked output for `warn`/`unhandled`/`act(` — none present).

### Broader verification

- `cd web && pnpm typecheck` — clean (`tsc`, no errors).
- `cd web && pnpm test:coverage` — full suite green: `Test Files 72 passed (72)`, `Tests 837 passed
  (837)`, coverage report generated with no threshold failures printed.
- Full `pnpm verify` (which also runs the Playwright e2e suite via `pnpm build && playwright test`)
  was **not** run in this session — per the task instructions, that criterion is left for the
  controller to verify, and the bean's corresponding checkbox is left unchecked accordingly.

## Self-review

- **Completeness**: all four components covered per the brief's Interfaces section; double-click
  pagination, invalid→valid href, retry-after-failure, and reorder-from-stale-entries edge cases
  are all covered by dedicated tests.
- **Quality**: each fix is a small, targeted, well-commented change explaining *why* the mechanism
  is shaped the way it is (e.g. why QueryBlock uses a request-id check rather than relying solely
  on abort, why BlueskyEmbed's did-derivation is actor-keyed rather than needing an extra
  race-guard in the effect).
- **Discipline**: no generic `useAsync`/shared abstraction was introduced; each component's
  mechanism is local and named per its own domain (`requestIdRef`/`pageInFlightRef`,
  `prevAuthoritative`, `resolvedDid`/`heightKey`, `runMutation`/`laneRef`/`entriesRef`). The only
  shared addition is `defer<T>()` in `test-helpers.ts`, a small test-only utility (not production
  code), justified by all four new test suites needing precise control over out-of-order promise
  resolution.
- **Testing**: tests exercise real out-of-order resolution and rerenders via a `defer()` helper and
  `act()`-batched double-fires (verified these actually trigger the underlying bug against
  pre-fix code, rather than being trivially true), not mocked internals. Test output is pristine —
  no `act()` warnings, no unhandled rejections, confirmed by grepping the full-matrix run output.
- No overbuilding found; no files grew beyond the plan's intent (SidebarNav.tsx grew from ~125 to
  ~166 lines, which is proportionate to adding the lane/failure-state UI it needed).

## Concerns

- None blocking. One judgment call worth flagging: SidebarNav's generic failure banner text
  ("Couldn't save the change. Try again.") is separate from `addError`'s more specific 409-conflict
  message; both can appear simultaneously after a failed add (the generic banner plus the specific
  one). This matches the existing addError UX while adding the required general failure/retry
  affordance for remove/reorder, which previously had none.
- Per instructions, `pnpm verify`'s Playwright e2e leg was not re-run here; unit tests, coverage,
  and typecheck were all run and are green.

## Review fixes (post-approval Minor findings)

Two Minor findings from the Task 6 review, both real holes in the pagination guard added to
`web/src/components/QueryBlock.tsx`:

1. **Stale finally reopened the guard** — the `finally` reset was `if (from !== 0)
   pageInFlightRef.current = false`, unconditional on request currency, so a superseded expr's
   page request settling late could clear the flag while the current expr's page request was
   still outstanding.
2. **Sticky flag on `from === 0` pagination** — `loadMore` can legitimately issue a request with
   `from === 0` (degenerate backend state: empty first page but `total > 0`, leaving `offset` at
   0). The `from !== 0` check in `finally` then never reset the flag, blocking all further
   pagination forever.

**Fix (one mechanism closes both):** replaced the boolean `pageInFlightRef` with an id-keyed
`pageRequestRef: number | null` holding the owning page request's id. `loadMore` refuses while it
is non-null and stamps it with the new request id; `finally` clears it only when
`pageRequestRef.current === requestId` (ownership check — inherently currency-gated and
independent of `from`); the expr-change effect still resets it to null. A stale generation's
settle can no longer release a guard it doesn't own (finding 1), and any request that set the
flag releases it when it settles, whatever its offset (finding 2).

**Testing:**

- Finding 2 got a deterministic RED→GREEN test: `recovers the page guard after a show-more that
  paginates from offset 0`. RED against pre-fix code: `expected 2 to be 3` (the third fetch was
  blocked forever by the stuck flag). GREEN after the fix.
- Finding 1 **cannot be exercised deterministically through the DOM**, and this was verified
  empirically rather than assumed: a test was written interleaving click → stale settle →
  click inside one `act` batch, and it *passed against the unfixed code* — the microtask turn
  needed to let the stale `finally` run also lets React commit the `disabled`/`loading` rerender,
  so the second click is swallowed by the disabled button before it can reach the guard. The
  window (two clicks plus a stale settle, all inside React's pre-commit window) closes as a side
  effect of waiting for the stale settle. A test that cannot fail is worse than no test (false
  confidence), so it was removed per instructions instead of forcing a flaky variant. The fix is
  nevertheless structurally airtight: the ownership check (`pageRequestRef.current === requestId`)
  makes it impossible by construction for a non-owning request to release the guard, and the
  from===0 test plus the existing double-click and stale-expr tests pin the surrounding behavior.

**Commands run:**

- `cd web && pnpm vitest run src/components/QueryBlock.test.tsx` — 10 passed (10).
- Full Task 6 matrix: `cd web && pnpm vitest run src/components/QueryBlock.test.tsx
  src/components/BlockTree.test.tsx src/components/BlueskyEmbed.test.tsx
  src/components/SidebarNav.test.tsx` — `Test Files 4 passed (4), Tests 43 passed (43)`, no
  warnings or unhandled rejections.
- `cd web && pnpm typecheck` — clean.

Commit: `fix(web): currency-gate query pagination flag`.

The other two Minor findings (SidebarNav dual error banner, reorder test name) were deliberately
not addressed here — deferred to final whole-branch triage per the coordinator.
