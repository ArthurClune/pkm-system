# Web Architecture and FCIS Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Complete all ten pkm-c1cg children and prove the integrated web architecture is concurrency-safe, semantically FCIS-compliant, and guarded by canonical verification.

**Architecture:** Establish explicit worker, RPC, persistence, and delivery lifecycles before fixing destructive recovery and poison repair. Add a shared per-title outline session with versioned reads, then extract pure editor/sync transitions from the corrected behavior. Finish with one shared grammar scanner, semantic FCIS enforcement, lint/build/PWA budgets, architecture documentation, and a requirement-by-requirement audit.

**Tech Stack:** React 18, TypeScript 5.9, Vitest 3, Testing Library, sqlite-wasm, Web Workers, Vite 6, Workbox/Vite PWA, Playwright, pnpm, ESLint flat config.

## Global Constraints

- Complete all ten child beans; do not defer normal-priority children.
- Use a fresh implementer subagent and a separate task-reviewer subagent for every task.
- Follow TDD: add focused failing tests and observe the intended failure before changing production code.
- Preserve the current 95% statements/lines, 91% branches, and 89% functions coverage thresholds.
- Runtime files declare an accurate FCIS pattern comment; tests, type-only/constants files, configs, scripts, generated data, and declarations are exempt only through reviewed policy.
- A Functional Core has no React, DOM, fetch, worker, timer, randomness, navigation, message-port, or SQLite effects and no runtime import of Shell or Mixed code.
- No successful worker enqueue response may be erased by recovery.
- Rejected batches never retry or reapply; later delivery pauses until authoritative repair succeeds or exposes a visible retry state.
- Offline persistence settlement and server delivery are different outcomes.
- One title has at most one editable and DnD-owning view; duplicate views share flushed optimistic state.
- Authoritative outline responses never overwrite revisions created after dispatch.
- Mermaid retains current never-online capability under explicit raw-byte caps.
- Canonical verification is cd web && pnpm verify.

---

### Task 1: Worker lifecycle and queue completion contracts (pkm-dcmm)

**Files:**
- Modify: web/src/replica/rpc.ts
- Modify: web/src/replica/client.ts
- Modify: web/src/replica/worker.ts
- Modify: web/src/replica/workerHandlers.ts
- Modify: web/src/sync/opQueue.ts
- Modify: web/src/sync/SyncProvider.tsx
- Modify: web/src/test-helpers.ts
- Test: web/src/replica/rpc.test.ts
- Test: web/src/replica/client.test.ts
- Test: web/src/sync/opQueue.replica.test.ts
- Test: web/src/sync/opQueue.test.ts
- Test: web/src/sync/SyncProvider.test.tsx
- Test: web/src/sync/connectionAware.test.tsx
- Modify: .beans/pkm-dcmm--own-replica-worker-lifecycle-and-clarify-queue-idl.md

**Interfaces:**
- Produces:

      interface WriteTicket {
        id: string;
        scope: readonly string[];
        settled: Promise<WriteOutcome>;
      }

      type DrainOutcome =
        | { status: "drained" }
        | { status: "blocked"; reason: "offline" | "retryable" |
            "recovering" | "disposed"; pending: number; error?: unknown };

      interface OpQueue {
        enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
        settled(): Promise<void>;
        drain(): Promise<DrainOutcome>;
        setOnline(online: boolean): void;
        pause(reason: "recovery"): void;
        resume(reason: "recovery"): void;
        dispose(): void;
      }

      interface RpcClient {
        call<T>(method: string, payload?: unknown,
                options?: { timeoutMs?: number }): Promise<T>;
        dispose(reason?: Error): void;
      }

      interface Replica {
        dispose(): Promise<void>;
      }

- Consumers: Tasks 2, 3, 5, and 7.
- Ownership: SyncProvider disposes only replicas created by its internal worker factory; injected replicas remain caller-owned.
- Retry schedule: 250 ms, 1 s, then 5 s capped; reconnect or success resets it; offline/dispose cancels it.
- RPC timeouts: 30 seconds for ordinary calls and 120 seconds for reset/snapshot calls.

- [ ] **Step 1: Add failing RPC terminal-lifecycle tests**

  Add tests that start two pending calls and separately trigger worker error,
  messageerror, timeout, and dispose. Assert both promises reject with the typed
  cause, late replies are ignored, and post-dispose calls reject.

  Run: cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/client.test.ts

  Expected: FAIL because PortLike exposes no terminal events, RpcClient has no
  dispose/timeout contract, and Replica has no lifecycle.

- [ ] **Step 2: Add failing queue settlement/drain tests**

  Add replica and legacy cases proving:

      offline enqueue -> ticket.settled resolves persisted
      offline drain -> {status: "blocked", reason: "offline", pending: 1}
      transient 503 -> blocked retryable, then fake-timer retry -> drained
      dispose -> retry timer cancelled and drain blocked disposed
      drained -> fresh replica.pendingCount() equals 0

  Run: cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts

  Expected: FAIL because enqueue returns void and idle resolves after a blocked
  attempt without a typed outcome.

- [ ] **Step 3: Implement RPC, owned replica, and queue contracts**

  Keep wire encoding and terminal event handling in Imperative Shell code.
  Reject and remove every pending map entry on terminal failure. Make worker
  creation return the Worker handle with the Replica facade, add a close handler
  that closes the database resource before termination, and make cleanup
  idempotent. Implement WriteTicket, settled, drain, pause/resume, cancellable
  retry, and dispose without coupling persistence to HTTP delivery.

- [ ] **Step 4: Migrate provider and outline-facing call sites**

  Reconnect flow calls drain and proceeds to feed pull/resync only for drained.
  useOutline-facing Sync exposes ticket settlement, not global delivery drain.
  Provider unmount closes socket/gateway/queue and its owned replica exactly
  once. Calls completing after unmount do not mutate React state.

- [ ] **Step 5: Verify focused lifecycle behavior**

  Run: cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/client.test.ts src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx src/sync/connectionAware.test.tsx

  Expected: PASS with fake timers drained and no unhandled rejections.

- [ ] **Step 6: Complete and commit the bean**

  Check every pkm-dcmm acceptance item, append a Summary of Changes with exact
  lifecycle and queue semantics, set status completed only when no checkbox
  remains, and commit source, tests, and bean together.

  Commit: git commit -m "fix(web): own replica lifecycle and queue outcomes"

---

### Task 2: Atomic replica recovery gate (pkm-qvqz)

**Files:**
- Create: web/src/replica/recoveryGate.ts
- Create: web/src/replica/recoveryGate.test.ts
- Modify: web/src/replica/client.ts
- Modify: web/src/replica/workerHandlers.ts
- Modify: web/src/sync/replicaSync.ts
- Modify: web/src/sync/SyncProvider.tsx
- Test: web/src/replica/client.test.ts
- Create: web/src/replica/workerHandlers.test.ts
- Test: web/src/sync/replicaSync.test.ts
- Modify: .beans/pkm-qvqz--make-replica-recovery-atomic-with-concurrent-enque.md

**Interfaces:**
- Consumes: Task 1 queue pause/resume/drain and disposable RPC.
- Produces:

      interface RecoveryLease {
        token: string;
        batches: readonly PendingBatch[];
      }

      type RecoveryCommit =
        | { kind: "reset"; snapshot: Snapshot }
        | { kind: "rebase"; snapshot: Snapshot };

      interface Replica {
        prepareRecovery(): Promise<RecoveryLease>;
        commitRecovery(token: string, input: RecoveryCommit): Promise<void>;
        abortRecovery(token: string): Promise<void>;
      }

- Invariant: after prepareRecovery resolves, later database mutations wait until
  commit or abort; final durable rows must equal the prepared lease.

- [ ] **Step 1: Write the deterministic enqueue-versus-reset regression**

  Use deferred barriers, not timers. Enter recovery, pause before commit, issue
  both Replica.enqueue and localApi POST /api/pages, and assert neither
  acknowledges nor touches the old database. Release commit and assert both
  operations persist in the fresh database.

  Run: cd web && pnpm vitest run src/replica/client.test.ts src/replica/workerHandlers.test.ts

  Expected: FAIL because serveRpc handlers currently mutate independently.

- [ ] **Step 2: Write recovery trace and final-recheck tests**

  Assert this exact trace for schema mismatch and feed rebootstrap:

      pause queue
      prepare lease
      flush non-poisoned batches oldest-first
      fetch snapshot
      compare final durable rows
      reset-or-rebase plus snapshot
      release lease
      resume queue

  Inject a changed row set at commit and assert destructive work is refused,
  the lease releases, and recovery-failed is reported. Preserve the existing
  failed-flush and schema/generation cases.

  Run: cd web && pnpm vitest run src/sync/replicaSync.test.ts

  Expected: FAIL because recovery uses pendingCount/list/reset without a lease.

- [ ] **Step 3: Implement the worker-owned FIFO recovery gate**

  recoveryGate.ts is an Imperative Shell synchronization primitive. Ordinary
  mutating handlers run through the gate. prepareRecovery waits for earlier
  work and returns one active token plus a stable pending-row fingerprint.
  Only token-bearing commit/abort may run while held. Invalid/double tokens
  reject. commit performs final comparison inside the gate immediately before
  reset/rebase. All paths release exactly once.

- [ ] **Step 4: Replace both recovery paths with one coordinator**

  replicaSync uses one helper for schema mismatch and feed needs-bootstrap.
  Queue delivery pauses before the lease. Failed flush/snapshot/commit calls
  abort in finally, retain the database, surface recovery-failed, and resume the
  queue in blocked/retryable state. Successful release kicks later enqueues.

- [ ] **Step 5: Verify focused and compatibility suites**

  Run: cd web && pnpm vitest run src/replica/recoveryGate.test.ts src/replica/client.test.ts src/replica/workerHandlers.test.ts src/sync/replicaSync.test.ts src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx

  Expected: PASS; every acknowledged enqueue is flushed or remains pending.

- [ ] **Step 6: Complete and commit the bean**

  Check every pkm-qvqz criterion, record the acknowledgment boundary and trace
  in Summary of Changes, mark completed, and commit.

  Commit: git commit -m "fix(web): make replica recovery atomic"

---

### Task 3: Authoritative repair after rejected batches (pkm-huv4)

**Files:**
- Modify: web/src/sync/opQueue.ts
- Modify: web/src/sync/replicaSync.ts
- Modify: web/src/sync/SyncProvider.tsx
- Modify: web/src/components/OfflineIndicator.tsx
- Modify: web/src/replica/client.ts
- Modify: web/src/replica/queue.ts
- Modify: web/src/replica/apply.ts
- Test: web/src/sync/opQueue.replica.test.ts
- Test: web/src/sync/SyncProvider.test.tsx
- Test: web/src/components/OfflineIndicator.test.tsx
- Test: web/src/replica/apply.test.ts
- Test: web/src/replica/queue.test.ts
- Modify: .beans/pkm-huv4--reconcile-optimistic-state-after-server-rejected-b.md

**Interfaces:**
- Consumes: Task 1 queue outcomes and Task 2 recovery lease/coordinator.
- Produces:

      interface PoisonEvent {
        rowId: number;
        batchId: string;
        ops: readonly BlockOp[];
        status: number;
        message: string;
      }

      type SyncProblem =
        | { kind: "rejected-batch"; event: PoisonEvent;
            repair: "running" | "failed" | "repaired"; error?: string };

      interface ReplicaSync {
        rebaseAuthoritative(reason: "poison"): Promise<void>;
      }

- Ordering: POST 4xx -> mark poison -> pause later delivery -> snapshot rebase
  -> bump resync -> resume delivery.

- [ ] **Step 1: Add failing structured-poison and ordering tests**

  Make the first persisted batch return 400 and hold the snapshot promise.
  Assert one PoisonEvent contains row/batch/ops/status/message, later batches do
  not POST while repair is held, and resyncSeq does not change before rebase.

  Run: cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx

  Expected: FAIL because the queue emits a raw ApiError and immediately keeps
  posting.

- [ ] **Step 2: Add failing replica rollback/non-reapply tests**

  Enqueue a rejected text op and a structural op, mark them poisoned, retain a
  separate valid pending batch, apply an authoritative snapshot, and assert the
  rejected effects disappear while the valid effect reapplies. Apply another
  feed and snapshot and assert rejected effects stay absent.

  Run: cd web && pnpm vitest run src/replica/apply.test.ts src/replica/queue.test.ts

  Expected: FAIL at the provider/repair boundary and expose any missing poison
  metadata or cleanup API.

- [ ] **Step 3: Implement poison repair through the shared coordinator**

  Preserve batch details before marking. Queue pause is established before
  emitting. SyncProvider subscribes, enters rejected-batch/running state, calls
  full-snapshot rebase under Task 2 lease, bumps resync only after success,
  retains event details in provider state, deletes the repaired poisoned row,
  and resumes later delivery. Startup detects previously poisoned rows and
  repairs them.

- [ ] **Step 4: Add visible recoverable error UI**

  OfflineIndicator renders connected delivery failure separately from offline
  status. A failed repair keeps details and a Retry control; retry reruns the
  guarded snapshot. Dismiss hides details only after successful repair and
  cannot reapply or retry the rejected operation.

- [ ] **Step 5: Verify focused poison and provider integration**

  Run: cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx src/components/OfflineIndicator.test.tsx src/replica/apply.test.ts src/replica/queue.test.ts

  Expected: PASS with no later POST before repair and no rejected effect after
  repeated snapshot/feed application.

- [ ] **Step 6: Complete and commit the bean**

  Check all pkm-huv4 criteria, document user recovery and durable poison policy,
  mark completed, and commit.

  Commit: git commit -m "fix(web): repair state after rejected batches"

---

### Task 4: Atomic same-title editor ownership (pkm-viah)

**Files:**
- Create: web/src/outline/outlineSessions.ts
- Create: web/src/outline/outlineSessions.test.ts
- Modify: web/src/outline/useOutline.ts
- Modify: web/src/views/EditablePage.tsx
- Modify: web/src/outline/activeOutlines.ts
- Modify: web/src/dnd/DndContext.tsx
- Test: web/src/views/EditablePage.test.tsx
- Test: web/src/outline/activeOutlines.test.ts
- Test: web/src/dnd/DndContext.test.tsx
- Test: web/src/components/EditableBlockTree.dnd.test.tsx
- Test: web/src/components/EditableSidebarPanel.test.tsx
- Modify: .beans/pkm-viah--eliminate-simultaneous-same-title-editor-divergenc.md

**Interfaces:**
- Produces:

      interface OutlineSessionHandle {
        getSnapshot(): SharedOutlineSnapshot;
        subscribe(listener: () => void): () => void;
        claimEditor(owner: symbol): EditorLease;
        applyOptimistic(blocks: BlockNode[]): void;
        release(): void;
      }

      interface EditorLease {
        granted: boolean;
        subscribe(listener: () => void): () => void;
        release(): void;
      }

      type DndRegistration =
        | { accepted: true; unregister(): void }
        | { accepted: false; reason: "duplicate-title" };

- Ownership boundary: duplicate views initially render read-only/pending; one
  layout-effect lease becomes editable; focus/draft/selection stay per view.
- Shared boundary: every flushed optimistic tree and remote/authoritative tree
  is visible to all handles of the title.

- [ ] **Step 1: Replace the current double-ownership test with a failing intended-behavior test**

  Render two same-title EditablePage instances in one commit. Assert never more
  than one textarea/drop zone, exactly one owner after layout effects, and the
  fallback cannot focus or drag. Repeat under StrictMode.

  Run: cd web && pnpm vitest run src/views/EditablePage.test.tsx

  Expected: FAIL because both render-time checks see no active owner.

- [ ] **Step 2: Add failing session sharing and DnD duplicate tests**

  Edit and flush the owner, then assert the fallback renders the new text.
  Register DnD owner A then B for the same title; assert B is rejected, drops
  still call A, and either unmount order leaves no stale registration.

  Run: cd web && pnpm vitest run src/outline/outlineSessions.test.ts src/dnd/DndContext.test.tsx src/components/EditableBlockTree.dnd.test.tsx

  Expected: FAIL because outlines are per mount and DnD is last-wins.

- [ ] **Step 3: Implement the ref-counted external session store and editor lease**

  Use subscription-backed state with idempotent release. Do not mutate the
  registry during render. Both views render safe read-only output until one
  layout effect atomically claims. When an owner releases, one remaining
  subscriber may claim; abandoned/concurrent renders never leak sessions.

- [ ] **Step 4: Integrate shared trees and duplicate-safe DnD**

  useOutline publishes each flushed optimistic/remote/authoritative tree to its
  title session and subscribes to shared changes. EditablePage uses lease state
  for editable rendering and registers DnD only after lease grant. DndContext
  uses registration tokens and rejects duplicates.

- [ ] **Step 5: Verify simultaneous and sequential behavior**

  Run: cd web && pnpm vitest run src/outline/outlineSessions.test.ts src/outline/activeOutlines.test.ts src/views/EditablePage.test.tsx src/dnd/DndContext.test.tsx src/components/EditableBlockTree.dnd.test.tsx src/components/EditableSidebarPanel.test.tsx

  Expected: PASS for main-first/sidebar-first, simultaneous, handoff, and both
  unmount orders.

- [ ] **Step 6: Complete and commit the bean**

  Check every pkm-viah criterion, summarize lease and shared-tree semantics,
  mark completed, and commit.

  Commit: git commit -m "fix(web): make same-title editor ownership atomic"

---

### Task 5: Versioned outline reconciliation (pkm-z77x)

**Files:**
- Create: web/src/outline/outlineState.ts
- Create: web/src/outline/outlineState.test.ts
- Create: web/src/outline/useOutline.reconciliation.test.tsx
- Modify: web/src/outline/outlineSessions.ts
- Modify: web/src/outline/useOutline.ts
- Modify: web/src/views/PageView.tsx
- Modify: web/src/components/EditableSidebarPanel.tsx
- Modify: web/src/views/Journal.tsx
- Modify: web/src/test-helpers.ts
- Test: web/src/outline/useOutline.dnd.test.tsx
- Test: web/src/views/EditablePage.test.tsx
- Test: web/src/views/PageView.test.tsx
- Modify: .beans/pkm-z77x--prevent-outline-refetches-from-overwriting-or-disc.md

**Interfaces:**
- Consumes: Task 1 WriteTicket and Task 4 per-title session.
- Produces:

      interface ReadToken {
        requestId: number;
        revisionAtDispatch: number;
      }

      type OutlineEvent =
        | { type: "local-ops"; ticketId: string; ops: readonly BlockOp[] }
        | { type: "remote-ops"; ops: readonly BlockOp[] }
        | { type: "authoritative"; token: ReadToken; blocks: BlockNode[] }
        | { type: "write-settled"; ticketId: string };

      interface OutlineSessionHandle {
        beginAuthoritativeRead(source: "parent" | "resync" |
          "cross-page-move"): ReadToken;
        receiveAuthoritative(token: ReadToken, blocks: BlockNode[]): void;
      }

- Adoption rule: newest request, unchanged local revision, and no unsettled
  ticket whose scope contains this title.

- [ ] **Step 1: Add failing pure causality tests**

  Cover unchanged adoption, local edit after dispatch, newest-deferred wins,
  relevant-ticket settlement, unrelated-title ticket, stale token, focus
  invalidation, and the effect that requests one fresh read instead of blindly
  adopting a pre-edit candidate.

  Run: cd web && pnpm vitest run src/outline/outlineState.test.ts

  Expected: FAIL because outlineState does not exist.

- [ ] **Step 2: Add failing hook/parent concurrency regressions**

  Dispatch cross-page/parent refetch, make a local split before resolving it,
  and assert the old response cannot remove the block/focus. Hold a Page B
  ticket while Page A receives a safe payload and assert A adopts. Filter the
  local own echo, settle the ticket, resolve the automatic fresh read, and
  assert the outline becomes authoritative without another socket event.

  Run: cd web && pnpm vitest run src/outline/useOutline.reconciliation.test.tsx src/outline/useOutline.dnd.test.tsx src/views/PageView.test.tsx

  Expected: FAIL because naked initial identities/global pending/idle still
  control adoption.

- [ ] **Step 3: Implement the Functional Core reconciliation transition**

  Increment revision on every state-changing local/remote transition. Keep at
  most the newest deferred payload. Relevant settlement either adopts a still
  safe candidate or emits one request-authoritative effect. Validate focus
  against adopted blocks. The module imports no React, fetch, timer, or queue
  shell.

- [ ] **Step 4: Pair every authoritative fetch with a session read token**

  PageView, EditableSidebarPanel, Journal resync, and cross-page move begin a
  read before apiFetch and pass the token with success. Request sequencing still
  drops obsolete transport responses. useOutline scopes tickets to all page
  titles touched by each operation, including source and target for moves.

- [ ] **Step 5: Verify focused reconciliation and existing editing behavior**

  Run: cd web && pnpm vitest run src/outline/outlineState.test.ts src/outline/useOutline.reconciliation.test.tsx src/outline/useOutline.dnd.test.tsx src/views/EditablePage.test.tsx src/views/PageView.test.tsx src/components/EditableSidebarPanel.test.tsx src/views/Journal.test.tsx

  Expected: PASS without global-pending gating or silently dropped payloads.

- [ ] **Step 6: Complete and commit the bean**

  Check all pkm-z77x criteria, summarize client causality and ticket scoping,
  mark completed, and commit.

  Commit: git commit -m "fix(web): version authoritative outline reads"

---

### Task 6: Async UI lifecycle consistency (pkm-stn6)

**Files:**
- Modify: web/src/components/QueryBlock.tsx
- Modify: web/src/components/BlockTree.tsx
- Modify: web/src/components/BlueskyEmbed.tsx
- Modify: web/src/components/SidebarNav.tsx
- Test: web/src/components/QueryBlock.test.tsx
- Test: web/src/components/BlockTree.test.tsx
- Test: web/src/components/BlueskyEmbed.test.tsx
- Test: web/src/components/SidebarNav.test.tsx
- Modify: .beans/pkm-stn6--standardize-async-ui-request-and-mutation-lifecycl.md

**Interfaces:**
- Query identity: expression generation plus monotonically increasing request id.
- Collapse state: previous authoritative value plus current view value.
- Bluesky identity: actor-keyed DID result plus href/post-keyed height.
- Sidebar mutation: one lane covering mutation and authoritative refresh with
  state idle | running | failed.
- No broad useAsync helper is introduced; the four lifecycles have different
  semantics.

- [ ] **Step 1: Add failing QueryBlock out-of-order tests**

  Resolve expr B before obsolete expr A; resolve obsolete A pagination after a
  rerender to B; resolve stale finally while B remains pending; double-click
  pagination. Assert only current generation state changes and only one page
  request is active.

  Run: cd web && pnpm vitest run src/components/QueryBlock.test.tsx

  Expected: FAIL because every response/finally mutates current state.

- [ ] **Step 2: Add failing collapse, Bluesky, and sidebar lifecycle tests**

  Cover unchanged authoritative collapse preserving a local toggle, real prop
  transition winning, actor A/B resolution inversion, DID href replacement,
  post-height reset, invalid/valid href transition, held sidebar PUT plus
  refresh, disabled conflicting controls, all mutation/refresh failures, and
  successful retry.

  Run: cd web && pnpm vitest run src/components/BlockTree.test.tsx src/components/BlueskyEmbed.test.tsx src/components/SidebarNav.test.tsx

  Expected: FAIL on stale prop/actor/height and overlapping uncaught mutations.

- [ ] **Step 3: Implement component-specific generations and serialization**

  QueryBlock aborts and invalidates old generations but retains token checks for
  offline-gateway completions. BlockTree adopts only actual authoritative prop
  transitions. Bluesky state is accepted only for the current actor and height
  clears on post identity change. Sidebar disables conflicts until mutation plus
  refresh settles, catches every rejection, and computes reorder from current
  entries when the lane begins.

- [ ] **Step 4: Verify all four rerender/concurrency matrices**

  Run: cd web && pnpm vitest run src/components/QueryBlock.test.tsx src/components/BlockTree.test.tsx src/components/BlueskyEmbed.test.tsx src/components/SidebarNav.test.tsx

  Expected: PASS with no stale state mutation or unhandled promise rejection.

- [ ] **Step 5: Complete and commit the bean**

  Check all pkm-stn6 criteria, document why mechanisms remain local rather than
  a generic helper, mark completed, and commit.

  Commit: git commit -m "fix(web): standardize async UI lifecycles"

---

### Task 7: Extract pure editor and sync state machines (pkm-wudz)

**Files:**
- Create: web/src/outline/keyboardPolicy.ts
- Create: web/src/outline/keyboardPolicy.test.ts
- Extend: web/src/outline/outlineState.ts
- Extend: web/src/outline/outlineState.test.ts
- Create: web/src/sync/queueState.ts
- Create: web/src/sync/queueState.test.ts
- Create: web/src/sync/syncState.ts
- Create: web/src/sync/syncState.test.ts
- Modify: web/src/components/EditableBlockTree.tsx
- Modify: web/src/outline/useOutline.ts
- Modify: web/src/sync/opQueue.ts
- Modify: web/src/sync/SyncProvider.tsx
- Modify: web/src/sync/replicaSync.ts
- Test: web/src/components/EditableBlockTree.test.tsx
- Test: web/src/sync/opQueue.replica.test.ts
- Test: web/src/sync/opQueue.test.ts
- Test: web/src/sync/SyncProvider.test.tsx
- Test: web/src/sync/replicaSync.test.ts
- Modify: .beans/pkm-wudz--extract-pure-editor-and-sync-state-machines-from-l.md

**Interfaces:**
- Produces pure exhaustive functions:

      function transitionOutline(state: OutlineState,
                                 event: OutlineEvent): OutlineTransition;
      function spliceUploadedMarkdown(text: string, requestedOffset: number,
                                      markdown: string): TextSelection;
      function decideEditorKey(input: EditorKeyInput): KeyDecision;
      function transitionQueue(state: QueueState,
                               event: QueueEvent): QueueTransition;
      function transitionSync(state: SyncState,
                              event: SyncEvent): SyncTransition;

- Effects are data. Shells alone perform preventDefault, DOM focus, timers,
  upload/fetch, RPC, SQLite, socket, worker, random UID, and React updates.

- [ ] **Step 1: Add failing pure outline/upload/keyboard tests**

  Table-test pending draft before structural op, no-op draft, upload clamp after
  intervening typing, missing upload target, unknown remote move requesting an
  authoritative read, focus invalidation, autocomplete precedence, Escape,
  Ctrl-O, Shift+Arrow, read-only cutoff, heading chord, Cmd-K, brackets, split,
  indent/move/backspace, boundary arrows, and browser default.

  Run: cd web && pnpm vitest run src/outline/outlineState.test.ts src/outline/keyboardPolicy.test.ts

  Expected: FAIL for missing pure transitions/policy branches.

- [ ] **Step 2: Add failing pure queue/sync transition tables**

  Cover enqueue -> persist -> deliver -> acknowledge, offline blocked, 5xx
  retry, 4xx poison, recovery pause/release, worker failure, disposal,
  reconnect, replica unavailable, repair failure/success, and resync bump only
  after authoritative state is ready. Assert exact effect arrays and exhaustive
  event handling without React/fetch/worker/SQLite mocks.

  Run: cd web && pnpm vitest run src/sync/queueState.test.ts src/sync/syncState.test.ts

  Expected: FAIL because deterministic policy remains embedded in shells.

- [ ] **Step 3: Implement minimal Functional Core reducers and policies**

  Reuse corrected Task 1-6 semantics verbatim. Avoid generalized frameworks:
  each state/event/effect union contains only behavior exercised by its shell.
  Every switch is exhaustive through a never assertion.

- [ ] **Step 4: Make shells execute core effects**

  EditableBlockTree reads DOM state, calls decideEditorKey, then executes the
  returned semantic action. useOutline executes outline effects. opQueue and
  SyncProvider/replicaSync execute their reducer effects and feed completion
  events back. Keep one integration test per effect family and retain IME,
  clipboard, focus restoration, worker/RPC, and network tests in shells.

- [ ] **Step 5: Verify pure and shell suites plus coverage**

  Run: cd web && pnpm vitest run src/outline/outlineState.test.ts src/outline/keyboardPolicy.test.ts src/components/EditableBlockTree.test.tsx src/sync/queueState.test.ts src/sync/syncState.test.ts src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx src/sync/replicaSync.test.ts

  Run: cd web && pnpm test:coverage

  Expected: PASS above all existing coverage thresholds.

- [ ] **Step 6: Complete and commit the bean**

  Check all pkm-wudz criteria, list each new core/shell boundary in Summary of
  Changes, mark completed, and commit.

  Commit: git commit -m "refactor(web): extract editor and sync state cores"

---

### Task 8: Shared reference and TODO grammar scanner (pkm-1cq3)

**Files:**
- Create: web/src/grammar/scan.ts
- Create: web/src/grammar/scan.test.ts
- Modify: web/src/grammar/tokenize.ts
- Modify: web/src/grammar/refs.ts
- Modify: web/src/grammar/todo.ts
- Modify: web/src/outline/refAtCaret.ts
- Modify: web/src/outline/slashCommands.ts
- Modify: web/src/replica/refs.ts
- Test: web/src/grammar/tokenize.test.ts
- Test: web/src/grammar/refs.test.ts
- Test: web/src/grammar/todo.test.ts
- Test: web/src/outline/refAtCaret.test.ts
- Test: web/src/outline/slashCommands.test.ts
- Test: web/src/replica/refs.test.ts
- Modify: shared/fixtures/ref_grammar.json
- Modify: shared/fixtures/refs_parity.json
- Modify: .beans/pkm-1cq3--consolidate-reference-and-todo-grammar-scanning.md

**Interfaces:**
- Produces:

      interface Span { start: number; end: number }

      type GrammarToken =
        | ({ kind: "page-ref"; content: Span; title: string; tag: boolean;
             depth: number; parentStart: number | null } & Span)
        | ({ kind: "block-ref"; uid: string } & Span)
        | ({ kind: "hashtag"; title: string } & Span)
        | ({ kind: "attribute"; title: string } & Span)
        | ({ kind: "embed" } & Span)
        | ({ kind: "todo"; state: "TODO" | "DONE";
             openBrackets: boolean; closeBrackets: boolean;
             suffixEnd: number } & Span)
        | ({ kind: "inline-code" | "code-fence" } & Span);

      function scanGrammar(text: string):
        { tokens: readonly GrammarToken[] };

- Spans are UTF-16, half-open, source ordered, outer reference before children.
- Opaque code wins; malformed/unclosed syntax remains plain text.
- Consumer adapters preserve existing public shapes and empty-ref/caret behavior.

- [ ] **Step 1: Add failing scanner contract tests**

  Assert exact spans for plain/adjacent/Unicode/empty/tag refs, nested
  outer-before-inner parent/depth, block refs, TODO spelling/suffix offsets,
  opaque code, malformed brackets/ticks/fences, and 10,000 nested references
  without RangeError.

  Run: cd web && pnpm vitest run src/grammar/scan.test.ts

  Expected: FAIL because scanGrammar does not exist.

- [ ] **Step 2: Add failing shared round-trip/parity tests**

  Assert token source slices are exact, TODO toggled twice is byte-identical for
  every accepted spelling and quote prefix, slash /todo output is recognized by
  tokenizer/toggler, caret chooses the innermost non-empty containing ref, and
  both fixture extractors agree on Unicode/nested/malformed cases.

  Run: cd web && pnpm vitest run src/grammar/tokenize.test.ts src/grammar/refs.test.ts src/grammar/todo.test.ts src/outline/refAtCaret.test.ts src/outline/slashCommands.test.ts src/replica/refs.test.ts

  Expected: at least the new cross-consumer contracts FAIL due to duplicated
  scanners and Unicode differences.

- [ ] **Step 3: Implement the iterative Functional Core scanner**

  Use an explicit stack, never recursive rescanning. Record opaque code ranges
  before reference/TODO recognition. Validate every returned offset lies within
  the input. Keep unrelated markdown/query/emphasis parsing in tokenizer.

- [ ] **Step 4: Replace every duplicate scanner with adapters**

  tokenize uses outer tokens for rendering; grammar/refs and replica/refs map
  scanner output to their existing casing/count shapes; refAtCaret selects the
  narrowest containing page-ref; todo preserves bracket spelling and exact "> "
  prefix; slashCommands consults the shared TODO adapter. Delete superseded
  private recursive scans.

- [ ] **Step 5: Verify grammar compatibility and coverage**

  Run: cd web && pnpm vitest run src/grammar/scan.test.ts src/grammar/tokenize.test.ts src/grammar/refs.test.ts src/grammar/todo.test.ts src/outline/refAtCaret.test.ts src/outline/slashCommands.test.ts src/replica/refs.test.ts src/replica/localOps.test.ts src/components/InlineSegments.test.tsx

  Expected: PASS with existing fixtures and public behavior intact.

- [ ] **Step 6: Complete and commit the bean**

  Check every pkm-1cq3 criterion, document canonical Unicode/span rules and
  intentional adapter differences, mark completed, and commit.

  Commit: git commit -m "refactor(web): consolidate reference grammar scanning"

---

### Task 9: Correct and enforce TypeScript FCIS boundaries (pkm-1jw6)

**Files:**
- Create: web/src/uidCore.ts
- Create: web/src/uidCore.test.ts
- Create: web/tooling/fcis-core.mjs
- Create: web/tooling/fcis.mjs
- Create: web/tooling/fcis-core.test.ts
- Create: web/tooling/fcis-exemptions.json
- Modify: web/src/uid.ts
- Modify: web/src/replica/rpc.ts
- Modify: web/src/contexts.ts
- Modify: web/src/components/BlockRef.tsx
- Modify: web/src/components/AssetImage.tsx
- Modify: web/src/components/PageLink.tsx
- Modify: web/src/components/TodoCheckbox.tsx
- Modify: web/src/components/InlineSegments.tsx
- Modify: web/src/components/ErrorBoundary.tsx
- Modify: comparable runtime web/src modules reported by the checker
- Modify: web/package.json
- Test: web/src/uid.test.ts
- Test: web/src/replica/rpc.test.ts
- Test: existing component behavior suites for every relabelled/split module
- Modify: .beans/pkm-1jw6--correct-and-enforce-typescript-fcis-boundaries.md

**Interfaces:**
- Header forms:

      // pattern: Functional Core
      // pattern: Imperative Shell
      // pattern: Mixed (needs refactoring)
      // pattern: Mixed (unavoidable) -- non-empty reason

- check:fcis scans runtime src .ts/.tsx through the TypeScript compiler API.
- Runtime core -> shell/mixed import, export, or dynamic import fails.
- Type-only import/export edges pass.
- Exemptions are exact path plus non-empty reason, not glob guesses.

- [ ] **Step 1: Add failing FCIS policy tests**

  Cover missing/late/duplicate/unknown header, every valid class, unavoidable
  without/with reason, exact exemptions, .ts/.tsx/index resolution, core->core,
  shell->core, forbidden core->shell/core->mixed, runtime re-export, dynamic
  import, and permitted type-only edge.

  Run: cd web && pnpm vitest run tooling/fcis-core.test.ts

  Expected: FAIL because the checker does not exist.

- [ ] **Step 2: Add the failing real-tree integration check**

  Run the checker against web/src and assert named files plus ErrorBoundary have
  semantic classifications and zero forbidden runtime edges.

  Run: cd web && pnpm check:fcis

  Expected: FAIL on missing script and current misclassifications/imports.

- [ ] **Step 3: Implement deterministic UID core and correct classifications**

  Move byte-to-alphabet mapping to uidCore Functional Core and keep
  crypto.getRandomValues in uid Imperative Shell. Relabel RPC, React contexts,
  state/effect/navigation components, InlineSegments composition, and
  ErrorBoundary as shells. Extract a pure decision only when it is reused or
  independently meaningful. Audit every checker finding rather than adding an
  exemption for runtime behavior.

- [ ] **Step 4: Implement the compiler-API checker**

  Resolve relative imports with TypeScript module resolution, classify each
  runtime module once, ignore type-only emitted edges, sort diagnostics by
  source/location/target, and exit nonzero on any policy violation. Require
  first-five-line headers and canonical unavoidable reasons. Add check:fcis to
  verify before unit coverage.

- [ ] **Step 5: Verify checker and unchanged behavior**

  Run: cd web && pnpm vitest run tooling/fcis-core.test.ts src/uidCore.test.ts src/uid.test.ts src/replica/rpc.test.ts src/components/AssetImage.test.tsx src/components/BlockRef.test.tsx src/components/InlineSegments.test.tsx src/components/ErrorBoundary.test.tsx

  Run: cd web && pnpm check:fcis && pnpm typecheck

  Expected: PASS with zero runtime core-to-shell/mixed edges.

- [ ] **Step 6: Complete and commit the bean**

  Check all pkm-1jw6 criteria, include the exemption table and final boundary
  audit in Summary of Changes, mark completed, and commit.

  Commit: git commit -m "chore(web): enforce semantic FCIS boundaries"

---

### Task 10: Lint, bundle, and PWA precache guardrails (pkm-f1rn)

**Files:**
- Create: web/eslint.config.js
- Create: web/tooling/lintConfig.test.ts
- Create: web/tooling/eslint-fixtures/missing-hook-dependency.tsx
- Create: web/tooling/eslint-fixtures/floating-promise.ts
- Create: web/tooling/eslint-fixtures/misused-promise.tsx
- Create: web/tooling/eslint-fixtures/string-throw.ts
- Create: web/tooling/eslint-fixtures/unsafe-catch.ts
- Create: web/tooling/buildBudgets.ts
- Create: web/tooling/buildBudgets.test.ts
- Create: web/tooling/budgets.json
- Create: web/tooling/viteBudgetPlugin.ts
- Modify: web/package.json
- Modify: web/pnpm-lock.yaml
- Modify: web/vite.config.ts
- Modify: every web/src file containing react-hooks/exhaustive-deps suppression
- Test: web/src/sync/SyncProvider.test.tsx
- Test: web/src/components/SearchBar.test.tsx
- Test: web/src/components/QueryBlock.test.tsx
- Test: web/src/components/EditableBlockTree.test.tsx
- Test: web/src/outline/useOutline.reconciliation.test.tsx
- Test: web/src/components/MermaidDiagram.test.tsx
- Test: web/e2e/offline-shell.spec.ts
- Modify: .beans/pkm-f1rn--add-web-lint-fcis-checks-and-bundleprecache-budget.md

**Interfaces and exact budgets:**
- package scripts: lint, check:fcis, build, verify.
- verify order: typecheck -> lint -> FCIS -> unit coverage -> one guarded Vite
  build -> Playwright against that build.
- Raw limits:

      initialEntryBytes = 423707
      largestAssetBytes = 907990
      totalOutputBytes = 5520272
      precacheBytes = 5494604
      precacheEntries = 82
      mermaidOwnedBytes = 3461961

- Baselines/rationale live in budgets.json; one-byte/one-entry over fails.
- Mermaid-owned matching uses Rollup module ownership, not a broad filename
  substring that can absorb unrelated chunks.

- [ ] **Step 1: Install lint dependencies and add failing negative fixtures**

  Add eslint, @eslint/js, typescript-eslint, and eslint-plugin-react-hooks as
  dev dependencies. Configure flat/type-aware lint and prove failures for a
  missing hook dependency, floating promise, promise-valued event callback,
  string throw, and unsafe caught error; corrected fixtures pass.

  Run: cd web && pnpm vitest run tooling/lintConfig.test.ts

  Expected: PASS only when each bad fixture reports its named rule and each
  corrected inline case reports no diagnostics.

  Run: cd web && pnpm lint

  Expected: FAIL on current suppressions/promise patterns until production code
  is stabilized.

- [ ] **Step 2: Add failing pure budget tests**

  Test exactly-at-limit, one byte over, one entry over, hash-independent totals,
  largest-contributor diagnostics, Mermaid ownership, and inability for the
  Mermaid exception to absorb an unrelated chunk.

  Run: cd web && pnpm vitest run tooling/buildBudgets.test.ts

  Expected: FAIL because no budget policy exists.

- [ ] **Step 3: Remove hook suppressions with stable abstractions**

  Convert each current exhaustive-deps suppression to useCallback, ref-backed
  event functions, or explicit initial-value refs while preserving focused
  behavior for reconnect, search, query, mount focus, draft adoption, and
  authoritative outline adoption. Keep no exhaustive-deps suppression.

- [ ] **Step 4: Integrate one guarded build and final precache check**

  Rollup generateBundle evaluates entry/largest/total and module-owned Mermaid
  output. Workbox manifestTransforms evaluates exact final URL sizes/count.
  Diagnostics list limits, actuals, deltas, and largest contributors. Existing
  sqlite WASM, app entry, and Mermaid assets remain precached; offline-shell E2E
  proves cold start and an allowed Mermaid render remain available.

- [ ] **Step 5: Make canonical verification include every guard**

  Avoid the current e2e build duplication by giving Playwright the already
  generated dist. Run cheap checks first. Confirm check:fcis is reused rather
  than duplicated.

  Run: cd web && pnpm lint && pnpm check:fcis && pnpm typecheck

  Run: cd web && pnpm vitest run tooling/buildBudgets.test.ts src/sync/SyncProvider.test.tsx src/components/SearchBar.test.tsx src/components/QueryBlock.test.tsx src/components/EditableBlockTree.test.tsx src/outline/useOutline.reconciliation.test.tsx src/components/MermaidDiagram.test.tsx

  Run: cd web && pnpm verify

  Expected: PASS; output reports all raw actuals below the exact limits and all
  Playwright tests pass without a second build.

- [ ] **Step 6: Complete and commit the bean**

  Check all pkm-f1rn criteria, record ESLint rules, zero suppressions, actual
  budget values, Mermaid exception, and verify order, mark completed, and
  commit.

  Commit: git commit -m "chore(web): add lint and production budgets"

---

### Task 11: Architecture documentation and epic completion audit

**Files:**
- Modify: docs/design.md
- Modify: docs/superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md only if implementation changed an explicit contract
- Modify: .beans/pkm-c1cg--web-architecture-and-fcis-hardening-from-2026-07-1.md
- Verify: every pkm-c1cg child bean file
- Verify: .superpowers/sdd/progress.md

**Interfaces:**
- Consumes: completed and task-reviewed Tasks 1-10.
- Produces: current architecture documentation, checked epic roadmap/completion
  criteria, canonical verification evidence, and a final whole-branch review
  package from merge base through HEAD.

- [ ] **Step 1: Update architecture documentation from actual code**

  Document worker ownership/recovery lease, settled versus drained delivery,
  poison repair, per-title sessions/editor lease/versioned reads, extracted core
  reducers and shell runners, shared grammar scanner, FCIS checker, lint rules,
  bundle/precache budgets, and Mermaid offline policy. Use exact current
  interface names and link to authoritative modules; remove superseded doctrine
  that treats shell composition as Functional Core.

- [ ] **Step 2: Audit every child acceptance criterion against evidence**

  For each checkbox in all ten child beans, identify the exact test or static
  check proving it. If evidence is missing or indirect, dispatch a fix subagent,
  add the focused red test, implement, re-run, and re-review before checking the
  item. Every child must be status completed with a Summary of Changes.

- [ ] **Step 3: Run fresh canonical verification**

  Run: cd web && pnpm verify

  Expected: typecheck, lint, FCIS, enforced coverage, one guarded production/PWA
  build, and all Playwright tests PASS. Capture exact test counts and budget
  actuals in the epic Summary of Changes.

- [ ] **Step 4: Dispatch final whole-branch review and fix all findings**

  Generate the review package from the branch merge base, use the
  requesting-code-review whole-branch template, and ask the most capable
  reviewer to validate all ten beans, cross-task interactions, test quality,
  FCIS semantics, and architecture docs. Send the complete finding list to one
  fix subagent, re-run covering tests, and re-review until ready.

- [ ] **Step 5: Complete the epic bean**

  Check all child-roadmap and completion-criteria boxes. Append a Summary of
  Changes containing child commits, review verdicts, canonical test counts,
  budget actuals, and architecture-doc path. Mark pkm-c1cg completed only after
  every checkbox is checked.

- [ ] **Step 6: Commit, push, and prepare branch integration**

  Commit: git commit -m "docs: complete web architecture hardening epic"

  Push the branch. Then use superpowers:finishing-a-development-branch and the
  project rule requiring a --no-ff merge. Do not claim completion until the
  integrated target and required verification evidence are authoritative.
