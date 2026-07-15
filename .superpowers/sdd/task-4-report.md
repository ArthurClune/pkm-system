# Task 4 report: atomic same-title editor ownership

Bean: `pkm-viah`

Base: `fde798b`

## Implementation

- Added a ref-counted per-title external session store. The first real page
  bootstrap establishes the shared tree; later simultaneous bootstraps observe
  it instead of overwriting it. Every flushed optimistic, remote, DnD, refetch,
  and accepted authoritative tree is published to every handle for the title.
- Added one subscription-backed editor lease per session. Claims happen only
  from `useOutline`'s layout effect, never during render. Waiting claimants are
  promoted in order when the owner releases; subscriptions, leases, and handles
  all have idempotent cleanup, and released waiters are skipped.
- Kept focus, textarea drafts, block selection, menus, and DOM refs local to
  each `useOutline` view. Only flushed trees cross the session boundary.
- Changed `EditablePage` to render a safe inert fallback until its lease is
  granted. Fallbacks expose no textarea, focus target, app menu, draggable
  bullet, drop zone, or DnD registration. Owner and fallback share a stable
  block-row DOM so post-render hash scrolling survives lease settlement.
- Replaced the legacy render-time active-title check with an imperative
  reservation facade over the same session lease, preserving sequential
  callers while removing the check/register race.
- Changed the DnD registry to return explicit accepted/rejected registrations.
  Duplicate titles are rejected, accepted entries carry a unique token, and
  cleanup deletes only the matching token. Editor handoff re-registers the
  promoted view after the prior owner unregisters.

## TDD evidence

### Simultaneous ownership, shared tree, handoff, and DnD RED

Command:

```text
cd web && pnpm vitest run src/views/EditablePage.test.tsx src/dnd/DndContext.test.tsx
```

Result: exit 1; 7 intended failures and 30 passes. Both simultaneous and
StrictMode mounts rendered two drop zones, no fallback existed to receive the
owner's flushed tree, owner handoff began with two editors, and the old DnD API
returned no accepted/rejected registration for either cleanup order.

The new session unit suite was also run before its module existed and failed at
the missing `outlineSessions` boundary. After the minimal store was added, its
sharing, promotion, abandoned-waiter, idempotent-release, and fresh-bootstrap
contracts passed 4/4.

### Integration regression RED and root-cause trace

The first canonical run passed 739 tests and failed the existing PageView hash
flash test. A strengthened assertion proved `scrollIntoView` ran on the initial
fallback `BlockTree` row, which was then detached when the lease rerendered an
`EditableBlockTree`; the replacement row had no flash class.

The fix keeps one shell and editable-tree instance across pending, fallback,
and owner states, using an inert fallback flag instead of swapping component
types. The strengthened test now proves the scrolled element is the still-live
row and retains `flash-target`.

## Verification

- Exact Task 4 Step 5 command: 6 files / 59 tests passed.
- Expanded ownership plus PageView regression matrix: 7 files / 64 tests
  passed.
- `cd web && pnpm typecheck`: passed as the first canonical gate.
- Canonical `cd web && pnpm verify`: passed.
  - TypeScript passed.
  - Coverage passed: 70 files / 740 tests; 98.2% statements and lines,
    91.93% branches, and 95.36% functions.
  - Production/PWA build passed: 78 precache entries / 5122.89 KiB.
  - Playwright passed 6/6, including offline shell and offline reconnect.
- `git diff --check`: passed before report and bean completion and is rerun
  immediately before commit.

## Files changed

Production/runtime:

- `web/src/outline/outlineSessions.ts`
- `web/src/outline/useOutline.ts`
- `web/src/outline/activeOutlines.ts`
- `web/src/views/EditablePage.tsx`
- `web/src/components/EditableBlockTree.tsx`
- `web/src/dnd/DndContext.tsx`

Tests:

- `web/src/outline/outlineSessions.test.ts`
- `web/src/views/EditablePage.test.tsx`
- `web/src/components/EditableBlockTree.dnd.test.tsx`
- `web/src/components/EditableSidebarPanel.test.tsx`
- `web/src/dnd/DndContext.test.tsx`
- `web/src/views/PageView.test.tsx`

Tracking/report:

- `.beans/pkm-viah--eliminate-simultaneous-same-title-editor-divergenc.md`
- `.superpowers/sdd/task-4-report.md`

## Self-review

- Re-read the Task 4 brief, approved design/plan, bean, and editor/UI
  reconnaissance against the final production diff.
- Confirmed the session registry is touched only from effects or explicit
  imperative legacy reservations; no render mutates it.
- Confirmed differing simultaneous bootstraps are deterministic: the first
  non-null bootstrap wins, and later handles cannot replace an established or
  optimistic tree merely by mounting.
- Confirmed owner release cannot leak or strand a waiter: handle cleanup also
  releases every lease it created, promotion skips released waiters, and all
  cleanup paths are idempotent.
- Confirmed fallback drafts/focus/selection remain view-local and inert, while
  only flushed block trees are shared.
- Confirmed DnD duplicates cannot shadow a live API and stale cleanup cannot
  delete a newer token; integration coverage exercises promoted-owner DnD.
- Confirmed Task 1-3 sync/recovery behavior through the canonical replica,
  queue, provider, build, offline-shell, and offline reconnect gates.
- All edited runtime modules retain accurate Imperative Shell classifications.
  The canonical run continues to print only the pre-existing expected SQLite
  foreign-key diagnostic, route warning, Node localStorage warning, and build
  chunk-size warning.

## Independent review fix: once-only remote session dispatch

Independent review identified that sharing block snapshots alone did not make
remote reduction single-owned. Every same-title `useOutline` still subscribed
to `Sync`; the first listener applied and synchronously published a batch, then
the second listener reduced the same batch against that advanced tree. Moves
therefore shifted sibling `order_idx` values twice, and an unknown cross-page
target launched one authoritative GET per mounted view.

### Review RED

Command:

```text
cd web && pnpm vitest run src/outline/useOutline.dnd.test.tsx
```

Result: exit 1; 2 intended failures and 8 passes. One move produced sibling
indices `0,2,3` instead of once-applied `0,1,2`, and one target batch issued two
GETs instead of one. A separate session single-flight test failed at the absent
`requestAuthoritative` boundary while its existing 4 tests passed.

### Session-owned GREEN

The session now weakly records the exact `WsBatch` objects fanned out by
`SyncProvider`. The first handle atomically reduces the batch against the
session snapshot and publishes before notifications; later same-title
listeners see the object and do nothing. This ownership belongs to the session,
not the editor lease, so fallback subscriptions and lease handoff have no
delivery gap.

Authoritative target reads are also session-owned and single-flight. All
callers share the active promise, the loaded tree is published once, and
`finally` clears the flight so a failed read can retry. Shared adoption
revalidates each view's focus against the tree while drafts and block selection
remain view-local.

Fresh review-fix verification:

- Remote/session focused: 2 files / 15 tests passed.
- Exact Task 4 Step 5: 6 files / 60 tests passed.
- Expanded ownership, reconciliation, DnD, sidebar, and PageView matrix:
  8 files / 75 tests passed.
- `cd web && pnpm typecheck`: passed.
- Canonical `cd web && pnpm verify`: passed; 70 unit files / 743 tests,
  98.21% statements and lines, 91.96% branches, 95.38% functions, production
  PWA build with 78 entries / 5123.43 KiB, and Playwright 6/6.
