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
