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

## Third independent-review fix wave

Review of `16036e7` exposed four remaining causality gaps at settlement and
registration boundaries.

### Root causes

- Final ticket settlement queued a replacement read but left an already
  in-flight automatic token valid long enough to publish a pre-POST response.
- Legacy repair reused any existing read promise and treated transport
  completion as repair completion; it neither forced post-rejection adoption
  nor rejected visibly when an active session had no loader.
- Only the cross-page DnD branch registered unresolved scoped tickets, so
  same-page and other page-scoped enqueue paths could bypass session tracking.
- Newer automatic and manual controllers advanced request causality without
  expiring older manual reservations, which could pin sessions and leave stale
  manual receive paths live.

### RED evidence

- Targeted outline-session runs failed the three automatic/manual invalidation
  regressions, the existing-read legacy repair regression, the post-rejection
  adoption/rebase regression, and the missing-loader rejection regression.
- The pure-state repair test retained rejected local state instead of adopting
  the server snapshot and replaying only the unresolved later ticket.
- The two targeted SyncProvider tests failed because legacy repair completed
  without a forced adopted read and because the enqueue boundary did not
  register the page ticket before a session opened.

### Production fixes

- Final settlement immediately supersedes the live automatic token and still
  launches exactly one queued replacement after its transport completes.
- Legacy repair now owns an explicit forced-read barrier: it invalidates older
  controllers, waits out existing transport, requires an active loader, adopts
  a fresh server snapshot, and reapplies only still-unresolved ticket ops.
- SyncProvider registers every page-scoped enqueue in the unresolved outline
  registry with its ops; DnD no longer carries a branch-specific registration.
- Starting or activating a newer controller expires older manual read ids and
  releases their reservations; late receive/cancel calls are idempotent no-ops.

### GREEN verification

- Focused review matrix: 4 files / 68 tests passed.
- Controller outline gate: 4 files / 41 tests passed.
- Controller queue/replica gate: 4 files / 70 tests passed.
- Controller Task 5 UI gate: 7 files / 78 tests passed.
- Controller integration gate: 5 files / 100 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 787 unit tests; 97.97%
  statements and lines, 91.52% branches, and 95.89% functions; production/PWA
  build with 78 precache entries / 5134.53 KiB; Playwright 6/6.
- `git diff --check 16036e7`: passed before documentation updates and is rerun
  at the final commit boundary.

### Self-review

- Repair is distinct from ordinary single-flight refresh: its promise resolves
  only after a forced response is actually integrated, and loader absence is a
  retry-visible failure rather than silent success.
- Rebase data is keyed by ticket and deleted at settlement, so the rejected
  ticket is not retried while wholly later unresolved operations remain visible.
- Central registration remains title-scoped and idempotent. Unrelated titles do
  not block adoption, and the registry entry disappears at terminal delivery.
- Token expiry is monotonic by request id and adjusts the shared reservation
  count exactly once, preserving session lifetime without accepting stale calls.

## Fourth independent-review fix wave

Review of `c461d6c` showed that forced repair still lacked one coherent
transaction boundary across revision checks, optimistic replay, and the live
session cohort.

### Root causes

- `authoritative-repair` checked only the latest request id. A real remote
  transition changed the tree revision without changing that id, so an older
  forced GET could overwrite the remote state and falsely complete repair.
- Replay retained only wire `BlockOp`s. A target-side cross-page move inserts a
  detached subtree locally, but its wire move cannot reconstruct a UID absent
  from the pre-POST target snapshot; later child operations were consequently
  skipped as well.
- `repairActiveOutlineSessions()` snapshotted `sessions` once and stored repair
  ownership per session. A session acquired while another loader was held was
  outside the barrier, allowing SyncProvider to resume later POSTs first.

### RED evidence

- `pnpm vitest run src/outline/outlineState.test.ts -t "rejects a repair
  response|replays an explicit target subtree"` failed 2/2 selected tests: the
  stale repair replaced `remote advance`, and the target subtree was absent.
- `pnpm vitest run src/outline/outlineSessions.test.ts -t "keeps repair
  pending|enrolls sessions acquired|reports a missing loader|rebases a
  cross-page"` failed 4/4 selected tests: stale forced data published, the late
  loader was never called, a live missing loader silently succeeded, and the
  target move/child edit disappeared.
- `pnpm vitest run src/dnd/DndContext.test.tsx -t "cross-page drop does"`
  failed 1/1 because DnD attached no target replay metadata.
- `pnpm vitest run src/sync/SyncProvider.test.tsx -t "legacy repair enrolls a
  session"` failed 1/1 because the second active page was not repaired before
  queue resume.
- The self-review RED for already-present target UIDs failed 1/1: insertion
  left both a root copy and a nested copy instead of relocating one subtree.

### Production design

- The pure core now models replay as ordered `OutlineReplayAction` descriptors
  keyed by ticket. Generic writes use an ops action; cross-page DnD attaches a
  title-specific detached-subtree action, including its parent and order. The
  Sync enqueue boundary remains the only global ticket registration point.
- Target metadata replaces only that title's generic replay in the existing
  registry record. Source semantics remain the wire move, later ticket actions
  run in insertion order, and terminal settlement removes all descriptor data.
  An already-present target UID is moved rather than duplicated.
- Repair adoption requires both the latest request id and the unchanged
  dispatch revision. A remote advance makes the response a no-op and leaves the
  member pending for one newer awaited loader response.
- One Shell-owned repair epoch repeatedly scans all sessions with live handles.
  It records the exact adopted core state per member, so acquisitions and any
  post-adoption state change re-enter the cohort. Released newcomers are
  ignored and collect normally; live missing loaders reject visibly. The final
  stable-cohort callbacks include SyncProvider queue resume and run
  synchronously before the epoch is cleared.

### GREEN verification

- Focused review matrix: 5 files / 90 tests passed.
- Controller outline gate: 4 files / 49 tests passed.
- Controller queue/replica gate: 4 files / 70 tests passed.
- Controller Task 5 UI gate: 7 files / 82 tests passed.
- Controller integration gate: 5 files / 101 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 796 unit tests; 97.84%
  statements and lines, 91.43% branches, and 95.57% functions; production/PWA
  build with 78 precache entries / 5136.13 KiB; Playwright 6/6.
- `git diff --check c461d6c`: passed before documentation updates and is rerun
  at the final commit boundary.

### Self-review

- The epoch has no broad revision bypass and no per-session repair flag. Every
  retry follows an awaited transport or cohort rescan, and completion proves an
  adopted state for every currently handled session.
- The provider resumes the legacy queue inside the epoch's stable callback, so
  there is no promise boundary between the final cohort check and later POSTs.
- Replay descriptors contain only the optimistic information the server op
  lacks. They remain title-scoped, ordered by the existing ticket set, and are
  removed before rejected/terminal tickets can participate in repair.
- Existing automatic-read invalidation, manual reservations, Journal capture,
  late session tracking, queue FIFO/4xx/dispose behavior, retry UI, and
  Task 4 editor/DnD/view-local ownership continue through their prior paths.

## Fifth independent-review fix wave

Review of `2ebd54d` found one legacy-queue ownership handoff where an empty
repair could resume delivery while the rejected drain still owned the pump.

### Root cause

- Legacy `runDrain()` invokes `onDesync` before its promise finalizer clears
  `drainRun`. An empty asynchronous repair can therefore call `resume()` while
  the old drain is still present; its `kick()` was discarded, even though the
  old drain had already chosen the blocked outcome.
- A wholly later ticket then remained pending indefinitely because the old
  drain returned without another loop iteration and its finalizer only cleared
  ownership. This affected the legacy path only; replica delivery already has
  its own `drainAgain` handoff.

### RED evidence

- `pnpm vitest run src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx -t
  "async recovery resume|empty legacy repair"` failed both selected tests: the
  direct queue and provider integration each observed only one POST instead of
  the later ticket's second POST.
- Before the production change, `pnpm vitest run src/sync/opQueue.test.ts -t
  "missed in-flight kick remains|dispose drops a missed|missed in-flight kick
  does not bypass|in-flight POST completes after going offline|ops enqueued
  while a batch is in flight"` passed all 5 selected guard tests.

### Production design

- The legacy queue now remembers an eligible kick that arrives while
  `drainRun` owns the pump. Its finalizer consumes that intent, clears ownership
  first, and hands the pending work back through the ordinary guarded `kick()`.
- `kick()` rejects intent before recording it when the queue is offline,
  recovering, disposed, or waiting on a 5xx retry timer. Normal in-flight
  enqueue still coalesces into one successor drain, and dispose/recovery remain
  authoritative.
- No replica code changed.

### GREEN verification

- Focused primary and guard matrix: 2 files / 7 selected tests passed.
- Full focused matrix: 2 files / 56 tests passed.
- Controller queue/replica gate: 4 files / 74 tests passed.
- Controller Task 5 UI gate: 7 files / 82 tests passed.
- Controller outline gate: 4 files / 49 tests passed.
- Controller epoch/replay integration gate: 5 files / 91 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 801 unit tests; 97.84%
  statements and lines, 91.51% branches, and 95.57% functions; production/PWA
  build with 78 precache entries / 5136.21 KiB; Playwright 6/6.

### Self-review

- The handoff flag is set only after all normal eligibility guards pass, so a
  missed in-flight enqueue cannot bypass offline, recovery, disposal, or the
  scheduled 5xx backoff.
- The finalizer clears both the flag and drain ownership before re-entering
  `kick()`, preserving a single pump owner and allowing current state to veto
  stale intent.
- The pending-length check avoids scheduling an empty successor. Existing
  FIFO, batching, terminal delivery, and replica contracts retain their prior
  implementations.

## Sixth independent-review fix wave

Review of `b0f05c3` found that cross-page replay metadata was still coupled to
whether the target outline happened to be mounted at drop time.

### Root cause

- DnD detaches the complete source node before looking up the destination
  registration, so the subtree, parent, and order metadata are available even
  when the target is unmounted.
- The move ticket is centrally registered for both page titles at enqueue, but
  `attachOutlineReplay()` ran only under `dst && node`. A target acquired during
  legacy repair therefore inherited only the generic wire move, which cannot
  insert a UID absent from its pre-move server snapshot.

### RED evidence

- `pnpm vitest run src/dnd/DndContext.test.tsx src/sync/SyncProvider.test.tsx
  -t "unregistered target only removes|unmounted cross-page target"` failed
  both selected tests. DnD made zero replay-attachment calls for the unmounted
  target, and the provider regression initially observed only the target
  server child at the second POST boundary.
- After allowing the repair epoch its valid stabilizing reread, the provider
  RED failed specifically because the moved subtree and nested child were
  absent before delivery resumed.

### Production design

- Immediate optimistic insertion remains guarded by `dst && node`.
- Target replay attachment is now guarded by `node` alone. The detached source
  subtree is attached to the already centrally registered ticket regardless of
  target mount state.
- No metadata is fabricated when the source is absent or cannot detach the
  node; the generic multi-title move remains unchanged.

### GREEN verification

- Focused RED/GREEN pair: 2 files / 2 selected tests passed.
- Cross-page focused matrix, including the source-absent guard: 2 files / 4
  selected tests passed.
- Full DnD/outline/session/provider matrix: 4 files / 80 tests passed.
- Controller queue/replica gate: 4 files / 74 tests passed.
- Controller Task 5 UI gate: 7 files / 82 tests passed.
- Controller outline gate: 4 files / 49 tests passed.
- Controller epoch/replay integration gate: 5 files / 93 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 803 unit tests; 97.87%
  statements and lines, 91.57% branches, and 95.74% functions; production/PWA
  build with 78 precache entries / 5136.20 KiB; Playwright 6/6.

### Self-review

- Replay metadata still replaces only the target title's generic action on the
  same unresolved ticket. Central registration, ticket order, terminal cleanup,
  and source wire-move semantics are unchanged.
- Mounted targets retain their immediate local insertion path; unmounted
  targets defer the same deterministic subtree/location action until a session
  joins and repair adopts its authoritative snapshot.
- The source-absent guard proves that `node === null` triggers neither local
  insertion nor replay attachment. Repair epoch membership, loader failures,
  revision barriers, and synchronous queue release retain their prior paths.

## Seventh independent-review fix wave

Review of `9eb96cc` found that overlapping token-aware parents could still
publish an expired response and reset the shared core before the newer response
arrived.

### Root cause

- Two unbootstrapped same-title parents can start manual reads `r1` and `r2`;
  `r2` correctly expires `r1`. Manual receipt returned `void`, however, so the
  older PageView or sidebar could not observe rejection and unconditionally
  rendered an empty `EditablePage` child.
- That child acquired the existing unbootstrapped session with `[]`.
  `acquireOutlineSession()` recreated the entire `OutlineState`, resetting
  request ids, revisions, relevant writes, and deferred causality. The live
  `r2` token then no longer matched and its newer response was discarded.
- The same recreate branch could overwrite an unresolved local write and reuse
  a cancelled manual request id even outside the parent-shell race.

### RED evidence

- `pnpm vitest run src/outline/outlineSessions.test.ts
  src/views/PageView.test.tsx -t "expired unbootstrapped parent|existing-session
  bootstrap|genuine later bootstrap|expired same-title parent"` failed all 4
  selected tests. The shared result stayed empty, the local write became the
  stale bootstrap, request id 1 was reused, and PageView published the expired
  empty child.
- With Sidebar's old unconditional publication restored,
  `pnpm vitest run src/components/EditableSidebarPanel.test.tsx -t "expired
  sidebar parent"` failed because the expired response rendered the empty
  `Click to start writing` child before the newer PageView response won.

### Production design

- Manual-token `receiveAuthoritative()` now returns whether that reservation
  was still owned and its request id was still current. Reservation release is
  still exact-once in `finally`; cancelled, expired, or stale tokens return
  false without marking the session bootstrapped.
- PageView and EditableSidebarPanel publish response metadata and mount their
  child only when receipt returns true. A valid response that is deferred by a
  local revision remains accepted and publishes the current shared snapshot.
- Existing-session bootstrap is allowed only when revision, relevant/deferred
  writes, manual/captured reservations, automatic-read ownership, and queued
  authoritative intent are all idle. It replaces only `blocks` in the existing
  state, preserving monotonic request ids and all core identity.

### GREEN verification

- Focused seventh-wave matrix: 3 files / 5 selected tests passed.
- DnD/outline/session/provider matrix: 4 files / 83 tests passed.
- Controller queue/replica gate: 4 files / 74 tests passed.
- Exact controller Task 5 UI gate: 7 files / 84 tests passed.
- Controller outline gate: 4 files / 52 tests passed.
- `pnpm typecheck`: passed. Its first run caught an internal
  `Promise<boolean>` inference; automatic single-flight reads now explicitly
  discard the receipt result and retain their `Promise<void>` contract.
- Canonical `pnpm verify`: passed: 72 files / 808 unit tests; 97.88%
  statements and lines, 91.57% branches, and 95.75% functions; production/PWA
  build with 78 precache entries / 5136.57 KiB; Playwright 6/6.

### Self-review

- Bootstrap safety is independent of `handles`. A zero-handle session retained
  by a reservation, automatic request, or relevant ticket cannot reset; once
  truly idle it is normally collected, while a still-live idle unbootstrapped
  session can accept genuine initial data without reusing request ids.
- Expiring an older manual read still removes its reservation immediately.
  Late receive/cancel calls are false/idempotent no-ops, and the newer token
  releases the remaining reservation exactly once.
- Repair epochs, captured Journal reservations, relevant ticket replay, DnD
  metadata, queue liveness, same-title editor leases/shared publication, and
  Task 4 view-local state continue through their prior paths.

## Eighth independent-review fix wave

Review of `04feef1` found that an expired same-title parent remained in its
loading state even after the newer parent succeeded, and no parent was elected
when the newest request failed or its pane unmounted.

### Root cause

- Manual receipt correctly rejected an expired token, but only the current
  parent received the winning response. The loser had neither mounted a shared
  outline subscriber nor retained a readiness path for the full `PagePayload`,
  so returning early left it loading forever.
- Parent fetch ownership lived entirely inside each component. Expiring a
  token removed the older reservation, but failure or unmount of the newest
  owner could leave no active request and no deterministic controller to start
  one.
- Sharing blocks alone was insufficient: PageView and Sidebar also require the
  winning page metadata, backlinks, and block-reference text map.

### RED evidence

- The six-case focused command failed all 6 selected tests before production
  changes. Both inverted-success cases rendered the winner in only one of two
  panes; the losing-failure case also rendered only one copy; winner failure
  and winner unmount stopped at two fetches instead of electing a third; and a
  terminal 404 made one request instead of the bounded two-attempt contract.
- The inverted PageView and Sidebar assertions were strengthened from winner
  presence to exactly two rendered copies. New regressions keep both panes
  mounted, cover losing transport failure, cover newer failure and unmount,
  assert zero stale errors, and prove the shared winner includes
  `block_ref_texts`, not only blocks.

### Production design

- Each title session now retains the latest accepted full parent payload and
  lets expired parents await only a strictly newer accepted request. Successful
  receipt normalizes that payload to the shared outline snapshot, then resolves
  every eligible parent waiter with the same metadata and block tree.
- Parent shells register synchronous controller callbacks with the session.
  When the current manual read fails or is cancelled, a microtask elects the
  newest surviving controller after manual, automatic, and repair ownership is
  idle. Component cleanup unregisters its controller before cancellation, so
  unmount cannot re-elect the departing pane.
- An election is capped at one fresh controller attempt. A second failure
  rejects the waiters with the real transport error, preventing a fetch storm;
  a later external parent/resync generation or an accepted payload resets that
  cap. Ordinary deferred resyncs retain their prior block-only repair path and
  do not spuriously request a replacement full payload.
- Waiters and controller registrations are handle-owned and removed on
  release. Manual reservations, stale-token rejection, repair epochs, and the
  existing authoritative block loader remain separate contracts.

### GREEN verification

- Focused parent readiness/election matrix: 2 files / 6 selected tests passed.
- Full parent integration matrix: 2 files / 20 tests passed.
- DnD/outline/session/provider command: 4 files / 77 tests passed.
- Controller queue/replica gate: 4 files / 74 tests passed.
- Exact controller Task 5 UI gate: 7 files / 87 tests passed.
- Controller outline gate: 4 files / 52 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 811 unit tests; 97.70%
  statements and lines, 91.24% branches, and 95.83% functions; production/PWA
  build with 78 precache entries / 5139.52 KiB; Playwright 6/6.

### Self-review

- Request-id ordering prevents an already accepted older payload from
  satisfying a failed newer parent. The elected request must itself win before
  either pane renders it.
- Election happens only with waiting parent shells and no active session read,
  is microtask-coalesced, and has a one-recovery cap. Success clears prior
  failure state; terminal failure surfaces once without recursive retries.
- Losing success, losing failure, winner failure, winner unmount, and terminal
  failure all release their reservations exactly once. Session collection,
  shared editor leases, deferred local-write reconciliation, DnD replay,
  Journal capture, repair epochs, and queue/replica invariants retain their
  existing focused coverage.

## Ninth independent-review fix wave

Review of `a7ca2a5` found that the one-attempt parent recovery cap did not
distinguish a terminal elected attempt from one superseded by a block-only
automatic read or repair epoch.

### Root cause

- Election spent `parentRecoveryAttempted` before starting the elected manual
  parent request, but retained no identity for that request.
- Automatic reads and repair epochs correctly started newer request ids and
  expired the elected manual reservation. Once their block-only work completed,
  the full-payload waiters were still present, but the spent boolean made the
  scheduler reject them instead of electing a replacement parent.
- The expired elected transport could only return stale later. Neither its
  response nor the successful block-only controller could supply the page
  metadata, backlinks, and block-reference map required by the waiting shells.

### RED evidence

- `pnpm vitest run src/views/PageView.test.tsx -t "automatic read superseding
  elected recovery|repair superseding elected recovery"` failed both selected
  tests before the production change. The automatic case stopped at 3 parent
  fetches instead of the required replacement fourth; the repair case stopped
  at 4 instead of the post-repair fifth.
- Both regressions keep PageView and Sidebar mounted, fail the newest initial
  parent, hold elected R3, supersede it with a real session automatic read or
  `repairActiveOutlineSessions()`, and require exactly one newer full-payload
  controller. They assert two copies of the winning tree and reference
  metadata, zero errors, and no resurrection from R3's late response.

### Production design

- The session now records the request id started by its elected parent
  controller. The recovery attempt remains spent while that request owns
  causality.
- Starting a strictly newer authoritative request clears the elected identity
  and restores recovery eligibility. This is centralized where newer requests
  expire manual reservations, so automatic reads, both repair-epoch phases,
  and captured authoritative activation share the same ownership rule.
- Successful full-payload publication clears both the identity and cap.
  Genuine failure or cancellation of the elected request clears only its
  identity and leaves the cap spent, preserving bounded terminal behavior.
- Repair waiters remain pending while `activeRepairEpoch` is non-null. The
  existing epoch completion finalizer schedules election only after the cohort
  is fully stable and the epoch releases ownership; its block-only result is
  never substituted for a full `PagePayload`.

### GREEN verification

- Focused supersession RED/GREEN pair: 1 file / 2 selected tests passed.
- Focused supersession plus terminal-cancel guard: 1 file / 3 selected tests
  passed. Cancelling elected recovery produced one error and no second retry.
- Full parent integration matrix: 2 files / 23 tests passed.
- DnD/outline/session/provider matrix: 4 files / 77 tests passed.
- Epoch/replay integration matrix: 5 files / 93 tests passed.
- Controller queue/replica gate: 4 files / 74 tests passed.
- Exact controller Task 5 UI gate: 7 files / 90 tests passed.
- Controller outline gate: 4 files / 52 tests passed.
- `pnpm typecheck`: passed.
- Canonical `pnpm verify`: passed: 72 files / 814 unit tests; 97.79%
  statements and lines, 91.34% branches, and 95.83% functions; production/PWA
  build with 78 precache entries / 5139.93 KiB; Playwright 6/6.

### Self-review

- Eligibility is restored by request-id supersession, not by elapsed time,
  block-only success, or a late stale response. Microtask coalescing and the
  active manual/automatic/repair guards still prevent duplicate elections.
- The late elected response is rejected by the existing newest-request check
  after both automatic and repair supersession; tests resolve it after the
  replacement winner and assert it never renders.
- The terminal-cancel characterization proves the ownership field does not
  broaden the retry cap. The existing terminal-failure/404 test continues to
  require exactly two total attempts.
- Reservation release, full-payload readiness, repair stabilization, session
  collection, DnD replay, queue handoff, replica recovery, and prior Task 5
  causality paths retain their focused matrices.

## Tenth independent-review fix wave

Review of `56481fe` found three remaining lifecycle gaps: parent readiness
demand was registered only after a transport settled, a captured Journal read
could supersede an elected parent without waking a replacement election, and
an expired PageView resync failure could still replace a newer winner with a
stale error.

### Root cause

- PageView and EditableSidebarPanel did not create their full-payload waiter
  until their own parent fetch lost or failed. If an older transport hung and
  the newer pane unmounted, no waiter existed at the moment cancellation made
  the session electable, so the surviving pane remained loading indefinitely.
- Captured reads correctly activated a newer request id and expired the elected
  parent, restoring recovery eligibility. Their reservation release, however,
  did not schedule the parent-election state machine, leaving full-payload
  demand asleep after the block-only Journal response completed.
- PageView called `failAuthoritativeRead` for a resync failure but ignored its
  ownership result. A late expired resync therefore set component error state
  even after a newer parent request had published the winning payload.

### RED evidence

- `pnpm vitest run src/views/PageView.test.tsx -t "older transport still
  hangs|captured Journal response superseding recovery|superseded resync
  failure"` failed all three selected tests before production changes.
- The hung-parent case stopped at two fetches instead of electing a third after
  the newer pane unmounted. The real Journal capture stopped at three parent
  fetches instead of starting one post-capture full-payload replacement. The
  late resync rejection replaced one of two rendered winners with an error.
- The regressions hold and resolve stale transports explicitly, assert exact
  fetch counts, require the shared winner's block tree and reference metadata,
  reject stale elected content and errors, and verify session collection.

### Production design

- A parent generation now registers a releasable readiness demand immediately
  after obtaining its request token and attaches its promise handler before the
  network transport can settle. Publication from that request or any newer
  request satisfies the demand with the accepted full `PagePayload`.
- Supersession and unmount release the generation's readiness demand before
  cancelling its read. Release is idempotent and removes only that handle's
  waiter, preventing abandoned demand, duplicate waiters, and departing panes
  from participating in election.
- Parent election remains microtask-coalesced and now waits for every session
  reservation, including captured reads. Captured release schedules election
  after its exact-once decrement, so a Journal response cannot elect while it
  owns causality but reliably wakes one full parent after its block-only work
  finishes.
- PageView renders a non-parent failure only when `failAuthoritativeRead`
  confirms that token still owned the authoritative generation. Parent errors
  continue through the readiness contract, while expired resync failures are
  silent stale completions.

### GREEN verification

- Focused three-regression matrix: 1 file / 3 selected tests passed.
- Full parent and Journal integration matrix: 3 files / 34 tests passed, with
  `pnpm typecheck` passing in the same command.
- DnD/session/provider coverage passed: DndContext 8, useOutline DnD 10,
  outline sessions 25, and SyncProvider 34 tests.
- State/editor/provider/session coverage: 4 files / 105 tests passed.
- Reconciliation/DnD coverage: 3 files / 21 tests passed.
- Queue/replica coverage: 15 files / 192 tests passed.
- Exact Task 5 UI gate: 7 files / 93 tests passed.
- Canonical `pnpm verify`: passed: 72 files / 817 unit tests; 97.70%
  statements and lines, 91.27% branches, and 95.52% functions; production/PWA
  build with 78 precache entries / 5140.36 KiB; Playwright 6/6.

### Self-review

- Early demand is generation-scoped rather than transport-scoped: success,
  supersession, unmount, handle release, and terminal rejection each remove it
  once. The scheduler's existing coalescing, active-read guards, and one-attempt
  cap still bound recovery and prevent fetch storms.
- Captured receipt remains block-only and never resolves full-payload waiters.
  Its reservation suppresses premature election; only release wakes the
  scheduler, after the capture has either received or been abandoned.
- Same-request parent publication may satisfy its already-registered demand;
  older cached payloads cannot satisfy a newer token. Late expired transports
  remain rejected by request-id ownership and cannot reset the recovery cap.
- Full metadata sharing, repair epochs, deferred writes, DnD replay, shared
  editor leases, queue/replica recovery, Journal cleanup, and session deletion
  retain their targeted and canonical coverage.

## Eleventh independent-review fix wave

Review of `3137910` found that the scheduler treated a dormant captured read as
active authoritative ownership. A Journal transport that never settled could
therefore pin `reservations` and strand full-payload parent readiness after the
current parent failed.

### Root cause

- `captureActiveOutlineReads()` reserves a request id and increments the
  lifecycle reservation count before the Journal request dispatches, but it
  deliberately does not advance `latestRequestId` until the response actually
  contains that title.
- Parent election guarded on the aggregate `reservations > 0`. That count
  combines manual-parent reservations with dormant and activated captures, so
  it could not distinguish a harmless dispatch-time pin from the captured read
  that currently owns authoritative causality.
- Journal releases its captures in the fetch `finally`. If that transport hung,
  the dormant reservation never reached the release wakeup added in the tenth
  wave, even though a newer parent controller could safely supersede its token.

### RED evidence

- `pnpm vitest run src/views/PageView.test.tsx -t "dormant Journal capture
  cannot strand parent recovery"` failed before production changes at the
  recovery boundary: the parent fetch count remained 2 instead of electing the
  required third controller.
- The integration mounts overlapping PageView and Sidebar parent shells,
  starts and indefinitely holds a real Journal request, fails the current
  parent, and requires exactly one full-payload recovery with two rendered
  trees and two reference-metadata copies.
- It then resolves the Journal and older parent transports late, requires zero
  extra parent requests, rejects both stale payloads, and verifies no error or
  retained session.

### Production design

- Sessions now retain the request ids of captures that successfully activated.
  The election guard checks whether the session's current `latestRequestId` is
  in that set, rather than treating every reservation as active ownership.
- A dormant capture still pins session lifetime, blocks idle bootstrap, and
  retains its dispatch revision, but it does not stop a needed parent election.
  The elected parent receives a later request id, so the delayed capture cannot
  activate or overwrite the full-payload winner.
- An activated capture records its request id before expiring older manual
  reads and remains the current ownership guard until exact-once release. If a
  still newer controller supersedes it, request-id identity prevents the older
  activated capture from over-blocking unrelated recovery.
- Capture release removes only its own activated id, decrements the aggregate
  reservation exactly once, wakes the coalesced scheduler, and retains the
  existing deletion check. Active manual, automatic, and repair guards and the
  bounded parent-recovery cap are unchanged.

### GREEN verification

- Focused dormant/activated capture pair: 1 file / 2 selected tests passed,
  with `pnpm typecheck` passing in the same command.
- Full parent and Journal integration matrix: 3 files / 35 tests passed.
- DnD/session/provider matrix: 4 files / 77 tests passed.
- Epoch/replay matrix: 5 files / 93 tests passed.
- Queue/replica matrix: 15 files / 192 tests passed.
- Exact Task 5 UI gate: 7 files / 94 tests passed.
- Outline gate: 4 files / 54 tests passed.
- Canonical `pnpm verify`: passed: 72 files / 818 unit tests; 97.70%
  statements and lines, 91.35% branches, and 95.52% functions; production/PWA
  build with 78 precache entries / 5140.51 KiB; Playwright 6/6.

### Self-review

- Dormant and activated capture state remain separate from the total lifetime
  reservation count. Ignoring dormant captures for election cannot collect or
  rebootstrap their session because deletion/bootstrap still require zero
  aggregate reservations.
- The active-capture guard is request-id based, so only the capture that still
  owns `latestRequestId` can delay election. Superseded activated captures and
  dormant late responses cannot revive stale state or hold recovery forever.
- The held-Journal regression asserts the recovery happens before Journal
  settlement and that settlement causes neither an overwrite nor another
  fetch. The prior post-activation supersession regression proves release still
  wakes one replacement full parent after the block-only capture wins.
- Manual parents, automatic reads, repair epochs, readiness cleanup, the
  one-recovery cap, full-payload metadata sharing, DnD replay, queue/replica
  recovery, and session deletion retain their focused and canonical gates.

## Twelfth independent-review fix wave

Review of `fba1880` found three remaining shell-lifecycle gaps: Journal owned
captured reservations only on the stack of an unresolved request, ordinary
automatic reads remained an indefinite barrier to eager full-parent readiness,
and EditableSidebarPanel could render a prior title's payload during a prop
transition.

### Root cause

- Journal released a capture map only in the request's `finally`. Unmount did
  not invalidate its generation or retain a reference that cleanup could
  release. A hung transport therefore pinned captured sessions; a late response
  still passed the generation check and could call `sessionFor()` after all
  mounted session handles and loaders had already been cleaned up.
- An ordinary `requestAuthoritative()` advanced request identity and expired
  older manual parents, but the parent scheduler both lacked a wake at that
  transition and rejected election while `authoritativeRead` was non-null. A
  block-only transport that never settled could strand eager full-payload
  waiters even though a later parent request would safely supersede it.
- EditableSidebarPanel stored unkeyed payload and error state. On a title prop
  change, render reused the old payload before the new passive fetch settled;
  the nested EditablePage layout effect could consequently acquire the new
  title's editor with the old title's blocks.

### RED evidence

- Journal unmount coverage failed twice with retained sessions: releasing the
  last external handle while the Journal fetch was hung left the captured
  session active, and resolving a response after unmount created a previously
  inactive title session. The overlapping PageView/Sidebar integration reached
  its one parent recovery but then also found the late inactive-title leak.
- `pnpm vitest run src/views/PageView.test.tsx -t "hung automatic read cannot
  strand"` stopped at 2 parent fetches instead of electing the required third
  while the automatic transport remained unresolved.
- `pnpm vitest run src/components/EditableSidebarPanel.test.tsx -t "title
  change cannot mount"` still found `alpha tree` after the held Beta request
  had started, proving the stale child survived the title transition.

### Production design

- Journal now retains every in-flight capture map in a component-owned ref set.
  Normal settlement, reset, and unmount share one idempotent release function;
  reset/unmount increment generation before releasing, and unmount also marks
  the component inactive before session/loader cleanup.
- Every Journal response and failure checks both mounted state and generation
  immediately after the transport settles, before `sessionFor()`, captured
  receipt, automatic fallback, or React state writes. Late `finally` calls are
  harmless because their capture group was already removed and released.
- Ordinary automatic transport remains single-flight, but it is no longer a
  full-parent election barrier. Starting that ownership schedules election;
  the elected parent advances request identity and late automatic blocks are
  rejected by the existing newest-request rule. Manual parents, activated
  captures, and the global repair epoch remain stronger barriers, and the
  one-recovery cap still bounds controller attempts.
- Sidebar payload and error state carry the title that produced them. A title
  mismatch renders loading synchronously, so no EditablePage or editor lease is
  created until the new title's full payload wins; same-title shared readiness
  and metadata behavior are unchanged.

### GREEN verification

- Focused Journal unmount/capture coverage: 3 selected tests passed.
- Focused automatic/repair/capture supersession coverage: 5 selected tests
  passed with `pnpm typecheck` in the same command.
- Focused sidebar title-transition coverage: 1 selected test passed.
- Full parent/Journal/sidebar matrix: 3 files / 40 tests passed.
- DnD/session/provider matrix: 4 files / 77 tests passed.
- Epoch/replay matrix: 5 files / 93 tests passed.
- Queue/replica matrix: 15 files / 192 tests passed.
- Exact Task 5 UI gate: 7 files / 99 tests passed.
- Outline gate: 4 files / 54 tests passed.
- Canonical `pnpm verify`: passed: 72 files / 823 unit tests; 97.71%
  statements and lines, 91.40% branches, and 95.52% functions; production/PWA
  build with 78 precache entries / 5140.92 KiB; Playwright 6/6.

### Self-review

- Capture groups are released exactly once even when reset or unmount races
  transport `finally`. Aggregate reservation deletion and bootstrap guards are
  unchanged, while the post-await mounted/generation gate prevents all
  post-cleanup session acquisition and state publication.
- Ordinary automatic promises still coalesce duplicate requests and retain
  their lifecycle pin until settlement; they only cease blocking a strictly
  newer full parent. Active repair epochs still wait for existing automatic
  work and suppress parent election, preserving repair's stronger cohort
  barrier.
- The hung-automatic regression resolves the block-only transport after the
  full parent, asserts its blocks never render, and requires the exact parent
  count to remain 3. Existing automatic/repair supersession and terminal-cap
  tests continue to reject stale transports without retry storms.
- Title-keyed render state also suppresses stale errors across title changes.
  Cleanup still releases the old controller, readiness demand, loader, editor,
  and session before the new full payload mounts an EditablePage.
