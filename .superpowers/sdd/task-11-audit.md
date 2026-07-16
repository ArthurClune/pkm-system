# Task 11 (Steps 1–2): Architecture docs refresh + child-bean evidence audit

Owner: Task 11 Steps 1–2 subagent. Steps 3–6 (fresh verify, whole-branch review,
epic-bean completion, integration) are the controller's.

Branch: `feat/pkm-c1cg-web-architecture` (worktree `.worktrees/pkm-c1cg`).

---

## Step 1 — Documentation

### `docs/design.md` (updated)

- **Extended the FCIS load-bearing-decisions bullet** to record that the web
  client's Functional-Core / Imperative-Shell boundary is now machine-checked
  and that composition of shells (React contexts, stateful components,
  `InlineSegments`) counts as Shell, not Core — with an anchor link to the new
  section. This is the "remove superseded doctrine that treats shell composition
  as Functional Core" item. Note: `design.md` itself contained no explicit
  prose claiming shell composition was Functional Core (that misclassification
  lived in the code headers and was corrected in `pkm-1jw6`); the doc edit makes
  the corrected rule explicit rather than deleting stale text.
- **Added a new section `## Web client architecture (sync, outline, and FCIS
  hardening)`** (before "Out of scope") covering, with verified interface names
  and links to authoritative modules:
  - Queue/RPC/worker lifecycle — `OpQueue` `WriteTicket`/`WriteOutcome`,
    `drain()`→`DrainOutcome` (`drained` vs `blocked` offline/retryable/
    recovering/disposed), `RETRY_DELAYS` 250/1000/5000, RPC 30 s / 120 s
    timeouts, dispose ownership (`web/src/sync/opQueue.ts`,
    `web/src/replica/rpc.ts`, `web/src/replica/client.ts`).
  - Exclusive replica recovery lease — `prepareRecovery`/`commitRecovery`/
    `abortRecovery`, final pending-row fingerprint compare, transactional schema
    reset (`web/src/replica/client.ts`, `workerHandlers.ts`, `recoveryGate.ts`).
  - Poison repair — typed `PoisonEvent`/`onPoison`, snapshot rebase, resync bump,
    retained mark intents / `retryPoisonMarks()`.
  - Per-title sessions / editor lease / versioned reads — `acquireOutlineSession`
    (`outline/outlineSessions.ts`), DnD `registerOutline`→`DndRegistration`
    (`dnd/DndContext.tsx`), `beginAuthoritativeRead`/`ReadToken`/
    `DeferredAuthoritative` (`outline/outlineState.ts`).
  - Standardized async UI lifecycles (QueryBlock / BlockTree / BlueskyEmbed /
    SidebarNav).
  - Extracted cores + shells — `decideEditorKey`, `transitionOutline` /
    `pendingTextOps` / `spliceUploadedMarkdown`, `transitionQueue` /
    `terminalReason`, `transitionSync` / `computeEditability`; and the explicit
    note that `replicaSync.ts` deliberately stays a shell.
  - Shared grammar scanner — `scanGrammar`/`GrammarToken` (`grammar/scan.ts`)
    and its six adapters, `shared/fixtures/ref_grammar.json` parity.
  - Enforced FCIS checker — `web/tooling/fcis.mjs` + `fcis-core.mjs` +
    `fcis-exemptions.json`, `check:fcis`, 101 modules (39/62/0), 0 forbidden
    edges, `uidCore.ts` split.
  - Lint (`eslint.config.js`, zero `eslint-disable`) and budgets
    (`buildBudgets.ts`/`viteBudgetPlugin.ts`/`budgets.json`) with the six caps
    and the **ratified `initialEntryBytes` 462016** superseding 423707.
  - Mermaid never-online precache policy under `mermaidOwnedBytes`, offline E2E.
  - The `pnpm verify` gate order.

All interface names above were verified against the code, not taken from the
task prompt. Two prompt names were wrong and corrected: the per-title registry
is the function `acquireOutlineSession` (not an `OutlineSessionRegistry` class),
and the shared scanner is `scanGrammar` returning `{ tokens }`.

### Spec amendment — `docs/superpowers/.../2026-07-15-web-architecture-fcis-hardening-design.md`

One explicit contract in the spec was changed by the implementation and is now
amended with a dated note:

- **§10 budgets, `initial entry JavaScript`**: spec stated `limit 423,707 bytes`.
  Added `[amended 2026-07-16, pkm-f1rn]` note rebaselining the ratified limit to
  **462,016 bytes** (actual 440,910 + ~4.8 % headroom), no shrink follow-up owed.

The **replicaSync-remains-a-shell** deviation needed no spec amendment: spec §7
lists only `outline/outlineState.ts`, `outline/keyboardPolicy.ts`,
`sync/queueState.ts`, `sync/syncState.ts` as extraction targets and never names
`replicaSync.ts` as a contract, so leaving it a shell contradicts no explicit
spec statement (it was a *plan* "Modify" entry only). Documented in `design.md`
instead.

---

## Step 2 — Child-bean acceptance-criterion → evidence audit

Status check: **all ten children are `status: completed`**. Nine carry a
`## Summary of Changes` section; `pkm-viah` uses `## Completion summary`
(semantically equivalent — see hygiene note below).

Evidence key: `T:` = test (file :: test name); `S:` = static check/artifact.
Test files are under `web/src/**` unless prefixed `server/`. Every bean's final
"pnpm verify passes" box is proven by the canonical run recorded in
`.superpowers/sdd/progress.md` and each `task-N-report.md`; the controller
re-establishes it authoritatively in Step 3.

### pkm-dcmm — worker lifecycle & queue idle semantics

| Criterion | Evidence |
|---|---|
| Replica dispose/close + provider terminates owned workers | T: `replica/client.test.ts` :: "dispose closes the worker database before disposing the RPC facade"; `sync/SyncProvider.test.tsx` :: "the internally created worker closes its database before one termination", "an injected replica remains caller-owned on provider unmount". S: `Replica.dispose` `replica/client.ts:82` |
| Pending RPC reject on worker/message error, timeout, disposal | T: `replica/rpc.test.ts` :: "handler errors reject with ReplicaError, quota flag preserved", "timeouts reject and remove each pending call without poisoning the client", "dispose rejects pending and future calls with an idempotent typed cause" |
| No provider remount leaks worker/OPFS | T: `sync/SyncProvider.test.tsx` :: "StrictMode effect replay keeps the queue live", "provider cleanup disposes the queue and cancels its retry timer", "an injected replica remains caller-owned on provider unmount" (behavioral proxy — see indirect note) |
| Queue APIs distinguish settled from drained/blocked | T: `sync/opQueue.test.ts` :: "legacy offline enqueue settles in memory while drain reports blocked", "legacy write ticket reports delivery only after its ops POST succeeds". S: `WriteOutcome`/`DrainOutcome` `sync/opQueue.ts:17,85` |
| Reconnect flows use correct semantic + retry policy | T: `sync/SyncProvider.test.tsx` :: "on reconnect, resyncSeq bumps only after the preserved queue has flushed", "a blocked reconnect drain does not pull the feed or bump resync", "automatic retry completes reconnect feed pull and resync exactly once", "overlapping reconnects share one completion and leave no stale intent"; `sync/opQueue.test.ts` :: "legacy reconnect resets retry delay to 250ms" |
| Worker-failure / cleanup / offline / transient-5xx tests added | T: `replica/rpc.test.ts` (failure/timeout/dispose); `sync/opQueue.test.ts` :: "while offline, enqueue is preserved but pumps no HTTP", "legacy 503 retains work and retries after 250ms", "a missed in-flight kick does not bypass the scheduled 5xx backoff" |
| pnpm verify passes | S: canonical verify, task-1-report.md / progress ledger |
| (feed/enqueue race fix in Summary) | T: `replica/client.test.ts` :: "a feed fetched before an acknowledged batch deletion cannot overwrite it" |

### pkm-qvqz — atomic replica recovery

| Criterion | Evidence |
|---|---|
| Enqueues gated/serialized during recovery/reset | T: `replica/recoveryGate.test.ts` :: "prepare is a FIFO barrier and later work waits for abort"; `replica/client.test.ts` :: "a recovery lease gates enqueue and offline POST until the fresh database is ready" |
| Persistence drained + pending rechecked immediately before reset | T: `replica/workerHandlers.test.ts` :: "commit refuses changed durable rows and releases the recovery lease", "commit detects an error-only durable row mutation hidden from the public lease" |
| No acknowledged enqueue erased by reset | T: `replica/workerHandlers.test.ts` :: "commit refuses changed durable rows…"; `replica/client.test.ts` :: "a prepare delayed past its client timeout cannot later orphan the worker lease" |
| Deterministic enqueue-vs-reset regression test | T: `replica/client.test.ts` :: "a recovery lease gates enqueue and offline POST until the fresh database is ready"; `replica/recoveryGate.test.ts` :: "prepare is a FIFO barrier and later work waits for abort" |
| Existing schema-mismatch & rebootstrap still covered | T: `replica/client.test.ts` :: "a schema-version mismatch is reported with the pending queue intact", "reset destroys the database and reinstalls a fresh schema"; `replica/workerHandlers.test.ts` :: "a reset commit rolls back schema rebuild when snapshot application fails", "rebase preserves and reapplies stable pending rows, then rejects token reuse", "schema reset removes obsolete user and virtual-table objects atomically" |
| pnpm verify passes | S: canonical verify, task-2-report.md |

### pkm-huv4 — reconcile after server-rejected batches

| Criterion | Evidence |
|---|---|
| SyncProvider observes & surfaces poison events | T: `sync/SyncProvider.test.tsx` :: "rejected batch repair finishes before resync and later delivery", "startup repairs durable poison before posting a later batch" |
| Poisoned optimistic effects rolled back via guarded rebase | T: `sync/SyncProvider.test.tsx` :: "rejected batch repair finishes before resync and later delivery"; `sync/opQueue.test.ts` :: "legacy 4xx fails only tickets touched by the rejected batch and barriers later work" |
| Later feed/snapshot doesn't reapply poisoned batch | T: `sync/SyncProvider.test.tsx` :: "failed poison repair stays visible and Retry succeeds without reapplying it"; `sync/syncState.test.ts` :: legacy-repair "runs, succeeds (bumping resync), and fails" |
| User gets recoverable error state, not silent divergence | T: `sync/SyncProvider.test.tsx` :: "reload retries only the durable mark and surfaces failure before startup", "startup discovery failure without fallback is visible and retryable" |
| Provider- and replica-level 4xx regression tests | T (provider): `sync/SyncProvider.test.tsx` poison suite (l.625–960); T (replica/queue): `sync/opQueue.test.ts` :: "legacy 4xx fails only tickets touched…"; `replica/workerHandlers.test.ts` :: "markPoisoned validates batch identity and remains idempotent" |
| pnpm verify passes | S: canonical verify, task-3-report.md |

### pkm-viah — eliminate same-title editor divergence

| Criterion | Evidence |
|---|---|
| Simultaneous same-title mounts can't create independent editable states | T: `views/EditablePage.test.tsx` :: "two same-title instances mounted in one commit expose exactly one editor" |
| All views share edits, or exactly one atomically read-only | T: `views/EditablePage.test.tsx` :: "same-title fallback observes the owner", "the read-only fallback still reflects genuinely remote batches"; `outline/outlineSessions.test.ts` :: "shares each flushed tree with every handle of a title" |
| DnD registration rejects duplicates / restores prior owner | T: `dnd/DndContext.test.tsx` :: "unregister stops delivery"; `components/EditableBlockTree.dnd.test.tsx` :: "a fallback panel (title already active elsewhere) is excluded from DnD both ways", "hands DnD registration to the remaining same-title view". S: `DndRegistration` duplicate-title `dnd/DndContext.tsx:20-21,57` |
| Old double-ownership test replaced with intended behavior | T: `views/EditablePage.test.tsx` :: "a page already active elsewhere in this tab renders read-only", "StrictMode same-title mount cleanup never exposes duplicate editors" |
| Sequential sidebar/main-pane behavior still covered | T: `views/EditablePage.test.tsx` :: "a remaining same-title fallback atomically takes over after owner unmount", "once the first instance unmounts, a freshly mounted one becomes editable again"; `outline/outlineSessions.test.ts` :: "grants one editor and hands ownership to the next live claimant" |
| pnpm verify passes | S: canonical verify, task-4-report.md |
| (review fix: session-owned WS + shared reads) | T: `outline/outlineSessions.test.ts` :: "coalesces overlapping authoritative reads and publishes their tree once", "retains delivery causality across release and reacquire" |

### pkm-z77x — versioned outline reconciliation

| Criterion | Evidence |
|---|---|
| Refetch adopted only if revision unchanged, else safely rebased | T: `outline/outlineState.test.ts` :: "adopts the newest response when its dispatch revision is unchanged", "requests a replacement when a remote revision advanced after dispatch"; `views/EditablePage.test.tsx` :: "stale initial rerender during a pending split keeps the optimistic new block focused" |
| Latest deferred payload reconsidered after writes drain | T: `outline/outlineState.test.ts` :: "defers a response dispatched before a local edit", "retains only the newest deferred authoritative payload", "replaces a candidate that arrived while a relevant ticket was blocked"; `outline/outlineSessions.test.ts` :: "invalidates an automatic read at final delivery settlement before replacing it once" |
| Unrelated-page pending work doesn't block this outline | T: `outline/outlineState.test.ts` :: "does not let an unrelated-title ticket block safe adoption"; `outline/outlineSessions.test.ts` :: "routes a cross-page ticket to source and fallback target but not another title" |
| Tests cover edits-after-dispatch + pending-drain reconciliation | T: `outline/outlineState.test.ts` :: "never adopts a pre-delivery response dispatched after the local edit"; `views/EditablePage.test.tsx` :: "stale initial rerender while its scoped write is unsettled keeps optimistic heading"; `views/Journal.test.tsx` :: "does not adopt an old journal payload into a session created mid-flight" |
| Own-echo filtering can't leave outline permanently stale | T: `views/EditablePage.test.tsx` :: "remote batches patch the tree; own-echo filtering is the provider", "remote update_text for a focused block with no draft is adopted"; `outline/outlineState.test.ts` :: "increments revision only for state-changing local and remote ops" |
| pnpm verify passes | S: canonical verify (72 files / 823 unit + 6/6 E2E), task-5-report.md |

### pkm-stn6 — standardize async UI lifecycles

| Criterion | Evidence |
|---|---|
| QueryBlock drops obsolete expr / pagination responses | T: `components/QueryBlock.test.tsx` :: "keeps only the current expr", "drops an obsolete pagination response after a rerender changes the expr", "ignores a stale generation", "ignores a second show-more click while a page request is already in flight", "recovers the page guard after a show-more that paginates from offset 0" |
| BlockTree reconciles authoritative collapse vs view-only toggle | T: `components/BlockTree.test.tsx` :: "preserves a local collapse toggle across a rerender when the authoritative value is unchanged", "adopts a real authoritative collapse transition even without a local toggle" |
| BlueskyEmbed actor-keyed DID + post-keyed height | T: `components/BlueskyEmbed.test.tsx` :: "ignores a resolved handle for an actor the href has since moved away from", "replaces the embedded DID immediately when href moves to a different raw-DID actor", "resets the reported height when href changes to a different post", "resolves the DID for a valid href after starting from an invalid href" |
| SidebarNav serializes mutations, disables controls, reports failures | T: `components/SidebarNav.test.tsx` :: "disables every mutating control while a reorder mutation and its refresh are in flight", "catches a reorder failure without crashing and reports it", "catches a remove failure, disables controls until settled, and allows a successful retry", "computes a reorder from the entries current when the lane begins, not when it was queued" |
| Rerender / out-of-order tests cover each case | T: the four component suites above (each contains rerender + deferred-resolution cases) + `defer<T>()` helper in `test-helpers.ts` |
| Reusable helpers introduced only where they reduce duplication | S: no shared `useAsync`; component-specific mechanisms documented in bean Summary (design decision, not a test) |
| pnpm verify passes | S: canonical verify at b5c6351 and 7a2c1ff, task-6-report.md |

### pkm-wudz — extract pure editor/sync state machines

| Criterion | Evidence |
|---|---|
| Pure transition APIs + effect descriptions defined | S: `outline/keyboardPolicy.ts` (`decideEditorKey`/`KeyDecision`), `sync/queueState.ts` (`transitionQueue`/`QueueEffect`), `sync/syncState.ts` (`transitionSync`/`SyncEffect`), `outline/outlineState.ts` (`transitionOutline`/`OutlineEffect`) — all `// pattern: Functional Core` |
| useOutline edit/upload-splice/remote-batch move to core | T: `outline/outlineState.test.ts` :: "flushes a changed pending draft before a structural op", "drops a no-op pending draft whose text is unchanged", "splices uploaded markdown at the requested offset", "clamps an upload splice offset past intervening typing" (backs `pendingTextOps`/`spliceUploadedMarkdown`) |
| Sync/queue transitions testable without React/fetch/worker/SQLite | T: `sync/queueState.test.ts` :: "is exhaustive over its event union", "a retryable failure schedules an escalating backoff", "caps the backoff at the last configured delay", "dispose is terminal and idempotent"; `sync/syncState.test.ts` :: "runs, succeeds (bumping resync), and fails", "reports a discovery failure", "throws on an unknown event" (no mocks) |
| EditableBlockTree keyboard policy separated from DOM | T: `outline/keyboardPolicy.test.ts` :: "splits at the caret on Enter", "auto-pairs a bracket", "wraps a markdown link on Cmd-K", "navigates when Ctrl-O fires inside a page reference", "suppresses editing chords when read-only", "sets a heading level from Ctrl+Alt+Digit" |
| Runtime files have accurate FCIS classifications | S: `pnpm check:fcis` (green) — cross-covered by pkm-1jw6 |
| Existing behavior + coverage thresholds preserved | S: canonical verify at 261f1fc, task-7-report.md; T: pre-existing EditablePage/opQueue/SyncProvider suites unchanged-green |
| pnpm verify passes | S: canonical verify at 261f1fc |

### pkm-1cq3 — consolidate reference/TODO grammar scanning

| Criterion | Evidence |
|---|---|
| Shared pure scanner returns stable spans/tokens with offsets | T: `grammar/scan.test.ts` :: "emits an exact bracket-inclusive span for a plain ref", "spans are UTF-16 code units (astral chars count as two)", "orders tokens by start, outer before children, with exact slices", "every offset lies within the input" |
| tokenize/refs/refAtCaret derive from the scanner | T: `grammar/tokenize.test.ts` :: "parses page refs, tags and block refs around plain text", "keeps an unclosed outer [[ as text while the balanced inner ref links", "treats blanked code as a tag boundary, matching refs.py"; `grammar/refs.test.ts` :: "ref grammar fixture (pinned against the Python parser)". S: adapters `outline/refAtCaret.ts` |
| TODO marker parsing centralized + reused | T: `grammar/todo.test.ts` :: "hasTodoMarker detects only a block-start marker (no quote prefix)", "code at the start of a block is never a marker", "flips TODO to DONE and back, preserving the bracket variant"; `grammar/scan.test.ts` :: "records spelling flags and the whitespace-suffix offset", "only recognizes the marker at offset 0" |
| Malformed / nested / overflow / round-trip contract tests | T: `grammar/scan.test.ts` :: "handles 10,000 nested references iteratively without RangeError", "malformed brackets stay plain text", "an unclosed fence degrades to an empty inline code pair"; `grammar/todo.test.ts` :: "double toggle is byte-identical for every spelling and quote prefix" |
| Public behavior compatible unless documented change | T: `server/tests/test_refs.py` :: `test_grammar_fixture` + `replica/refs.test.ts` :: "extractRefs agrees with the shared ref_grammar fixture" (three-way parity); `server/tests/test_refs_parity_fixture.py` :: `test_committed_refs_parity_fixture_is_current` (refs_parity.json byte-pinned). Intentional changes enumerated in bean Summary |
| pnpm verify passes | S: canonical verify at 9691df0 + server 395 passed, task-8-report.md |

### pkm-1jw6 — correct & enforce TypeScript FCIS boundaries

| Criterion | Evidence |
|---|---|
| rpc/uid/contexts/BlockRef/AssetImage/PageLink/TodoCheckbox/InlineSegments correctly classified or split | S: header `// pattern: Imperative Shell` in each (relabelled); `uidCore.ts` (Core) split from `uid.ts` (Shell). T: `uidCore.test.ts` :: "maps each byte to the alphabet character at byte & 63", "UID_BYTE_LENGTH matches the shell's requested random-byte count" |
| Core modules do not import Shell modules | S: `pnpm check:fcis` → 0 forbidden edges (101 modules: 39 Core/62 Shell/0 Mixed). T: `tooling/fcis-core.test.ts` :: "core -> shell import is forbidden", "runtime re-export from core to shell is forbidden", "dynamic import from core to shell is forbidden", "a type-only edge from core to shell is permitted" |
| Nondeterministic values gathered in shells / passed into pure fns | S: `uid.ts` calls `crypto.getRandomValues` and hands bytes to `uidCore`. T: `uidCore.test.ts` :: "is pure: same input always produces the same output" |
| Repo check enforces headers + core→shell boundaries | S: `web/tooling/fcis.mjs` + `check:fcis`. T: `tooling/fcis-core.test.ts` :: "missing header", "late header (past the first five lines)", "duplicate header", "unknown header text" |
| Intentional exceptions in unavoidable format | S: `tooling/fcis-exemptions.json` (7 exact-path entries). T: `tooling/fcis-core.test.ts` :: "empty or whitespace-only reasons are rejected", "Mixed (unavoidable) with a real reason" |
| Check runs in pnpm verify | S: `package.json` `verify` = `… && pnpm check:fcis && …` |
| pnpm verify passes | S: canonical verify at 503d99f, task-9-report.md |

### pkm-f1rn — web lint, FCIS checks, bundle/precache budgets

| Criterion | Evidence |
|---|---|
| Lint enforces React Hooks + TS promise/error rules | S: `web/eslint.config.js`. T: `tooling/lintConfig.test.ts` :: "each bad fixture reports its named rule", "each corrected variant is diagnostic-free" (fixtures: missing-hook-dependency, floating-promise, misused-promise, string-throw, unsafe-catch) |
| Existing exhaustive-deps suppressions removed/documented | S: `grep -rn "eslint-disable" web/src` → 0 matches |
| FCIS classification + import-boundary checks run in verification | S: `check:fcis` in `verify` (shared with pkm-1jw6) |
| Production bundle + precache budgets fail on material regression | S: `viteBudgetPlugin.ts` + `budgets.json`. T: `tooling/buildBudgets.test.ts` :: "fails when the entry is one byte over", "passes when every metric is exactly at its limit", "fails when one entry over the count limit", "fails when one byte over the byte limit" |
| Mermaid loading/precache only required capabilities or documented exception | T: `tooling/buildBudgets.test.ts` :: "a chunk is mermaid-owned only when every module is owned", "the mermaid exception cannot absorb an unrelated chunk", "bundle evaluation counts only fully-owned chunks as mermaid"; E2E `web/e2e/offline-shell.spec.ts` :: "mermaid renders offline from the precached chunk". S: `mermaidOwnedBytes` cap + rationale in `budgets.json` |
| pnpm verify includes new checks and passes | S: `verify` order typecheck→lint→check:fcis→coverage→build→playwright; canonical at 3b9ff69 (1021 unit / 7 E2E), task-10-report.md |

---

## Evidence gaps

**Count: 0 blocking gaps.** Every acceptance criterion maps to at least one
direct test or static check. Two items are covered indirectly but acceptably —
listed for transparency, not proposed for new work:

1. **pkm-dcmm — "No provider remount leaks worker or OPFS resources."** Proven
   by behavioral proxies (StrictMode replay keeps the queue live; injected
   replica stays caller-owned; cleanup disposes the queue/timer; the owned
   worker closes its DB before a single termination) rather than an explicit
   handle/resource-count assertion. A true leak counter is impractical under
   jsdom (OPFS handles aren't enumerable), so the proxy set is the right ceiling;
   no focused test would materially strengthen it. Not flagged for a fix.
2. **pkm-stn6 — "Reusable async helpers introduced only where they reduce
   duplication."** This is a negative design decision (deliberately *no* shared
   `useAsync`), so it is evidenced by the four component-specific mechanisms and
   the bean rationale, not by a test. Correctly unprovable by a unit test.

If the controller wants (1) hardened anyway, the focused test would be a
SyncProvider mount→unmount→remount cycle asserting the RPC facade's `dispose`
and the worker `terminate` are each called exactly once per owned instance
(spy-based) — but I judge the existing coverage sufficient.

---

## Deferred-Minor list (progress ledger) — reassessment

Items I believe are **already resolved** on this branch:

- **Task 9 — "fcis.mjs AST edge-extraction / type-only helpers lack direct unit
  tests."** The pure policy core is now directly unit-tested:
  `tooling/fcis-core.test.ts` covers `resolveRelativeSpecifier` (5 cases),
  `edgeDiagnostic` (core→core/shell→core/shell→shell/core→shell/core→Mixed/
  type-only/re-export/dynamic-import — 11 cases), `sortDiagnostics`,
  `formatDiagnostic`, `parseHeaderLines`, `classifyModule`, `headerDiagnostics`,
  `validateExemptions`. The residual untested surface is only the *shell's*
  (`fcis.mjs`) TS-compiler AST walk that produces the raw edges, which is I/O and
  is exercised by the live `check:fcis` run — appropriate to leave as
  integration-only.

Items I **cannot** confirm resolved (leave for the controller's Step 3/4):

- **Tasks 1–3 — pre-existing verification-output diagnostics** (unmatched-route,
  SQLite constraint, Node experimental, Vite chunk-size warnings). Hygiene
  triage; needs a fresh canonical run to assess. Untouched by later tasks as far
  as I can see.
- **Task 6 — SidebarNav generic-banner + specific-409 simultaneously; reorder
  test-name over-claim; QueryBlock pagination-recovery soft sync point.** The
  SidebarNav mutation lane collapses failures into one `failed` state and now has
  explicit failure/retry tests, but I did not find a test asserting the two
  banners are mutually exclusive, so I leave this open.
- **Task 10 — precacheEntries guard undercount (74 vs Workbox-final ~78, cap
  82); useOutline `run` recreation on sync identity; collectMermaidOwned lives in
  the plugin shell; task-10-report deps typo.** Budget-guard blind-spot is within
  headroom; all are final-review triage.

Items **confirmed as adjudicated (no action)**:

- **Task 7 — replicaSync remains a shell:** consistent with spec §7 (which never
  named it); documented in `design.md`.
- **Task 8 — refs_parity.json untouched:** byte-pinned by
  `server/tests/test_refs_parity_fixture.py`; new cases correctly went to
  `ref_grammar.json`, replayed three ways.

---

## Bean hygiene notes (Verify-only — controller owns bean edits)

1. `pkm-viah` titles its completion section `## Completion summary`, not
   `## Summary of Changes` like the other nine. Semantically equivalent; the
   controller may wish to normalize the heading when completing the epic.
2. `web/tooling/budgets.json`'s `initialEntryBytes` rationale text still ends
   with "shrinking the eager entry back toward 423707 is a follow-up for the
   epic audit, not this guardrail task." This mildly contradicts the user
   ratification recorded in the ledger ("no follow-up shrink work owed"). It is a
   code/config file, out of my docs-only scope; `design.md` and the spec now
   both state no shrink follow-up is owed. Controller may want to trim that
   trailing clause from the JSON rationale.

---

## Commit

`docs(web): refresh architecture for hardening epic` — `docs/design.md` +
`docs/superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md`
only. The untracked `docs/superpowers/handoffs/…` file was deliberately not
committed.
