# Web Architecture and FCIS Hardening Design

## Goal

Complete every child of `pkm-c1cg` by removing the identified sync and outline
data-integrity hazards, making editor/sync transitions explicit and testable,
restoring semantic Functional Core / Imperative Shell (FCIS) boundaries, and
adding verification guardrails for async React behavior, imports, lint, bundles,
and the PWA precache.

## Scope and completion policy

All ten child beans are required. No normal-priority child is deferred. Each
child is implemented by a fresh subagent, reviewed by a separate task reviewer,
and recorded in the durable SDD ledger before the next child begins. The epic is
complete only when every child acceptance criterion is checked, the resulting
boundaries are documented in `docs/design.md`, and the canonical `pnpm verify`
suite passes on the integrated branch.

The implementation uses one isolated epic branch and lands children
sequentially because the sync beans and outline beans share interfaces. This
avoids parallel edits to the same orchestration files while retaining fresh
context and independent review for every bean.

## Approaches considered

### Selected: dependency-first contracts, then correctness, extraction, enforcement

Establish precise queue/RPC lifecycle contracts first, use them to make recovery
and poison repair correct, add per-title outline state and reconciliation, then
extract pure reducers from the corrected behavior. Finish with grammar
consolidation, semantic FCIS enforcement, lint, and build budgets. This approach
minimizes temporary APIs and prevents extracting or enforcing known-buggy state
models.

### Rejected: numeric-roadmap order without dependency promotion

Starting the critical recovery bean before defining queue settlement and worker
lifecycle would force it to invent a temporary pause/idle protocol. The poison
and outline beans would then depend on different meanings of completion. This
creates repeated edits in the highest-risk files.

### Rejected: one broad rewrite

Replacing sync, outline ownership, editor policy, parsing, and tooling in one
change would obscure the concurrency regressions and make acceptance criteria
hard to prove. The selected design keeps one independently testable deliverable
per bean.

## Architecture

### 1. Queue, RPC, and worker lifecycle foundation (`pkm-dcmm`)

The current `idle()` name conflates local persistence with server delivery.
Replace it with explicit contracts:

```ts
type WriteOutcome =
  | { status: "persisted"; pending: number }
  | { status: "failed"; error: unknown };

interface WriteTicket {
  id: string;
  scope: readonly string[];
  settled: Promise<WriteOutcome>;
}

type DrainOutcome =
  | { status: "drained" }
  | { status: "blocked"; reason: "offline" | "retryable" | "recovering" | "disposed";
      pending: number; error?: unknown };

interface OpQueue {
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  settled(): Promise<void>;
  drain(): Promise<DrainOutcome>;
  setOnline(online: boolean): void;
  pause(reason: "recovery"): void;
  resume(reason: "recovery"): void;
  dispose(): void;
}
```

`settled()` means all earlier enqueue requests have finished persistence or
reported failure. `drain()` actively attempts delivery and returns `drained`
only after a fresh durable `pendingCount()` proves no deliverable batch remains.
Offline and retryable 5xx/network failures return a typed blocked result rather
than pretending the queue is empty. Retry uses cancellable exponential delays
of 250 ms, 1 s, and then 5 s capped, reset by success or reconnect.

The RPC client becomes an owned imperative resource. Pending calls reject on
worker `error`, `messageerror`, explicit disposal, or configured timeout; late
responses are ignored; calls after disposal reject. Ordinary RPC calls use a
30-second timeout, while snapshot/reset calls use 120 seconds. The provider
disposes only the worker/replica it created; an injected replica stays
caller-owned. Provider cleanup also cancels queue retries, sockets, gateway
listeners, and outstanding RPCs before terminating the owned worker.

### 2. Exclusive replica recovery (`pkm-qvqz`)

The replica worker owns a FIFO recovery gate covering every database-mutating
RPC, including normal enqueue and offline local-API writes. Recovery uses a
two-phase lease:

```ts
interface RecoveryLease {
  token: string;
  batches: readonly PendingBatch[];
}

interface Replica {
  prepareRecovery(): Promise<RecoveryLease>;
  commitRecovery(token: string, input: RecoveryCommit): Promise<void>;
  abortRecovery(token: string): Promise<void>;
}
```

`prepareRecovery()` waits for earlier mutations, then blocks later mutations
until `commitRecovery` or `abortRecovery` releases the lease. The sync shell
pauses normal delivery, flushes the lease's non-poisoned batches oldest-first
using durable `batch_id`, fetches the snapshot, and commits. The worker performs
one final pending-row comparison immediately before reset/rebase. If it differs,
the commit aborts without destructive work. Schema mismatch performs reset plus
snapshot; generation recovery may apply the snapshot without file deletion.
Every exit releases the lease in `finally` and resumes the queue. A successful
enqueue RPC is the acknowledgment boundary: it must either be among flushed
batches or remain durable in the post-recovery database.

### 3. Rejected-batch authoritative repair (`pkm-huv4`)

A poison event contains the database row id, durable batch id, operations, HTTP
status, and message. On a 4xx, the queue marks the row poisoned, pauses later
delivery, and emits the typed event. `SyncProvider` enters a visible recovering
state and invokes the same recovery coordinator used by schema/generation
recovery.

Poison repair fetches and applies a full snapshot while preserving the durable
queue. `applySnapshot` already reapplies non-poisoned pending batches and skips
poisoned ones, so the rejected optimistic effect disappears without losing
unrelated work. Only after replica repair completes does the provider bump the
resync generation and resume later delivery. If repair fails, the error remains
visible with retry and dismiss/details controls; retry repeats the guarded
snapshot. A successful repair may delete the rejected pending row after the UI
has captured its details. Later snapshots and feeds cannot reapply it because it
is either still marked poisoned or absent.

Connectivity and delivery health remain separate. A live WebSocket may coexist
with a poison or retryable delivery error, and the UI reports both accurately.

### 4. Per-title outline sessions and atomic editor leases (`pkm-viah`)

Introduce an imperative, ref-counted `OutlineSessionRegistry` keyed by title.
Each session shares the flushed optimistic/authoritative block tree and revision
among all views of that title. Focus, textarea drafts, selections, menus, and DOM
refs remain per-view.

Duplicate views initially render read-only/pending. A layout effect atomically
claims the sole editor lease through a subscription-backed external store; only
one view upgrades to editable. This avoids mutating global state during render
and prevents even a first-frame double editor in concurrent rendering. StrictMode
cleanup/remount is idempotent. A fallback view observes the shared tree after
each optimistic operation flush but does not expose a textarea or DnD surface.

DnD registration returns an explicit accepted/rejected result. A duplicate title
is rejected rather than replacing the valid owner. Cleanup is token-based so an
unmount cannot delete another owner's registration.

### 5. Versioned outline reconciliation (`pkm-z77x`)

Each outline session owns a monotonically increasing revision and title-scoped
write tickets. Parent, resync, and cross-page-move fetches call
`beginAuthoritativeRead()` before dispatch and return their token with the
payload:

```ts
interface ReadToken {
  requestId: number;
  revisionAtDispatch: number;
}

interface DeferredAuthoritative {
  token: ReadToken;
  blocks: BlockNode[];
}
```

A response is directly adoptable only when it is the newest request, the local
revision still equals `revisionAtDispatch`, and no title-relevant write ticket
is unsettled. Otherwise the session retains only the newest candidate. When the
relevant tickets settle, a candidate dispatched before a later local revision
is not blindly adopted; the session starts one fresh guarded read. Unrelated
page writes never block this title. Focus is validated against every adopted
tree. Own-echo filtering is safe because settlement or rejection always causes
the deferred candidate to be reconsidered or a fresh read to be scheduled.

This is client-side causality, not a server ETag. Request sequencing plus a fresh
read after local settlement is sufficient for the scoped acceptance criteria
without expanding the server API.

### 6. Standard async UI lifecycles (`pkm-stn6`)

Use component-specific mechanisms instead of a generic `useAsync` abstraction:

- `QueryBlock` has an expression generation, request id, and AbortController.
  Only the current generation/request may update groups, offset, error, or
  loading. Pagination is single-flight per generation.
- `BlockTree` tracks the previous authoritative `collapsed` value separately
  from the view-only toggle. An actual prop transition wins; an unchanged prop
  preserves the local view toggle.
- `BlueskyEmbed` keys DID resolution by the current actor and height by the
  current post identity. Stale resolutions are ignored; a new post clears the
  previous height immediately.
- `SidebarNav` has one serialized mutation lane covering mutation plus
  authoritative refresh. Conflicting controls are disabled until both finish;
  failures are caught, shown, and safely retryable.

### 7. Pure editor and sync state machines (`pkm-wudz`)

After the correctness contracts are stable, extract deterministic transitions:

- `outline/outlineState.ts`: local/remote operations, read tokens, deferred
  authoritative payloads, relevant write settlement, focus validation, upload
  splicing, and effect descriptions.
- `outline/keyboardPolicy.ts`: ordered key/modifier/editor-state input to
  semantic commands, text edits, autocomplete actions, or browser default.
- `sync/queueState.ts`: enqueue/persist/deliver/retry/poison/recovery/dispose
  events to queue state and effects.
- `sync/syncState.ts`: connection/replica/recovery/error events to provider
  state and effects.

The cores import no React, DOM, fetch, worker, timer, random, or SQLite modules.
Shells gather inputs, execute effects, and feed results back. Existing pure edit
and tree functions remain the operation semantics.

### 8. Shared reference and TODO scanner (`pkm-1cq3`)

Add one iterative Functional Core scanner returning UTF-16, half-open spans.
It uses an explicit stack for balanced `[[...]]` references, records depth and
parentage, recognizes opaque code spans first, and emits stable page-ref,
block-ref, hashtag, attribute, embed, and TODO tokens. Ten-thousand-level nesting
must not recurse or overflow. Malformed/unclosed syntax remains plain text.

`tokenize.ts`, both reference extractors, `refAtCaret.ts`, `todo.ts`, and
`slashCommands.ts` become adapters over the scanner. Existing public result
casing and the intentional empty-reference difference are preserved. Unicode
hashtag behavior becomes the canonical grammar while fixture parity proves
compatibility.

### 9. Semantic FCIS correction and enforcement (`pkm-1jw6`)

Correct misleading classifications: RPC, randomness, React contexts,
stateful/eventful components, and `InlineSegments` composition are Imperative
Shells. Split deterministic UID byte mapping and segment decisions only where
they form useful cores. New reducer/scanner/policy modules are Functional Cores.

Add a TypeScript-compiler-API checker that scans runtime `.ts/.tsx` modules,
requires one valid header in the first five lines, and rejects runtime
Functional-Core imports/re-exports/dynamic imports of Shell or Mixed modules.
Type-only edges are allowed because they emit no runtime dependency. Exemptions
are an exact path/reason table for tests, declarations, generated data,
configuration, and type-only files. Canonical unavoidable syntax is:

```ts
// pattern: Mixed (unavoidable) -- <non-empty reason>
```

The check prints deterministic source/target/location diagnostics and runs in
`pnpm verify`.

### 10. Lint and production/PWA budgets (`pkm-f1rn`)

Add ESLint flat configuration with type-aware TypeScript and React Hooks rules.
At minimum enforce hooks rules, exhaustive dependencies, floating promises,
misused promises, Error-only throws, and unknown catch values. Remove every
current exhaustive-deps suppression by using stable callbacks or ref-backed
event functions; any exceptional suppression requires a same-line rationale and
a focused stability test.

Budget policy is pure and testable, with Vite/Rollup and Workbox adapters. Raw
byte limits use 5% headroom from the verified baseline and are stored with
rationale in `web/tooling/budgets.json`:

- initial entry JavaScript: baseline 403,530 bytes, limit 423,707 bytes;
- largest emitted asset: baseline 864,752 bytes, limit 907,990 bytes;
- total emitted production bytes: baseline 5,257,401 bytes, limit 5,520,272
  bytes;
- aggregate precache: baseline 5,232,956 bytes, limit 5,494,604 bytes;
- precache entry count: baseline 78, limit 82;
- Mermaid-owned emitted assets: baseline 3,297,105 bytes, limit 3,461,961
  bytes.

Mermaid keeps its current full offline capability. Its diagram-family chunks
are an explicit named exception with their own aggregate cap recorded from the
guarded baseline; the exception matches only Mermaid-owned chunks and cannot
absorb unrelated output. This avoids silently breaking never-online diagram
rendering while preventing upgrades from expanding the precache unnoticed.

`pnpm verify` runs cheap checks first: typecheck, lint, FCIS, unit coverage,
production build with bundle/precache enforcement, then Playwright. The build is
not duplicated.

## Error handling and recovery invariants

1. No successful worker enqueue response can be erased by recovery.
2. A destructive recovery never commits if the final pending-row check differs
   from its prepared lease.
3. All recovery exits release the worker gate and queue pause.
4. A rejected batch is never retried or optimistically reapplied.
5. Later valid batches do not post until rejected-state repair has completed or
   explicitly failed into a visible retry state.
6. Offline persistence success and server delivery are distinct outcomes.
7. Disposed workers, queues, and RPC clients settle all outstanding promises and
   schedule no future work.
8. Stale async UI responses never mutate current-generation state.
9. An authoritative outline response never overwrites a revision created after
   its dispatch.

## Testing strategy

Every bean follows red-green-refactor with deterministic deferred promises or
event barriers rather than timing sleeps. Sync tests cover worker-handler and
provider integration as well as pure transitions. Outline tests cover reducer,
hook, duplicate-view, DnD, and parent-fetch boundaries. UI lifecycle tests use
rerender and out-of-order resolution. Scanner contracts cover offsets,
malformed input, nesting/overflow, shared fixtures, and round trips. Tooling has
negative fixtures proving each rule and one real-tree integration check.

After each child, run its focused tests, typecheck, and task review. At epic end,
run the complete `pnpm verify`, inspect the produced bundle/precache report, and
perform a requirement-by-requirement audit against all ten beans and the epic
completion criteria.

## Documentation

Update `docs/design.md` after behavior settles to document:

- the worker recovery lease and lifecycle ownership;
- queue settlement versus delivery states and poison repair;
- per-title outline sessions, editor leasing, and versioned reads;
- the extracted Functional Core modules and Shell effect runners;
- the shared grammar scanner;
- FCIS, lint, bundle, and PWA verification gates.
