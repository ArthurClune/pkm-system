# Task 5 report: versioned authoritative outline reads

Bean: `pkm-z77x`

Base: `0afc421`

## Implementation

- Added `outlineState.ts`, a true Functional Core for per-title revisions,
  monotonic read tokens, relevant ticket ids, newest deferred payloads, safe
  adoption, replacement-read effects, and focus validation. It imports no
  React, fetch, timers, queue, worker, or UID source.
- Moved authoritative reconciliation into the Task 4 per-title session. Every
  local/remote state change advances the shared revision. Same-title views
  share read causality as well as blocks, while focus, drafts, selection, and
  editor leases remain view-local.
- Added request sequencing and session read tokens to PageView, sidebar panel,
  Journal resync, target-side cross-page reads, and settlement repair. A stale
  transport response is discarded before entering the session; a causally old
  payload is retained/replaced by one guarded fresh read rather than blindly
  adopted.
- Replaced global `Sync.pending`/`Sync.settled()` outline gates with ticket
  scopes. Normal edits use `["page", title]`; cross-page moves use
  `["page", source, target]` and route the ticket through the session registry,
  including a read-only target fallback with no DnD editor registration.
- Extended Task 1's ticket distinction through server delivery. `settled`
  still means durable persistence; the new `delivered` promise resolves per
  ticket only after its ops POST is acknowledged (or terminally fails).
  Outline reconciliation drains relevant work on delivery, so an own-echo
  repair GET cannot overtake its own POST. Replica tickets match durable
  `batch_id`; legacy tickets consume acknowledged op counts across the existing
  500-op batching boundary.
- Kept Task 1-4 behavior intact: durable offline persistence remains separate
  from delivery, retryable/offline tickets remain relevant, rejected tickets
  settle into the existing poison repair path, remote batches apply once per
  title session, and editor/DnD ownership remains atomic.

## TDD evidence

### Pure causality RED

`pnpm vitest run src/outline/outlineState.test.ts` failed because the module did
not exist. The 10-test GREEN suite covers state-changing revisions, unchanged
adoption, edit-after-dispatch, remote advance, newest deferred wins, relevant
settlement, unrelated titles, stale tokens, focus invalidation, and one fresh
read instead of pre-edit adoption.

### Hook and parent concurrency RED

The initial hook/parent matrix had four behavioral failures while the existing
DnD suite remained green:

- an old target read erased a split and its focus;
- global Page B pending work blocked safe Page A adoption;
- own-echo persistence settlement launched no repair read; and
- PageView resync erased a split made after dispatch.

The token/session integration makes all four contracts deterministic without
global idle gating.

### Delivery-order RED and root-cause trace

The first canonical browser run showed the fresh GET repeatedly removing an
active editor row. Request tracing proved the GET was dispatched before its own
`/api/ops` POST because Task 1 `settled` intentionally means persistence only.
Two queue REDs then proved replica and legacy tickets had no per-ticket delivery
signal. Their GREEN tests hold the POST and assert `delivered` remains pending
until acknowledgement. The hook regression separately proves persistence alone
does not fetch, while delivery settlement triggers the own-echo repair.

## Verification

- Exact Task 5 Step 5: 7 files / 72 tests passed.
- Queue/session/DnD compatibility: 4 files / 58 tests passed.
- `pnpm typecheck`: passed.
- Fresh production build: passed; PWA precache 78 entries / 5129.53 KiB.
- Fresh Playwright run against that build: 6/6 passed, including editor,
  offline shell, and offline reconnect.
- Canonical `pnpm verify`: passed.
  - TypeScript passed.
  - Coverage passed: 72 files / 760 tests; 97.95% statements and lines,
    91.81% branches, and 95.58% functions.
  - Production/PWA build passed: 78 precache entries / 5129.53 KiB.
  - Playwright passed 6/6, including editor, offline shell, and reconnect.
- `git diff --check`: passed after the final report/bean update.

## Files changed

Functional core and session/hook:

- `web/src/outline/outlineState.ts`
- `web/src/outline/outlineState.test.ts`
- `web/src/outline/outlineSessions.ts`
- `web/src/outline/outlineSessions.test.ts`
- `web/src/outline/useOutline.ts`
- `web/src/outline/useOutline.reconciliation.test.tsx`
- `web/src/outline/useOutline.dnd.test.tsx`

Authoritative parent shells and ticket scoping:

- `web/src/views/PageView.tsx`
- `web/src/views/PageView.test.tsx`
- `web/src/views/Journal.tsx`
- `web/src/components/EditableSidebarPanel.tsx`
- `web/src/views/EditablePage.test.tsx`
- `web/src/dnd/DndContext.tsx`
- `web/src/dnd/DndContext.test.tsx`
- `web/src/test-helpers.ts`

Per-ticket delivery completion required by own-echo causality:

- `web/src/sync/opQueue.ts`
- `web/src/sync/opQueue.test.ts`
- `web/src/sync/opQueue.replica.test.ts`
- `web/src/replica/client.ts`
- `web/src/replica/client.test.ts`
- `web/src/replica/queue.ts`
- `web/src/replica/workerHandlers.test.ts`
- `web/src/components/OfflineIndicator.test.tsx`

Tracking/report:

- `.beans/pkm-z77x--prevent-outline-refetches-from-overwriting-or-disc.md`
- `.superpowers/sdd/task-5-report.md`

## Self-review

- The Functional Core contains only data transitions and pure tree helpers;
  every network, promise, registry, subscription, and lease remains in an
  accurately labelled Imperative Shell.
- Read tokens are allocated before dispatch. Transport sequence checks happen
  before session delivery. Only the latest request at an unchanged revision
  with no relevant delivery ticket can adopt directly.
- A response that advanced behind local/remote state never overwrites it. The
  newest candidate is either reconsidered when relevant delivery settles or
  superseded by one guarded read; it is never silently forgotten.
- Scope parsing is title-specific. An unrelated page ticket never enters this
  session, while cross-page source and target sessions both receive the same
  ticket even if one is a read-only fallback.
- Server delivery promises preserve FIFO and retry semantics. Offline and 5xx
  work stays unresolved; success resolves exactly the acknowledged ticket;
  4xx/dispose resolve terminal failure without resuming poison-blocked work.
- Parent handles keep Journal/page/sidebar sessions and loaders alive across
  resync unmount windows. Same-title leases, once-only remote reduction,
  view-local drafts/focus/selection, hash DOM stability, and DnD token cleanup
  remain owned by Task 4 boundaries.

## Independent-review reconciliation

Review of `ca13148` found five remaining races. The follow-up fixes make these
contracts explicit:

- A response captured before a relevant ticket's delivery is never adopted
  after that delivery, even when its request happened to dispatch after the
  local edit. Settlement clears the candidate and requests one guarded fresh
  read.
- Journal requests reserve dispatch-time causality for every active outline.
  A title whose session appears during the request, or whose later read wins,
  keeps its session tree and receives a dedicated fresh page read.
- A session remains registered while it owns handles, captured reservations,
  tracked delivery tickets, or an authoritative read. Release/reacquire no
  longer loses local state or read causality.
- Replica workers that omit batch ids now associate tickets with their FIFO
  durable position. Each success or terminal 4xx settles the matching ticket
  without waiting for the entire queue to empty; later retryable work remains
  pending.
- Disposal while `replica.enqueue` is awaited resolves that ticket's delivery
  exactly once as terminal failure and does not restart draining.

### Follow-up RED

`pnpm vitest run src/outline/outlineState.test.ts
src/outline/useOutline.reconciliation.test.tsx
src/outline/outlineSessions.test.ts src/views/Journal.test.tsx` failed with
7 expected regressions and 23 passes: two pre-delivery candidates were adopted,
two released sessions lost their pinned state, two Journal responses overwrote
mid-flight session changes, and the hook launched no guarded fresh read.

`pnpm vitest run src/sync/opQueue.replica.test.ts` failed with 3 expected
regressions and 27 passes: the earlier unkeyed success and matching unkeyed 4xx
ticket remained unresolved, and dispose-during-enqueue left delivery pending.

### Follow-up GREEN and final verification

- Outline review suite: 4 files / 30 tests passed.
- Queue/replica review suite: 4 files / 69 tests passed.
- Exact Task 5 Step 5 command: 7 files / 75 tests passed.
- `src/views/EditablePage.test.tsx`: 30/30 passed after its deliberately
  unsettled ticket was made controllable and completed during teardown.
- `pnpm typecheck`: passed.
- `pnpm verify`: passed: 72 files / 768 unit tests; 98.08% statements and
  lines, 91.78% branches, 95.64% functions; production/PWA build with 78
  precache entries / 5130.32 KiB; Playwright 6/6.
- `git diff --check`: passed before report/bean update and is rerun immediately
  before commit.

Follow-up files changed relative to `ca13148`:

- `.beans/pkm-z77x--prevent-outline-refetches-from-overwriting-or-disc.md`
- `.superpowers/sdd/task-5-report.md`
- `web/src/outline/outlineState.ts`
- `web/src/outline/outlineState.test.ts`
- `web/src/outline/outlineSessions.ts`
- `web/src/outline/outlineSessions.test.ts`
- `web/src/outline/useOutline.reconciliation.test.tsx`
- `web/src/views/Journal.tsx`
- `web/src/views/Journal.test.tsx`
- `web/src/views/EditablePage.test.tsx`
- `web/src/sync/opQueue.ts`
- `web/src/sync/opQueue.replica.test.ts`

## Second independent-review fix wave

Review of `4948566` exposed three remaining lifetime boundaries. The fixes
retain the Task 1-5 contracts while making ownership explicit at each boundary.

### Root causes

- The legacy queue flattened every enqueue into one op array, but kept ticket
  completion separately. A 4xx cleared the entire op array and failed every
  delivery, so tickets wholly behind the rejected 500-op transport batch were
  lost. It also had no repair barrier: the drain loop immediately continued.
- Cross-page ticket routing enumerated only sessions that existed at dispatch.
  No central unresolved-ticket registry existed, so a target opened before its
  move POST could accept a pre-POST payload and never participate in delivery
  settlement or the guarded own-echo refresh.
- `beginAuthoritativeRead()` advanced causality but owned no reservation.
  Releasing the final handle deleted the session, and failure, supersession,
  and unmount had no explicit token cancellation path.

### RED evidence

`pnpm vitest run src/sync/opQueue.test.ts
src/outline/outlineSessions.test.ts` failed with 4 expected regressions and 26
passes: the legacy rejection drained instead of returning a recovery barrier;
the late target adopted `pre-POST target`; release/reacquire returned `stale
bootstrap`; and `cancelAuthoritativeRead` did not exist.

`pnpm vitest run src/views/PageView.test.tsx
src/components/EditableSidebarPanel.test.tsx` failed with 2 expected
regressions and 13 passes: both failed fetches left their title session active
after unmount.

`pnpm vitest run src/outline/outlineSessions.test.ts
src/sync/SyncProvider.test.tsx src/components/OfflineIndicator.test.tsx` failed
with 3 expected regressions and 50 passes: the active-session repair helper did
not exist, later legacy delivery timed out behind an unreleased barrier, and
the new visible legacy repair state was not renderable.

### Production fixes

- A legacy 4xx now fails exactly the tickets touched by the rejected transport
  batch, discards the complete remaining portion of any ticket spanning the
  500-op boundary, retains wholly later tickets and ops, and returns
  `blocked/recovering`. Later POSTs require an explicit recovery release.
- The no-replica SyncProvider integration now repairs all active outline
  sessions through their single-flight authoritative loaders before bumping
  resync and releasing legacy delivery. A failed read leaves delivery paused,
  exposes a connected Retry state, and Retry reruns the guarded repair without
  retrying the rejected operations.
- Scoped cross-page tickets are retained centrally until their `delivered`
  terminal outcome. Session acquisition attaches every matching unresolved
  ticket, preserving title scoping and `trackWrite` idempotence for targets
  opened after dispatch, including Journal-created sessions.
- Manual token reads now reserve the session until receive or explicit cancel.
  Successful receive, failed fetch, supersession, and unmount release exactly
  once. PageView and EditableSidebarPanel cancel their outstanding tokens on
  all non-success paths; requestAuthoritative single flight and Journal
  captures keep their existing ownership models.

The expected test list was expanded with `SyncProvider.test.tsx` and
`OfflineIndicator.test.tsx` because the requested legacy `onDesync` release
boundary necessarily belongs to the provider and its visible retry UI.

### GREEN verification

- Focused review matrix: 8 files / 99 tests passed.
- Required outline/UI command: 7 files / 79 tests passed.
- Required queue/replica command: 4 files / 70 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 778 unit tests; 97.93%
  statements and lines, 91.51% branches, and 95.86% functions; production/PWA
  build with 78 precache entries / 5132.76 KiB; Playwright 6/6.
- `git diff --check`: passed before report/bean update and is rerun after the
  final commit.

### Self-review

- The queue rejection calculation uses outstanding ticket lengths, so a
  partially acknowledged ticket and a ticket crossing `MAX_BATCH` both reach
  one terminal outcome without allowing their remainder to reapply. Offline,
  5xx retry, dispose, replica poison repair, and durable settlement paths are
  unchanged.
- The unresolved registry holds tickets, not sessions. Zero-handle target
  titles are created only by real consumers, and registry entries disappear on
  either delivered success or terminal failure.
- Manual read reservations share the existing session reservation count but
  use request ids for idempotent receive/cancel. A released handle may complete
  the read it started into a synchronously reacquired session; a cancelled or
  late duplicate response is ignored and cannot leak the session.
- Legacy repair remains an Imperative Shell path. It reuses per-title loader
  single flight, exposes failure rather than silently stranding later writes,
  and never retries the rejected operation.
