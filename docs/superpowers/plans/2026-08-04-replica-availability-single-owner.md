# Replica Availability: One Owner, Everything Derived — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the replica worker the single owner of "is the replica usable?", carry that
fact across the RPC boundary as a typed error, and derive or delete the other four
representations of it.

**Architecture:** `buildHandlers` latches a `ReplicaUnavailableError` on the first
`openDb()` failure and every handler rejects with it. That error crosses the existing
`{message, quota}` wire-error mechanism (`rpc.ts:4`) via two new flags, and the main thread
reconstructs the typed error. `opQueue` retains ops by error *type* instead of by matching
error-message strings; `replicaSync` and `SyncProvider` derive `no-replica` from the typed
rejection instead of from `init().ok`, a `disabled` boolean, a viability probe, and
`markUnavailable()`. Finally `base_text_hash` moves to main-thread stamping so ops that
never reach the database keep their conflict protection.

**Tech Stack:** TypeScript, React 19, Vitest (jsdom + node environments), Playwright,
sqlite-wasm (opfs-sahpool VFS), pnpm.

**Epic:** pkm-q2jj. **Design:** `docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`.

## Global Constraints

- **Branch:** work on `pkm-replica-availability` (already checked out, `608b066`, pushed).
  This session is configured to work in place — do **not** create a worktree.
- **Verification, every task:** `cd web && pnpm verify` (typecheck + enforced unit coverage
  + Playwright e2e). Unit-only iteration: `cd web && pnpm test:unit`. Types only:
  `cd web && pnpm typecheck`.
- **Enforced coverage thresholds** (`web/vite.config.ts`): statements 95, branches 91,
  functions 89, lines 95. New Functional Core files must be fully unit-tested or the run
  fails.
- **Baseline to preserve** (measured on `main` at handover): 122 test files / 1972 tests,
  coverage 97.7% statements / 93.09% branches, 51/51 Playwright e2e, **0 jsdom
  "Not implemented:" warnings** (`web/src/test-setup.ts` fails the run on any).
- **Never bind port 8974** — the production launchd service owns it on this machine.
- **FCIS:** every file with runtime behaviour declares `# pattern: Functional Core` or
  `# pattern: Imperative Shell` near the top (`//` comment in TS). New pure modules in this
  plan are Functional Core.
- **Beans:** update the child bean's checklist in the same commit as its code, and commit
  `.beans/` files alongside. Do not create beans for deploys.
- **Commit style:** `type(bean-id): summary`, e.g. `feat(pkm-y35i): carry replica
  unavailability as a typed error`. End messages with the standard trailers.
- **`git merge --no-ff`** when this branch eventually lands on `main`.
- **Out of scope:** pkm-tu5k. Its *policy* (what to do about a rejection that can never be
  repaired) is deliberately undecided. This plan makes its fix possible; it must not
  pre-empt it. Leave the "known-rejected batch still holds the gate" behaviour exactly as
  it is.

## Findings that refine the approved design

Read these before Task 1. They came out of reading the code against the spec and they
change two tasks. The spec's Risk section explicitly asks for exactly this ("Any behaviour
that cannot be pinned … record it as a finding").

1. **Deleting the message whitelist wholesale would regress pkm-ndcu.** The spec says
   `opQueue` "retains on type. Deleted: message matching on this path." But
   `isPoolExhausted` (`SQLITE_CANTOPEN` / "pool is full") fires on **writes to a
   successfully opened database** — the pool came up with capacity 1, the open succeeded,
   and every write fails for the life of the worker (`poolCapacity.ts` header). That is not
   an availability failure, so a type check on `unusable`/`unreachable` would miss it and
   the error would fall through to `onDesync`, whose repair wipes the active outline
   mid-keystroke. **Resolution:** invert the rule. `opQueue` retains on *any* replica
   failure **except** one the replica reports as a rejection of the op itself. That is what
   pkm-9x6u's own scope correction asks for ("retain on ANY unclassified replica error,
   not only while in a no-replica mode"), and it needs one extra wire flag (`rejected`,
   carried by `LocalOpError`) rather than a whitelist. The rule is now a one-item blocklist
   instead of a three-item allowlist.
2. **`RpcLifecycleError` "timeout" is not terminal.** `createRpcClient` only latches its
   `terminal` field on `worker-error`, `message-error` and `disposed` (`rpc.ts:111-117`,
   `144-147`); the timeout path rejects one request and leaves the client usable
   (`rpc.ts:125-129`). So "unreachable" must be split by evidence: every level **retains**
   the op, but only *session-fatal* evidence latches an availability state. A single slow
   call is not a dead replica.
3. **Nothing in `web/src` ever throws an error carrying `quota: true`.** The flag is set
   only by tests (`opQueue.replica.test.ts:247`, `rpc.test.ts`). So the
   quota → `onQuota` → `quotaExhausted` → read-only chain is unpinnable end-to-end against
   real code today. Not fixed here — the mechanism is left exactly as it is — but record it
   in pkm-imw4 as a behaviour nobody has verified.
4. **`init().ok` becomes vestigial and is therefore deleted.** Once the worker latch makes
   every handler reject, an `init()` that *resolves* always has `ok: true`. Leaving the
   field is representation #1 of the design's table surviving the refactor, so Task 5
   deletes it from `ReplicaInit`. The fixture churn (every fake replica's `init`) is
   mechanical and typecheck finds every site.

---

### Task 1: The replica error taxonomy and its wire flags (pkm-y35i)

Additive only — no consumer behaviour changes, which is why characterisation (Task 2) can
follow it. The one exception is `isStallShaped`, which is a no-op until Task 3 makes
something actually throw `ReplicaUnavailableError`.

**Files:**
- Create: `web/src/replica/errors.ts`
- Create: `web/src/replica/errors.test.ts`
- Modify: `web/src/replica/rpc.ts` (delete the class definitions at `30-55`, import them;
  wire shape at `24-28`; `serveRpc`'s error copy at `68-74`; the client's reconstruction at
  `108`)
- Modify: `web/src/replica/localOps.ts:18-32` (`LocalOpError` gains `rejected`)
- Modify: `web/src/sync/replicaSync.ts:13` (import), `99-101` (`isStallShaped`)
- Modify: `web/src/sync/opQueue.ts:11` (import only — the retention rule changes in Task 4)
- Modify imports only: `web/src/replica/rpc.test.ts:3`,
  `web/src/sync/opQueue.replica.test.ts:6`, `web/src/sync/replicaSync.test.ts:5`
- Test: `web/src/replica/errors.test.ts`, `web/src/replica/rpc.test.ts`,
  `web/src/sync/replicaSync.test.ts`

**Interfaces:**
- Produces:
  - `class ReplicaError extends Error` with `readonly quota: boolean` and
    `readonly rejected: boolean`; constructor `(message: string, flags?: ReplicaErrorFlags)`.
    **The constructor signature changes** from `(message, quota: boolean)`.
  - `interface ReplicaErrorFlags { quota?: boolean; rejected?: boolean }`
  - `class ReplicaUnavailableError extends ReplicaError`, constructor
    `(message: string, flags?: ReplicaErrorFlags)`
  - `class RpcLifecycleError extends Error` and `type RpcLifecycleKind` (moved verbatim
    from `rpc.ts`)
  - `type ReplicaAvailability = "unusable" | "unreachable"`
  - `function availabilityOf(error: unknown): ReplicaAvailability | null`
  - `function isSessionFatal(error: unknown): boolean`
  - All of the above exported from `web/src/replica/errors.ts`.
- Consumes: nothing.

**Why the classes move out of `rpc.ts`:** `ReplicaUnavailableError extends ReplicaError`, and
`rpc.ts` must import the subclass to reconstruct it client-side. Leaving `ReplicaError` in
`rpc.ts` makes that an import cycle whose `extends` resolution is module-evaluation-order
dependent. One module owning the taxonomy, imported one-way by the transport, has no cycle.
`errors.ts` is Functional Core: class definitions and pure predicates, no I/O — the same
shape as `openRetry.ts`'s `isSahPoolContention`.

- [ ] **Step 1: Write the failing test for the taxonomy**

Create `web/src/replica/errors.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { availabilityOf, isSessionFatal, ReplicaError,
         ReplicaUnavailableError, RpcLifecycleError } from "./errors";

describe("ReplicaError flags", () => {
  test("both flags default to false", () => {
    const error = new ReplicaError("boom");
    expect(error.quota).toBe(false);
    expect(error.rejected).toBe(false);
  });

  test("flags are carried independently", () => {
    expect(new ReplicaError("full", { quota: true }).quota).toBe(true);
    expect(new ReplicaError("bad title", { rejected: true }).rejected).toBe(true);
    expect(new ReplicaError("full", { quota: true }).rejected).toBe(false);
  });

  test("an unavailable error is still a ReplicaError", () => {
    // Every existing `instanceof ReplicaError` check must keep working.
    expect(new ReplicaUnavailableError("no db")).toBeInstanceOf(ReplicaError);
  });
});

describe("availabilityOf", () => {
  test("the worker's own failed open is unusable", () => {
    expect(availabilityOf(new ReplicaUnavailableError("no db"))).toBe("unusable");
  });

  test("a terminal RPC failure is unreachable, not unusable", () => {
    // "we could not ask" is not evidence that there is no database (pkm-bjae).
    for (const kind of ["worker-error", "message-error", "timeout", "disposed"] as const) {
      expect(availabilityOf(new RpcLifecycleError(kind, kind))).toBe("unreachable");
    }
  });

  test("an ordinary replica error is not an availability failure", () => {
    expect(availabilityOf(new ReplicaError("SQLITE_CANTOPEN"))).toBeNull();
    expect(availabilityOf(new Error("something else"))).toBeNull();
    expect(availabilityOf("not an error")).toBeNull();
  });
});

describe("isSessionFatal", () => {
  test("a latched open failure is fatal for the session", () => {
    expect(isSessionFatal(new ReplicaUnavailableError("no db"))).toBe(true);
  });

  test("a timeout is NOT fatal: one slow call is not a dead replica", () => {
    // createRpcClient only latches `terminal` for worker-error/message-error/
    // disposed; the timeout path leaves the client usable (rpc.ts).
    expect(isSessionFatal(new RpcLifecycleError("timeout", "timed out"))).toBe(false);
  });

  test("a terminally failed RPC client is fatal", () => {
    for (const kind of ["worker-error", "message-error", "disposed"] as const) {
      expect(isSessionFatal(new RpcLifecycleError(kind, kind))).toBe(true);
    }
  });

  test("a non-availability error is never session-fatal", () => {
    expect(isSessionFatal(new ReplicaError("disk full", { quota: true }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/replica/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors"`.

- [ ] **Step 3: Create the taxonomy module**

Create `web/src/replica/errors.ts`:

```ts
// pattern: Functional Core
// The replica's error taxonomy, and what each kind implies about availability.
// Pure class definitions and predicates: no I/O, no transport. rpc.ts (the
// transport shell) imports these; nothing here imports rpc.ts, which is what
// keeps ReplicaUnavailableError's `extends` out of an import cycle.
//
// Why a taxonomy exists at all: "is the replica usable?" used to be re-derived
// by every consumer, most alarmingly by matching strings in an error message to
// decide whether the user's writes survived (pkm-q2jj). The worker owns the
// fact; these types are how it travels.

export interface ReplicaErrorFlags {
  /** Local storage refused the write for want of space. */
  quota?: boolean;
  /** The replica refused the OP ITSELF (unsupported title syntax), not the
   * storing of it. This is the ONLY replica failure that is terminal for an op:
   * the server would refuse it too, so retaining and retrying cannot help, and
   * it is the one case that still reaches onDesync. */
  rejected?: boolean;
}

export class ReplicaError extends Error {
  readonly quota: boolean;
  readonly rejected: boolean;

  constructor(message: string, flags: ReplicaErrorFlags = {}) {
    super(message);
    this.name = "ReplicaError";
    this.quota = flags.quota === true;
    this.rejected = flags.rejected === true;
  }
}

/** The worker's own openDb() failure, latched for the session. Only the worker
 * can raise this: it is the one party able to say "there is definitively no
 * database", as opposed to "I could not ask". */
export class ReplicaUnavailableError extends ReplicaError {
  constructor(message: string, flags: ReplicaErrorFlags = {}) {
    super(message, flags);
    this.name = "ReplicaUnavailableError";
  }
}

export type RpcLifecycleKind =
  | "worker-error"
  | "message-error"
  | "timeout"
  | "disposed";

export class RpcLifecycleError extends Error {
  readonly kind: RpcLifecycleKind;
  override readonly cause: unknown;

  constructor(kind: RpcLifecycleKind, message: string, cause?: unknown) {
    super(message);
    this.name = "RpcLifecycleError";
    this.kind = kind;
    this.cause = cause;
  }
}

/** The availability fact, at the two evidentiary levels its two consumers need.
 * Retaining an op needs only "this write did not persist locally"; lifting the
 * op queue's recovery barrier needs "there is positively no poison table to
 * read", because delivering past an unrepaired rejection is the ordering hazard
 * the barrier exists for (pkm-bjae).
 *
 * | value        | meaning                          | retain? | may lift barrier? |
 * | unusable     | openDb() failed: no database      | yes     | YES               |
 * | unreachable  | the RPC is broken: could not ask  | yes     | NO                |
 *
 * Only `unusable` ever crosses the wire (the worker reporting its own failed
 * open). `unreachable` is generated client-side, so the two levels come from
 * two different places and are combined here, never in the wire shape. */
export type ReplicaAvailability = "unusable" | "unreachable";

export function availabilityOf(error: unknown): ReplicaAvailability | null {
  if (error instanceof ReplicaUnavailableError) return "unusable";
  if (error instanceof RpcLifecycleError) return "unreachable";
  return null;
}

/** Whether this evidence is itself permanent for the session, and so may be
 * latched by a consumer. The worker latches a failed open until close(), and
 * createRpcClient latches its own terminal state for worker-error/
 * message-error/disposed — but NOT for a timeout, which rejects one request and
 * leaves the client usable. Retention does not need this distinction (every
 * level retains); latching a state does. */
export function isSessionFatal(error: unknown): boolean {
  if (error instanceof ReplicaUnavailableError) return true;
  return error instanceof RpcLifecycleError && error.kind !== "timeout";
}
```

- [ ] **Step 4: Run the taxonomy tests**

Run: `cd web && pnpm vitest run src/replica/errors.test.ts`
Expected: PASS (14 assertions across 8 tests).

- [ ] **Step 5: Write the failing wire tests**

Add to `web/src/replica/rpc.test.ts` (and change its import at line 3 to pull
`ReplicaError` from `./errors`, adding `ReplicaUnavailableError`):

```ts
test("an unavailable handler error reconstructs as ReplicaUnavailableError", async () => {
  // The wire flag is a boolean and the fact is two-valued, deliberately: only
  // `unusable` crosses the wire. `unreachable` is what the client itself
  // produces when nothing can cross.
  const pair = new MessageChannel();
  serveRpc(toPortLike(pair.port2), {
    boom: () => Promise.reject(new ReplicaUnavailableError("no openable database")),
  });
  const client = createRpcClient(toPortLike(pair.port1));
  const err = await client.call("boom").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaUnavailableError);
  expect((err as ReplicaUnavailableError).message).toBe("no openable database");
  expect(availabilityOf(err)).toBe("unusable");
});

test("the rejected flag survives the wire", async () => {
  // LocalOpError (unsupported title syntax) is the one replica failure the op
  // queue must NOT retain; it travels as a flag, not as a message to match.
  const pair = new MessageChannel();
  serveRpc(toPortLike(pair.port2), {
    boom: () => Promise.reject(new ReplicaError("bad title", { rejected: true })),
  });
  const client = createRpcClient(toPortLike(pair.port1));
  const err = await client.call("boom").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaError);
  expect(err).not.toBeInstanceOf(ReplicaUnavailableError);
  expect((err as ReplicaError).rejected).toBe(true);
  expect((err as ReplicaError).quota).toBe(false);
});
```

Match the existing file's channel/port setup rather than the sketch above if it differs —
read `rpc.test.ts:36-48` first and mirror it exactly, including how it constructs the port
pair.

- [ ] **Step 6: Run them and watch them fail**

Run: `cd web && pnpm vitest run src/replica/rpc.test.ts`
Expected: FAIL — `ReplicaUnavailableError` is not exported from `./errors` yet as far as
`rpc.ts` is concerned, and the reconstructed error is a plain `ReplicaError`.

- [ ] **Step 7: Rewire `rpc.ts`**

In `web/src/replica/rpc.ts`: delete the `ReplicaError`, `RpcLifecycleKind` and
`RpcLifecycleError` declarations (lines 30-55) and import them instead. Update the header
comment's error sentence. Then:

```ts
// pattern: Imperative Shell
// MessagePort RPC transport and lifecycle shell: installs port handlers, owns
// mutable request/timer state, posts messages, and disposes terminal resources.
// Errors cross as {message, quota, rejected, unavailable} so the storage-quota
// signal, the op-rejected signal and the replica-unavailable signal all survive
// the boundary; the taxonomy itself lives in ./errors.

import { ReplicaError, ReplicaUnavailableError, RpcLifecycleError } from "./errors";

export type { RpcLifecycleKind } from "./errors";
export { ReplicaError, ReplicaUnavailableError, RpcLifecycleError } from "./errors";
```

The re-exports keep `import { ReplicaError } from "../replica/rpc"` compiling for anything
missed; every site in this plan is switched to `./errors` directly, so the re-export line is
a transitional convenience — **delete it in Task 8** once `grep -rn 'from "\.\./replica/rpc"'`
shows no importer needs it.

Wire shape and both ends:

```ts
interface RpcResponse {
  id: number;
  result?: unknown;
  error?: {
    message: string;
    quota: boolean;
    rejected: boolean;
    /** The worker's latched openDb() failure. Only ever set worker-side. */
    unavailable: boolean;
  };
}
```

In `serveRpc`'s rejection handler (replacing lines 68-74):

```ts
      (e: unknown) => port.postMessage({
        id: req.id,
        error: {
          message: e instanceof Error ? e.message : String(e),
          quota: Boolean((e as { quota?: boolean })?.quota),
          rejected: Boolean((e as { rejected?: boolean })?.rejected),
          unavailable: e instanceof ReplicaUnavailableError,
        },
      } as RpcResponse),
```

In the client's `onmessage` (replacing line 108):

```ts
    if (res.error) {
      const flags = { quota: res.error.quota, rejected: res.error.rejected };
      p.reject(res.error.unavailable
        ? new ReplicaUnavailableError(res.error.message, flags)
        : new ReplicaError(res.error.message, flags));
    } else p.resolve(res.result);
```

- [ ] **Step 8: Flag `LocalOpError` as a rejection**

In `web/src/replica/localOps.ts`, inside `class LocalOpError` (line 18):

```ts
export class LocalOpError extends Error {
  /** Read by serveRpc onto the wire error: this is the replica refusing the OP,
   * not failing to store it, so the op queue must not retain and retry it —
   * the server would refuse it too. */
  readonly rejected = true;
  readonly opIndex?: number;
```

- [ ] **Step 9: Run the wire tests**

Run: `cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/errors.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing `isStallShaped` test**

Add to `web/src/sync/replicaSync.test.ts`, modelled on the existing test at line 787
("pulls failing with ReplicaError still stall at 3") — read it and copy its harness:

```ts
test("an unavailable-shaped pull failure never stalls (pkm-y35i)", async () => {
  // A session reporting `stalled` on top of `no-replica` lets computeEditability
  // flip the whole session read-only, so an availability failure must not count
  // toward the stall threshold — however many times it happens.
  const states: ReplicaState[] = [];
  const replica = fakeReplica();
  replica.pendingBatches = () =>
    Promise.reject(new ReplicaUnavailableError("no openable database"));
  const sync = createReplicaSync({
    replica, fetchJson: okFetch, clientId: "c1",
    onState: (s) => states.push(s),
  });
  await sync.start();
  for (let i = 0; i < STALL_AFTER_FAILURES + 2; i += 1) {
    sync.onSeq(i + 100, true);
    await sync.idle();
  }
  expect(states.filter((s) => s.mode === "stalled")).toEqual([]);
});
```

Adapt `fakeReplica`/`okFetch` to whatever the file already uses (read the top of
`replicaSync.test.ts` for its helper names) and import `ReplicaUnavailableError` from
`../replica/errors`.

- [ ] **Step 11: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts -t "never stalls"`
Expected: FAIL — a `stalled` state is reported, because `ReplicaUnavailableError extends
ReplicaError` and `isStallShaped` matches `ReplicaError`.

- [ ] **Step 12: Exclude availability failures from stall classification**

In `web/src/sync/replicaSync.ts`, change the import at line 13 to
`import { availabilityOf, ReplicaError } from "../replica/errors";` and replace
`isStallShaped` (lines 99-101):

```ts
/** Network-down failures (dropped connection, DNS, an offline fetch) are not
 * wedged-replica symptoms -- the offline banner already owns network-down
 * UX, and counting them here would flip a whole offline session read-only
 * via computeEditability. Availability failures are excluded for the same
 * reason and more sharply: a session that reports `stalled` on top of
 * `no-replica` is reporting a wedged replica it has already concluded does not
 * exist, and computeEditability would take editing away for the rest of the
 * session (pkm-y35i). Only failures that mean "the replica itself cannot make
 * progress" -- a rejected/failed API call, a replica-side RPC error, or pull()
 * starving on pending-batch churn -- count toward the stall threshold;
 * anything else still retries with backoff but is neither counted nor reported
 * as stalled. */
const isStallShaped = (error: unknown): boolean =>
  availabilityOf(error) === null &&
  (error instanceof ApiError || error instanceof ReplicaError ||
    error instanceof PullStarvedError);
```

- [ ] **Step 13: Switch the remaining importers and typecheck**

Change `ReplicaError` imports to `../replica/errors` in:
`web/src/sync/opQueue.ts:11`, `web/src/sync/opQueue.replica.test.ts:6`,
`web/src/sync/replicaSync.test.ts:5`, `web/src/replica/rpc.test.ts:3`.

Then fix every `new ReplicaError("…", true)` call to the flags object — there are exactly
three: `opQueue.replica.test.ts:247` (`{ quota: true }`), `replicaSync.test.ts:792` and
`:857` (`{}` — they passed `false`).

Run: `cd web && pnpm typecheck`
Expected: clean. If pyrefly/tsc reports any other `ReplicaError` construction, fix it the
same way.

- [ ] **Step 14: Full verify**

Run: `cd web && pnpm verify`
Expected: all unit tests pass, coverage above thresholds, 51/51 e2e, no jsdom warnings.

- [ ] **Step 15: Commit**

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-y35i -s completed
git add web/src/replica/errors.ts web/src/replica/errors.test.ts \
        web/src/replica/rpc.ts web/src/replica/rpc.test.ts \
        web/src/replica/localOps.ts \
        web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts \
        web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts .beans
git commit -m "feat(pkm-y35i): carry replica unavailability as a typed error

The wire error gains `unavailable` and `rejected` beside `quota`, following
the precedent at rpc.ts:4, and the taxonomy moves to a Functional Core
replica/errors.ts so the subclass can extend ReplicaError without an import
cycle. availabilityOf/isSessionFatal split the fact into the two evidentiary
levels its consumers need. No consumer behaviour changes yet, except that
isStallShaped now excludes availability failures — a session must not report
`stalled` on top of `no-replica`, which computeEditability would turn into a
read-only session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 2: Characterise the behaviour the refactor must preserve (pkm-imw4)

**This is a hard prerequisite, not a nicety.** Tasks 3-6 delete three load-bearing things
(the viability probe, the `disabled` boolean, the message whitelist) from the code path
behind pkm-c9hp, pkm-ndcu, pkm-hhbc, pkm-wi25 and pkm-bjae.

**The rule for this task:** pin only behaviour this plan intends to **preserve**. Behaviour
this plan intends to **change** is pinned by the repro tests that land green with their fix
(Task 4 for pkm-9x6u, Task 7 for pkm-4ubd) — writing a characterisation test only to delete
it two commits later is churn, not a net.

Behaviour that is **already pinned** — verify each still passes, do not duplicate:

| Behaviour | Existing test |
|---|---|
| a failed open stays latched; `init()`'s `ok:false` must not re-arm | `replica/workerHandlers.test.ts:237` |
| an unopenable replica delivers queued ops online, mode `no-replica`, `replica-unavailable` problem | `sync/SyncProvider.test.tsx:1089` |
| a replica that becomes openable later must not start syncing | `sync/SyncProvider.test.tsx:1119` |
| a known-rejected batch still holds the gate when it cannot be repaired | `sync/SyncProvider.test.tsx` (grep "cannot be repaired") |
| quota / SAH-contention / pool-exhausted enqueue failures are retained, not desynced | `sync/opQueue.replica.test.ts:244`, `:263`, `:293` |
| a retained op keeps its place behind the durable batches that preceded it | `sync/opQueue.replica.test.ts:866`, `:891`, `:916`, `:951`, `:995` |
| a `ReplicaError` pull failure stalls at 3; a network-shaped one never does | `sync/replicaSync.test.ts:787`, `:762`, `:810` |
| `markUnavailable` is permanent even if a later `init()` would succeed | `sync/replicaSync.test.ts:121` |
| `resetLocalData` cannot revive a session marked unavailable | `sync/replicaSync.test.ts:140` |

**Files:**
- Modify: `web/src/replica/workerHandlers.test.ts` (add two tests)
- Modify: `web/src/sync/opQueue.replica.test.ts` (add one test)
- Modify: `.beans/` (record findings on pkm-imw4)
- Test: the two files above

**Interfaces:**
- Consumes: `availabilityOf` from Task 1 (only for the new opQueue test's imports).
- Produces: nothing consumed by later tasks; the tests are the deliverable.

- [ ] **Step 1: Record the baseline**

Run: `cd web && pnpm verify`
Expected: PASS. Write the actual numbers (files, tests, coverage, e2e) into pkm-imw4's body
with `beans update pkm-imw4 --body-append`. If they differ from the handover's 122/1972/
97.7%/93.09%/51, the difference is itself a finding — record it and stop to investigate
before continuing.

- [ ] **Step 2: Write the failing pin — every handler replays the failed open**

The existing latch test covers `nextBatch` and `poisonedBatches`. The refactor's claim is
stronger ("every handler rejects with it"), so pin the full surface now, against today's
memoised-promise implementation. Add to `web/src/replica/workerHandlers.test.ts`:

```ts
test("one failed open is replayed by EVERY handler, and opens only once", async () => {
  // Characterisation for pkm-q2jj: today this holds because db() is
  // `dbPromise ??= openDb()` and nothing clears the rejection. Task 3 replaces
  // that implicit mechanism with an explicit latch; this test must not notice.
  let opens = 0;
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      throw new Error("OPFS is not available in this browser");
    },
  });

  const calls: Array<[string, unknown]> = [
    ["enqueue", [{ op: "delete", uid: "uid_b1" }]],
    ["nextBatch", undefined],
    ["deleteBatch", 1],
    ["markPoisoned", { id: 1, error: "e", batchId: "b" }],
    ["applySnapshot", SNAP],
    ["applyChanges", { feed: { changes: [], next_since: 0, latest_seq: 0 },
                       expectedPendingIds: [] }],
    ["pendingBatches", undefined],
    ["poisonedBatches", undefined],
    ["pendingCount", undefined],
    ["localApi", { method: "GET", path: "/api/page/AI", nowMs: 1 }],
    ["reset", undefined],
  ];
  for (const [method, payload] of calls) {
    await expect(handlers[method](payload), method).rejects.toThrow(/OPFS is not available/);
  }
  expect(opens).toBe(1);
});
```

Adapt the `applyChanges` feed literal to the real `Changes` shape (read `replica/apply.ts`)
and drop any handler whose payload cannot be constructed cheaply — but state in a comment
which you dropped and why, so the next reader knows the surface is partial. `prepareRecovery`
and `commitRecovery` are deliberately excluded: they take a lease token and are covered by
their own tests.

- [ ] **Step 3: Run it**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts`
Expected: PASS on today's code. If it FAILS, you have found a handler that swallows the open
failure — record it as a finding on pkm-imw4 and reconcile before Task 3.

- [ ] **Step 4: Write the pin for the one failure that must NOT be retained**

The retention rule is about to invert from allowlist to blocklist, so pin the single item
that must stay on the terminal side. Add to `web/src/sync/opQueue.replica.test.ts`,
following the shape of the retention test at line 263:

```ts
test("a replica that REJECTS the op desyncs and is not retained", async () => {
  // Characterisation for pkm-s7af: an unsupported title syntax is the replica
  // refusing the op on its merits (replica/queue.ts throws LocalOpError), and
  // the server would refuse it too — so retaining and retrying it can never
  // help. Task 4 inverts the retain rule from a message allowlist to
  // "retain everything except this"; this is the "except".
  const desyncs: unknown[] = [];
  const replica = fakeReplica();
  replica.enqueue = () => Promise.reject(
    new ReplicaError('unsupported ref title syntax: "a[[b]]"', { rejected: true }));
  const queue = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = queue.enqueue([{ op: "update_text", uid: "u1", text: "a[[b]]" }]);

  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  expect(desyncs).toHaveLength(1);
  // Not retained: nothing is left pending to deliver.
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
});
```

Note the `{ rejected: true }` flag is inert today (nothing reads it), so this test passes on
today's code for today's reason — the error is simply not on the whitelist. That is exactly
what makes it a characterisation test.

- [ ] **Step 5: Run it**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "REJECTS the op"`
Expected: PASS. Adapt helper names (`fakeReplica`, `createOpQueue` import) to the file's
existing conventions.

- [ ] **Step 6: Record the unpinnable behaviours as findings**

Append to pkm-imw4's body — these are behaviours nobody has verified, per the design's
instruction not to quietly preserve them:

```bash
beans update pkm-imw4 --body-append "## Findings: behaviour that cannot be pinned

1. **Nothing in web/src ever throws an error carrying \`quota: true\`.** grep shows
   the flag is set only by tests (opQueue.replica.test.ts, rpc.test.ts). So the
   quota -> onQuota -> quotaExhausted -> read-only chain is verifiable only
   synthetically: no real code path produces the input. The mechanism is left
   untouched by pkm-q2jj; whether OPFS/sqlite-wasm can be made to raise it (and
   what it raises instead) is unanswered.
2. **The \`probe === \"unknown\"\` branch has no test.** It is reachable only via
   an RpcLifecycleError from init() (dead worker, chunk 404 after a deploy, RPC
   timeout). pkm-q2jj deletes the branch rather than pinning it: it becomes
   \`unreachable\`, which retains ops and holds the barrier by construction.
3. **A pool-exhausted write on a successfully OPEN database** is retained today
   only because of the isPoolExhausted message match — it is not an availability
   failure at all. Pinned at opQueue.replica.test.ts:293; the reason it passes
   changes in Task 4 (from message match to \"not a rejection\")."
```

- [ ] **Step 7: Full verify and commit**

Run: `cd web && pnpm verify`
Expected: PASS, with 3 more tests than the baseline.

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-imw4 -s completed
git add web/src/replica/workerHandlers.test.ts web/src/sync/opQueue.replica.test.ts .beans
git commit -m "test(pkm-imw4): pin replica-availability behaviour before refactoring

The regression net for pkm-q2jj: every handler replays one failed open (the
stronger claim the explicit latch will make), and a replica that REJECTS an op
still desyncs rather than being retained (the one item that must stay on the
terminal side when the retain rule inverts from allowlist to blocklist).
Findings recorded for three behaviours that cannot be pinned against today's
code, including a quota flag no production code path ever sets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 3: Latch replica unavailability explicitly in the worker (pkm-za9j)

**Files:**
- Modify: `web/src/replica/workerHandlers.ts:61-63` (the `db()` closure), `169-198`
  (`init()`'s catch comment), `319-325` (`close()`)
- Test: `web/src/replica/workerHandlers.test.ts`

**Interfaces:**
- Consumes: `ReplicaUnavailableError` from `./errors` (Task 1).
- Produces: every handler in the map returned by `buildHandlers` rejects with one
  `ReplicaUnavailableError` instance — the same object identity for the whole session — once
  `openDb()` has failed once. `close()` clears the latch. `init()` still resolves
  `{ ok: false, … }` on that path; the contract flip is Task 5.

**Two invariants this must not break:**
1. **The latched error's `message` is the original open failure's message, verbatim.** Until
   Task 4 lands, `opQueue`'s message whitelist (`isSahPoolContention`) is still what retains
   those ops in the fallback lane. Changing the text here would silently regress pkm-c9hp
   for the length of one commit.
2. **Only `close()` re-arms.** `init()`'s catch must not clear `dbPromise` *or* the new
   latch. That was pkm-bjae's bug, introduced by pkm-bjae's own first fix.

- [ ] **Step 1: Write the failing test for the explicit latch**

Add to `web/src/replica/workerHandlers.test.ts`:

```ts
test("the latched unavailable error is one typed object, and close() is its only reset",
async () => {
  let opens = 0;
  let fail = true;
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      if (fail) throw new Error("OPFS is not available in this browser");
      return t.db;
    },
  });

  const first = await handlers.pendingCount(undefined).catch((e: unknown) => e);
  expect(first).toBeInstanceOf(ReplicaUnavailableError);
  // The original message is preserved deliberately: it is what the op queue's
  // storage-error whitelist still matches on until pkm-s7af lands, and it is
  // the only diagnostic a user-visible banner has.
  expect((first as Error).message).toBe("OPFS is not available in this browser");

  // Same object, not a fresh one per call: the fact is latched, not re-derived.
  const second = await handlers.nextBatch(undefined).catch((e: unknown) => e);
  expect(second).toBe(first);
  expect(opens).toBe(1);

  // Even a would-be-successful open is not attempted while the latch holds.
  fail = false;
  await expect(handlers.pendingCount(undefined)).rejects.toBe(first);
  expect(opens).toBe(1);

  // close() is the reset — and the only one.
  await expect(handlers.close(undefined)).resolves.toBeNull();
  await expect(handlers.pendingCount(undefined)).resolves.toBe(0);
  expect(opens).toBe(2);
});
```

Import `ReplicaUnavailableError` from `./errors`. `openRawTestDb` is already imported in
this file.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts -t "one typed object"`
Expected: FAIL — `expect(first).toBeInstanceOf(ReplicaUnavailableError)` fails; the raw
`Error` from `openDb` is what propagates today.

- [ ] **Step 3: Implement the latch**

In `web/src/replica/workerHandlers.ts`, add the import and replace lines 62-63:

```ts
import { ReplicaUnavailableError } from "./errors";
```

```ts
export function buildHandlers(deps: WorkerDeps): RpcHandlers {
  let dbPromise: Promise<ReplicaDb> | null = null;
  // The availability fact, owned here — the worker is the only party that can
  // say "there is definitively no database" rather than "I could not ask".
  //
  // This REPLACES pkm-bjae's latch, which worked by leaving the memoised
  // dbPromise rejection in place. That was correct but implicit: its safety
  // depended on a reader noticing that init() must not clear a promise three
  // modules from where the consequence lands (a barrier lift kicks a drain that
  // would have posted batches queued behind an undiscovered poison row). Two
  // independent reviewers read that mechanism identically and drew opposite
  // conclusions about whether it was a virtue or a defect. This says what it
  // means. close() is still the only reset.
  let unavailable: ReplicaUnavailableError | null = null;
  const db = async (): Promise<ReplicaDb> => {
    if (unavailable !== null) throw unavailable;
    dbPromise ??= deps.openDb();
    try {
      return await dbPromise;
    } catch (error: unknown) {
      // The original message is carried through verbatim: it is the only
      // diagnostic the banner has, and the op queue's storage-error whitelist
      // still matches on it until pkm-s7af replaces that with a type check.
      unavailable ??= new ReplicaUnavailableError(
        error instanceof Error ? error.message : String(error),
        { quota: (error as { quota?: boolean } | null)?.quota === true },
      );
      throw unavailable;
    }
  };
```

In `close()` (line 319), reset both:

```ts
    async close() {
      return gate.run(async () => {
        await deps.closeDb?.();
        // The only re-arm. A new open may now be attempted, and may succeed.
        dbPromise = null;
        unavailable = null;
        return null;
      });
    },
```

Shorten `init()`'s catch comment (lines 174-183) — the mechanism it describes has moved:

```ts
        try {
          d = await db();
        } catch {
          // wasm/OPFS unavailable: the app degrades to online-only. db() has
          // latched the failure for the session, so every later handler
          // replays it rather than silently succeeding on a fresh attempt.
          // Startup lifts the op queue's recovery barrier on the strength of
          // this ok:false, having never read the poison table (pkm-bjae).
          return { ok: false, empty: true, cursor: 0, schemaMismatch: false,
                   pendingBatches: [] };
        }
```

- [ ] **Step 4: Run the worker tests**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts`
Expected: PASS — the new test, Task 2's every-handler test, and the pkm-bjae latch test at
line 237 (its `rejects.toThrow(/Access Handle/)` still matches, because the message is
preserved).

- [ ] **Step 5: Full verify**

Run: `cd web && pnpm verify`
Expected: PASS. The unopenable-replica provider tests still pass **because the message is
preserved** — if any of them fail, do not adjust them: it means the message was changed
somewhere, which is the regression this step's invariant 1 exists to prevent.

- [ ] **Step 6: Commit**

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-za9j -s completed
git add web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts .beans
git commit -m "refactor(pkm-za9j): latch replica unavailability explicitly in the worker

buildHandlers now latches a ReplicaUnavailableError on the first openDb()
failure and every handler rejects with that one object; close() clears it.
This replaces pkm-bjae's implicit latch — a memoised promise rejection whose
safety depended on a reader noticing that init() must not clear it, three
modules from where the consequence landed. The original open error's message
is carried through verbatim, deliberately: the op queue's storage-error
whitelist still matches on it until pkm-s7af lands.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 4: Retain ops by type; stop asking a dead replica (pkm-s7af, closes pkm-9x6u)

**Files:**
- Modify: `web/src/sync/opQueue.ts` — imports (`9-11`), `createReplicaQueue`'s state
  (`165-188`), `countPending` (`257-264`), `runDrain`'s durable step (`372-377`),
  `enqueue`'s catch (`546-603`)
- Test: `web/src/sync/opQueue.replica.test.ts`, `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: `availabilityOf`, `isSessionFatal`, `ReplicaError`, `type ReplicaAvailability`
  from `../replica/errors` (Task 1); the worker latch (Task 3).
- Produces: no public API change to `OpQueue`. Behaviour changes: (a) `enqueue` retains on
  every replica failure except `error.rejected`; (b) once a session-fatal availability
  failure is seen, the durable-queue RPCs are skipped and `drain()` can return
  `{ status: "drained" }`.

**The retention rule, stated once:** the replica is a cache, not the durability boundary, so
a failed local persist is *never* evidence that the server refused the edit. `onDesync` —
whose repair rebases the active outline to server state and detaches the editor
mid-keystroke — is for server rejections, which arrive from `postOps`, not from
`replica.enqueue`. The single exception is the replica reporting that it refused the **op**
(`rejected`), because the server would refuse it too.

- [ ] **Step 1: Write the failing repro from pkm-9x6u**

Add to `web/src/sync/SyncProvider.test.tsx`, next to the existing unopenable-replica tests.
This is the bean's ready-made repro; keep both cases together, because the only difference
between them is the open error's *message*, which is what makes the diagnosis unambiguous:

```ts
function deadReplica(message: string): Replica {
  const replica = fakeReplicaForProvider();
  const dead = () => Promise.reject(new ReplicaUnavailableError(message));
  replica.init = dead;
  replica.poisonedBatches = dead;
  replica.pendingBatches = dead;
  replica.pendingCount = dead;
  replica.enqueue = dead;
  replica.nextBatch = dead;
  return replica;
}

async function runDead(message: string) {
  const posts: Array<{ ops: Array<Record<string, unknown>> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      posts.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") return jsonResponse(SNAPSHOT);
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));
  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={deadReplica(message)}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(sync.replicaMode).toBe("no-replica"); });
  await act(async () => {
    sync.enqueue([{ op: "update_text", uid: "u1", text: "typed while dead" }]);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return { posts, sync: () => sync };
}

test("an SAH-contention unopenable replica delivers the edit (pkm-9x6u)", async () => {
  const { posts } = await runDead(
    "Access Handles cannot be created if there is another open Access Handle");
  expect(posts).toHaveLength(1);
});

test("a NON-whitelisted unopenable replica delivers the edit too (pkm-9x6u)", async () => {
  // Before pkm-s7af this dropped the edit and fired onDesync, whose legacy
  // repair additionally rebased the active outline to server state: the
  // whitelist, not the availability state, decided whether writes survived.
  // Deliberately does NOT pin sync.problem — a delivery problem can legitimately
  // take precedence over the background replica-unavailable report.
  const { posts } = await runDead("OPFS is not available in this browser");
  expect(posts).toHaveLength(1);
});
```

Note the fixture change from the bean's sketch: `init` now **rejects** rather than resolving
`{ ok: false }`, because Task 3 made a real worker's `init()` reject on the latched error
for every handler… except `init()` itself, which still returns `ok:false` until Task 5.
**So for this task, keep `replica.init` resolving `{ ok: false, empty: true, cursor: 0,
schemaMismatch: false, pendingBatches: [] }`** (copy `unopenableReplica()` at line 1070) and
switch it to `dead` in Task 5. Getting this backwards makes the test fail for the wrong
reason.

- [ ] **Step 2: Write the failing test for the reconnect resync (pkm-9x6u symptom 1)**

```ts
test("a reconnect in a no-replica session still bumps resyncSeq (pkm-9x6u)", async () => {
  // Every drain used to end in failed() -> a ~5s backoff, forever, because the
  // loop fell through to replica.nextBatch() on a replica it already knew was
  // dead. drain() therefore never returned "drained", so finishReconnect never
  // ran and views were never told to refetch: changes made elsewhere while this
  // tab was disconnected stayed invisible until the user navigated.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/ops") return jsonResponse({ ok: true });
    if (url === "/api/sync/snapshot") return jsonResponse(SNAPSHOT);
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));
  const replica = unopenableReplica();
  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(sync.replicaMode).toBe("no-replica"); });
  const before = sync.resyncSeq;

  await act(async () => { lastWs().close(); await Promise.resolve(); });
  await act(async () => { lastWs().open(); await Promise.resolve(); });

  await vi.waitFor(() => { expect(sync.resyncSeq).toBeGreaterThan(before); });
});
```

Adapt `lastWs().close()` to whatever the file's socket fake exposes for a drop (grep for
`reconnecting` in `SyncProvider.test.tsx`).

- [ ] **Step 3: Write the failing unit tests for the new retention rule**

Add to `web/src/sync/opQueue.replica.test.ts`:

```ts
test("a terminal RPC failure retains the op instead of desyncing", async () => {
  // pkm-9x6u's second half: a dead worker or a module chunk 404 after a deploy
  // makes every call reject with RpcLifecycleError, which no availability
  // *mode* would ever see because markUnavailable is never reached.
  const desyncs: unknown[] = [];
  const replica = fakeReplica();
  replica.enqueue = () => Promise.reject(
    new RpcLifecycleError("worker-error", "replica worker failed"));
  replica.nextBatch = () => Promise.reject(
    new RpcLifecycleError("worker-error", "replica worker failed"));
  const queue = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = queue.enqueue([{ op: "delete", uid: "u1" }]);
  await ticket.settled;
  expect(desyncs).toEqual([]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("an RPC timeout retains the op but does not latch the replica off", async () => {
  // A timeout rejects one request and leaves the RPC client usable, so it must
  // not be mistaken for a dead replica: the next drain still asks.
  const replica = fakeReplica();
  let enqueues = 0;
  replica.enqueue = () => {
    enqueues += 1;
    return Promise.reject(new RpcLifecycleError("timeout", "replica RPC enqueue timed out"));
  };
  let nextBatchCalls = 0;
  replica.nextBatch = () => { nextBatchCalls += 1; return Promise.resolve(null); };
  const queue = createOpQueue(replica, () => undefined);
  await queue.enqueue([{ op: "delete", uid: "u1" }]).delivered;
  await queue.drain();
  expect(enqueues).toBe(1);
  expect(nextBatchCalls).toBeGreaterThan(0);
});

test("a dead replica is asked once, then never again", async () => {
  const replica = fakeReplica();
  let nextBatchCalls = 0;
  replica.nextBatch = () => {
    nextBatchCalls += 1;
    return Promise.reject(new ReplicaUnavailableError("no openable database"));
  };
  const queue = createOpQueue(replica, () => undefined);
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
  expect(nextBatchCalls).toBe(1);
});
```

Then **update the comment** on the two existing retention tests at `:263` and `:293` so the
next reader knows the reason they pass has changed — from "this message is on the whitelist"
to "the replica did not report this as a rejection of the op". Do not change their
assertions.

- [ ] **Step 4: Run them and watch them fail**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx`
Expected: FAIL on the five new tests. Specifically: the non-whitelisted delivery test shows
`posts` empty; the resync test times out in `waitFor`; the terminal-RPC test shows one
`onDesync`; the dead-replica test shows a `blocked` outcome and repeated `nextBatch` calls.

- [ ] **Step 5: Rewire the imports and add the derived latch**

In `web/src/sync/opQueue.ts`, replace lines 9-11:

```ts
import { availabilityOf, isSessionFatal, ReplicaError,
         type ReplicaAvailability } from "../replica/errors";
```

(Both `isSahPoolContention` and `isPoolExhausted` imports go away — Task 8 sweeps whatever
that leaves dead.)

Inside `createReplicaQueue`, after `let durableSinceFallback = 0;` (line 187):

```ts
  // The availability fact, DERIVED from this queue's own failed RPCs and
  // latched only on evidence that is itself permanent (the worker's latched
  // open, or a terminally failed RPC client — never a timeout). The queue does
  // not need telling by anyone: the single owner is the worker, and this is a
  // local cache of what it said. Nothing here lifts the recovery barrier —
  // that decision needs the stronger `unusable` evidence and belongs to
  // startup (pkm-bjae).
  let unavailable: ReplicaAvailability | null = null;
  const noteReplicaFailure = (error: unknown): void => {
    if (unavailable === null && isSessionFatal(error)) {
      unavailable = availabilityOf(error);
    }
  };
```

- [ ] **Step 6: Skip the RPC in `countPending`**

Replace `countPending` (lines 257-264):

```ts
  const countPending = async (): Promise<number> => {
    // Nothing to ask, and asking is what pkm-9x6u is about.
    if (unavailable !== null) return pendingCount;
    try {
      pendingCount = await replica.pendingCount();
    } catch (error: unknown) {
      // The last observed count is still the best terminal diagnostic.
      noteReplicaFailure(error);
    }
    return pendingCount;
  };
```

- [ ] **Step 7: Let the drain finish without a reachable durable queue**

In `runDrain`, before the `for (;;)` loop, add the shared tail:

```ts
    /** The durable queue is unreachable, so nothing durable can be delivered
     * and nothing durable can still stand ahead of a retained entry. Returns
     * the outcome to report, or null to keep looping (there is lane work, or a
     * kick landed mid-drain).
     *
     * pendingCount is deliberately NOT zeroed: durable rows persisted before
     * the replica died are genuinely undelivered and belong in the pending
     * diagnostic. Outstanding delivery promises are deliberately left
     * unsettled, exactly as they are today — dispose() is what settles them —
     * because resolving them "delivered" would be a lie and resolving them
     * "failed" would change what the outline session's replay does. */
    const laneOnly = (): DrainOutcome | null => {
      for (const entry of fallback) entry.durableAhead = 0;
      durableSinceFallback = 0;
      if (fallback.length > 0) return null;
      if (drainAgain) return null;
      return { status: "drained" };
    };
```

Then replace the durable-batch fetch (lines 372-377):

```ts
      if (unavailable !== null) {
        const outcome = laneOnly();
        if (outcome !== null) return outcome;
        continue;
      }
      let batch;
      try {
        batch = await replica.nextBatch();
      } catch (error: unknown) {
        noteReplicaFailure(error);
        if (unavailable === null) return failed(error);
        const outcome = laneOnly();
        if (outcome !== null) return outcome;
        continue;
      }
```

Also add `noteReplicaFailure(error)` to the `replica.deleteBatch` catch (line 434) before
`return failed(error)`, and to `markRetainedPoison`'s catch (line 318) before the rethrow —
same fact, learned from a different call. **`markRetainedPoison` must otherwise be left
alone**: an unmarkable intent still holds the gate (that is pkm-tu5k, out of scope).

- [ ] **Step 8: Invert the retention rule in `enqueue`**

Replace `enqueue`'s catch body (lines 546-603) — the whole `if (quotaExhausted ||
isSahPoolContention(error) || isPoolExhausted(error))` condition becomes:

```ts
        } catch (error: unknown) {
          resolve({ status: "failed", error });
          const replicaError = error instanceof ReplicaError ? error : null;
          // The replica refused the OP, not the storing of it (unsupported
          // title syntax): the server would refuse it too, so retaining and
          // retrying can never help. The ONE case that still desyncs.
          if (replicaError?.rejected === true) {
            resolveDelivery({ status: "failed", error });
            try { onDesync(error); } catch { /* listener isolation */ }
            return;
          }
          // Everything else means "could not persist locally right now", which
          // is NEVER a server rejection: the replica is a cache, not the
          // durability boundary. Firing onDesync would be the wrong answer,
          // because its authoritative repair would wipe the active outline to
          // the (edit-less) server state and detach the editor mid-keystroke.
          // So the ops are retained for ordered delivery by drain().
          //
          // This used to be an allowlist of three error shapes, two of them
          // matched by MESSAGE (quota / OPFS access-handle contention, pkm-c9hp
          // / exhausted SAH pool, pkm-ndcu). Whether the user's writes survived
          // therefore depended on string matching, and any unlisted shape — a
          // wasm init failure, OPFS unavailable in private browsing, a dead
          // worker's RpcLifecycleError — lost the edit AND rebased the outline
          // (pkm-9x6u). A one-item blocklist is the honest rule.
          noteReplicaFailure(error);
          if (replicaError?.quota === true) quota.emit(error);
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
            return;
          }
          // ... the rest of the retain block is UNCHANGED from here:
          // durableAhead computation, the second disposed re-check,
          // fallback.push, durableSinceFallback = 0, emitPending(), kick().
        }
```

Keep the existing `durableAhead` comment block verbatim — its reasoning about stale counts
is still exactly right.

- [ ] **Step 9: Run the tests**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx`
Expected: PASS, including the two retention tests at `:263`/`:293` (now for the new reason)
and Task 2's `rejected` characterisation test.

- [ ] **Step 10: Full verify**

Run: `cd web && pnpm verify`
Expected: PASS.

- [ ] **Step 11: Commit and close pkm-9x6u**

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-s7af -s completed
beans update pkm-9x6u -s completed --body-append "## Summary of Changes

Closed by pkm-s7af. opQueue retains on every replica failure EXCEPT one the
replica reports as a rejection of the op itself (LocalOpError -> the \`rejected\`
wire flag), which deletes the isSahPoolContention/isPoolExhausted message
matching from that path. Both halves are covered: the no-replica case and the
RpcLifecycleError case an availability *mode* alone would have missed.

The queue also latches its own derived view of availability from its own failed
RPCs (session-fatal evidence only — never a timeout) and stops calling a dead
replica: drain() now reports \"drained\" instead of arming a ~5s backoff forever,
so finishReconnect runs and a reconnect bumps resyncSeq again. The forever-
failing drain was safe, as this bean warned; the fix is to stop asking, not to
make the asking work. The latched open was NOT re-armed."
git add web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts \
        web/src/sync/SyncProvider.test.tsx .beans
git commit -m "fix(pkm-s7af,pkm-9x6u): retain ops by type, and stop asking a dead replica

Retention was an allowlist of three error shapes, two matched by MESSAGE, so
whether the user's writes survived depended on string matching: an unopenable
replica whose cause was not on the list lost the edit and additionally rebased
the active outline to server state. It is now a one-item blocklist — retain
every replica failure except one the replica reports as a rejection of the op
itself, because the server would refuse that too.

The queue also latches its own derived availability (session-fatal evidence
only, never a timeout) and skips the durable-queue RPCs once set, so a drain in
a no-replica session reports \"drained\" instead of arming a backoff forever.
That restores the reconnect resync bump.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 5: `init()` rejects instead of reporting `ok`; both consumers derive (pkm-61zt, part 1)

Representation #1 of the design's table. Once every handler rejects with the latch, an
`init()` that *resolves* always has `ok: true` — a field that can only ever hold one value
is not a representation worth keeping.

**Files:**
- Modify: `web/src/replica/workerHandlers.ts:169-198` (`init()` loses its try/catch)
- Modify: `web/src/replica/client.ts:30-41` (`ReplicaInit` loses `ok`)
- Modify: `web/src/sync/replicaSync.ts:319-337` (`doStart` derives from the typed rejection)
- Modify: `web/src/sync/SyncProvider.tsx:306-359` (`continueStartupRef` — the probe and the
  `"unknown"` branch go away)
- Modify: every test fixture whose fake `init` returns `ok` — typecheck will list them.
  Known: `sync/SyncProvider.test.tsx` (incl. `unopenableReplica`, `deadReplica`),
  `sync/replicaSync.test.ts`, `replica/workerHandlers.test.ts`, `sync/connectionAware.test.tsx`,
  `web/src/test-helpers.ts` if it builds a replica.
- Test: all of the above

**Interfaces:**
- Consumes: `availabilityOf` (Task 1), the worker latch (Task 3).
- Produces: `interface ReplicaInit { empty: boolean; cursor: number;
  schemaMismatch: boolean; pendingBatches: PendingBatch[] }` — **no `ok`**. `Replica.init()`
  rejects with `ReplicaUnavailableError` when the database cannot be opened.
  `replicaSync.markUnavailable()` still exists at the end of this task (deleted in Task 6).

- [ ] **Step 1: Write the failing worker test**

Add to `web/src/replica/workerHandlers.test.ts`:

```ts
test("init rejects with the latched error instead of reporting ok:false", async () => {
  // ok:false was the FIRST of five representations of one fact (pkm-q2jj): a
  // value that says what the latched rejection already says, kept in sync by
  // convention. With the worker owning the fact, init() is just another
  // handler.
  const handlers = buildHandlers({
    openDb: async () => { throw new Error("OPFS is not available in this browser"); },
  });
  const err = await handlers.init(undefined).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaUnavailableError);
  expect(availabilityOf(err)).toBe("unusable");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts -t "init rejects"`
Expected: FAIL — `init()` resolves `{ ok: false, … }`.

- [ ] **Step 3: Delete `init()`'s catch and the `ok` field**

In `web/src/replica/workerHandlers.ts`, `init()` becomes:

```ts
    async init() {
      return gate.run(async () => {
        // No catch: an unopenable database is db()'s latched
        // ReplicaUnavailableError, exactly as it is for every other handler.
        // Consumers derive "no-replica" from that rejection (pkm-61zt).
        const d = await db();
        const fresh = !tableExists(d, "sync_client_meta");
        const pendingBatches = fresh ? [] : readPendingBatches(d);
        if (fresh) installSchema(d);
        return {
          empty: getMeta(d, "generation") === null,
          cursor: Number(getMeta(d, "cursor") ?? 0),
          schemaMismatch: getMeta(d, "schema_version") !== SCHEMA_VERSION,
          pendingBatches,
        };
      });
    },
```

Note the `let d: ReplicaDb;` declaration above the old try/catch also goes.

In `web/src/replica/client.ts`, `ReplicaInit` loses `ok` and its comment:

```ts
export interface ReplicaInit {
  /** true => never bootstrapped; fetch a snapshot before serving reads */
  empty: boolean;
  cursor: number;
  /** stored schema_version differs from this build's: recovery required
   * (flush pendingBatches first — spec section 6) */
  schemaMismatch: boolean;
  /** read BEFORE any teardown, per the epic guardrail */
  pendingBatches: PendingBatch[];
}
```

And update `Replica.init`'s doc line if it mentions `ok`:

```ts
  /** Rejects with ReplicaUnavailableError when the database cannot be opened;
   * the worker has latched that for the session (pkm-za9j). */
  init(): Promise<ReplicaInit>;
```

- [ ] **Step 4: Derive `no-replica` in `replicaSync.doStart`**

In `web/src/sync/replicaSync.ts`, replace `doStart` (lines 319-337):

```ts
  const doStart = async (): Promise<void> => {
    let init: ReplicaInit;
    try {
      init = await replica.init();
    } catch (error: unknown) {
      // "unusable" is the worker reporting its own latched failed open: this
      // session is online-only, and no later start() can revive it, because the
      // latch replays for every call until close(). That is what replaces the
      // `disabled` boolean this function used to set — the session-commitment
      // moment moves to where the commitment actually happens (pkm-61zt).
      //
      // Anything else, INCLUDING "unreachable", stays an ordinary start
      // failure: "we could not ask" is not evidence there is no database, and
      // isStallShaped already excludes it from the stall count.
      if (availabilityOf(error) === "unusable") {
        disabled = true;
        onState({ mode: "no-replica" });
        return;
      }
      throw error;
    }
    cursor = init.cursor;
    if (init.schemaMismatch) {
      // deploy changed the DDL: one coordinator flushes and rebuilds under
      // the same worker lease used for feed generation/reset recovery.
      if (!(await recover("reset")).ok) return;
    } else if (init.empty) {
      await bootstrap();
    }
    started = true;
    onState({ mode: "ready" });
    await pull();
  };
```

Add `import type { PendingBatch, RecoveryCommit, Replica, ReplicaInit } from "../replica/client";`
to the existing type import on line 12. `disabled` is still set here; Task 6 removes it.

- [ ] **Step 5: Delete the viability probe in `SyncProvider`**

In `web/src/sync/SyncProvider.tsx`, replace the `catch` block of `continueStartupRef.current`
(lines 310-348):

```ts
    } catch (error: unknown) {
      if (marked.length === 0) {
        // Discovery reaching the database and failing may simply mean there is
        // no openable database at all — and the worker is the one party that
        // can tell the difference, so it says so in the error's type. Only its
        // own latched open failure ("unusable") is evidence that there is no
        // poison table for this gate to protect; with no replica there are no
        // poison rows, and holding the barrier would strand every accepted edit
        // in the in-memory fallback lane until the tab closes (pkm-bjae).
        //
        // Anything else — a dead worker, a module chunk 404 after a deploy
        // against a stale index.html, an RPC timeout — is "we could not ask",
        // not "there is nothing to read", so it keeps today's gate and its
        // Retry banner rather than delivering past unread poison. There used to
        // be an init() probe here whose third outcome ("unknown") retained the
        // gate while setting no availability state at all, so nothing
        // downstream knew (pkm-q2jj).
        const message = error instanceof Error ? error.message : String(error);
        if (availabilityOf(error) === "unusable") {
          startupDiscoveringPoisonRef.current = false;
          replicaSync!.markUnavailable();
          queue.resume("recovery");
          // Not silent: the user has lost offline editing for the session and
          // gets no other signal, since "no-replica" raises no banner of its
          // own (pkm-bjae review).
          applySync({ type: "replica-unavailable", error: message });
          return;
        }
        applySync({ type: "poison-discovery-failed", error: message });
        return;
      }
      // Returned mark evidence is sufficient to repair those rows safely;
      // never discard it merely because the broader discovery read failed.
    }
```

Add `availabilityOf` to the imports:
`import { availabilityOf } from "../replica/errors";`

- [ ] **Step 6: Typecheck and fix every fixture**

Run: `cd web && pnpm typecheck`
Expected: errors at every fake `init` that returns `ok`. Fix each by deleting the property.
For the unopenable/dead fixtures, `init` must now **reject**:

```ts
function unopenableReplica(): Replica & { initCalls: () => number } {
  const replica = fakeReplicaForProvider();
  let initCalls = 0;
  // A real worker latches its failed open, so every call — init() included —
  // replays one ReplicaUnavailableError. The fixture has to do the same or it
  // is testing a replica that cannot exist (pkm-za9j).
  const unavailable = new ReplicaUnavailableError(
    "Access Handles cannot be created if there is another open Access Handle");
  const dead = () => Promise.reject(unavailable);
  replica.init = () => { initCalls += 1; return dead(); };
  replica.poisonedBatches = dead;
  replica.pendingBatches = dead;
  replica.pendingCount = dead;
  replica.enqueue = dead;
  replica.nextBatch = dead;
  return Object.assign(replica, { initCalls: () => initCalls });
}
```

Repeat for Task 4's `deadReplica(message)` — set `replica.init` to reject with
`new ReplicaUnavailableError(message)`.

- [ ] **Step 7: Rewrite the two fixtures that model an impossible replica**

Two existing tests inject a replica whose `init` **succeeds on a later call**:
`SyncProvider.test.tsx:1119` ("a replica that becomes openable later must not start
syncing") and `replicaSync.test.ts:121` ("markUnavailable is permanent even if a later init
would succeed"). A real worker cannot do that any more — the latch replays. Rewrite both
fixtures to latch, and update the comment to say what now guarantees the property:

```ts
test("a replica that cannot be opened never starts syncing", async () => {
  // Why this is safe without markUnavailable's `disabled` flag: the worker
  // latches its failed open until close(), so start() -> init() rejects for the
  // whole session and can never resume delivery with poison discovery SKIPPED —
  // the exact ordering hazard the recovery barrier exists to prevent, which
  // pkm-bjae's own first fix had reintroduced. The commitment lives where the
  // commitment happens.
  //
  // A fixture whose init() succeeds on a second call would be testing a replica
  // that cannot exist; the property it used to guard (the provider must not
  // call start() again) is now guarded by the latch itself.
  // ... assertions unchanged: `feeds` stays empty, replicaMode is "no-replica".
});
```

Keep the assertions. If either test's assertion can only pass because of the
non-latching fixture, that is a finding — record it on pkm-61zt rather than weakening the
test.

- [ ] **Step 8: Run everything**

Run: `cd web && pnpm verify`
Expected: PASS. Coverage should not drop — `init()`'s deleted catch branch removes an
uncovered-ish branch rather than adding one.

- [ ] **Step 9: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts \
        web/src/replica/client.ts web/src/sync/replicaSync.ts \
        web/src/sync/replicaSync.test.ts web/src/sync/SyncProvider.tsx \
        web/src/sync/SyncProvider.test.tsx web/src/sync/connectionAware.test.tsx \
        web/src/test-helpers.ts .beans
git commit -m "refactor(pkm-61zt): init rejects with the latched error; delete ReplicaInit.ok

ok:false was the first of five representations of one fact, and once every
handler rejects with the worker's latch it can only ever hold one value.
init() is now just another handler, and both consumers derive: replicaSync
turns an \`unusable\` rejection into mode no-replica, and SyncProvider's startup
asks the error's type instead of running an init() viability probe whose third
outcome (\"unknown\") retained the gate while setting no availability state at
all, so nothing downstream knew.

Fixtures that modelled a replica becoming openable later now latch, because a
real worker cannot do otherwise; the property they guarded is guaranteed by
the latch rather than by the provider's restraint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 6: Delete `markUnavailable()` and the `disabled` boolean (pkm-61zt, part 2)

Representations #3 and #4 collapse into one derived value. Nothing is lost: the
session-commitment moment moved to the worker latch in Task 3, and Task 5 proved the
derivation.

**Files:**
- Modify: `web/src/sync/replicaSync.ts` — the `markUnavailable` doc + interface member
  (`31-37`, `341-344`), `disabled` (`111`, `321-323`, `346`, `396-400`)
- Modify: `web/src/sync/SyncProvider.tsx` — the `markUnavailable()` call site
- Test: `web/src/sync/replicaSync.test.ts`, `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3 and 5.
- Produces: `ReplicaSync` **without** `markUnavailable`. `SyncProvider` sets
  `setReplicaState({ mode: "no-replica" })` directly on the startup-discovery path — the
  same call it already makes for a null replica at line 363.

- [ ] **Step 1: Write the failing test for the derived guard**

Add to `web/src/sync/replicaSync.test.ts`, replacing the body of the rewritten
`markUnavailable`-permanence test from Task 5:

```ts
test("a session whose replica cannot open never pulls, however often start() is called",
async () => {
  // What `disabled` used to buy: start() short-circuiting for the rest of the
  // session. What buys it now: init() replaying the worker's latched failure,
  // which is the same fact at its source instead of a copy kept in sync by
  // convention.
  const feeds: string[] = [];
  const replica = fakeReplica();
  replica.init = () => Promise.reject(new ReplicaUnavailableError("no openable database"));
  const states: ReplicaState[] = [];
  const sync = createReplicaSync({
    replica,
    fetchJson: async (path: string) => {
      if (path.startsWith("/api/sync/changes")) feeds.push(path);
      return EMPTY_FEED;
    },
    clientId: "c1",
    onState: (s) => states.push(s),
  });
  await sync.start();
  await sync.start();
  await sync.start();
  expect(feeds).toEqual([]);
  expect(states.map((s) => s.mode)).toEqual(["no-replica", "no-replica", "no-replica"]);
});

test("resetLocalData cannot revive a session whose replica cannot open", async () => {
  // The explicit `disabled` guard is gone; prepareRecovery rejects on the latch
  // before resetLocalData can set `started` or force mode "ready".
  const replica = fakeReplica();
  const unavailable = new ReplicaUnavailableError("no openable database");
  replica.init = () => Promise.reject(unavailable);
  replica.prepareRecovery = () => Promise.reject(unavailable);
  const sync = createReplicaSync({
    replica, fetchJson: okFetch, clientId: "c1", onState: () => undefined,
  });
  await sync.start();
  await expect(sync.resetLocalData({ discardPending: true })).rejects.toBe(unavailable);
});
```

Note the third `start()` re-emits `no-replica`: `started` stays false, so `starting` is
re-created and `init()` is asked again. That is the derivation working, not a bug — the
assertion states it so nobody "optimises" it into a cached boolean.

- [ ] **Step 2: Run and watch fail**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts -t "however often"`
Expected: FAIL — with `disabled` still in place, `start()` returns early and only one
`no-replica` state is emitted.

- [ ] **Step 3: Delete `disabled` and `markUnavailable`**

In `web/src/sync/replicaSync.ts`:
- Delete `markUnavailable(): void;` and its doc comment from the `ReplicaSync` interface
  (lines 31-37).
- Delete `let disabled = false; // no-replica: permanent for this session` (line 111).
- In `doStart`'s catch, delete `disabled = true;` (keep `onState({ mode: "no-replica" })`).
- Delete `if (disabled) return;` from `start()` (line 346).
- Delete the `markUnavailable()` implementation (lines 341-344).
- Replace the `disabled` guard in `resetLocalData` (lines 396-400) with a comment where the
  protection now comes from:

```ts
      // A session committed to online-only must stay that way: this method sets
      // started and forces mode "ready", which would revive syncing with poison
      // discovery skipped. Nothing needs to check a flag for that — every
      // database call below replays the worker's latched open failure, and
      // prepareRecovery is the first of them, so this throws long before
      // `started = true` is reached. No UI path reaches this today anyway (the
      // reset control needs a stalled/recovery-failed mode, and neither can
      // arise once the replica is unavailable) — pkm-bjae, pkm-61zt.
```

- [ ] **Step 4: Update the `SyncProvider` call site**

In `web/src/sync/SyncProvider.tsx`, in the `unusable` branch added in Task 5:

```ts
        if (availabilityOf(error) === "unusable") {
          startupDiscoveringPoisonRef.current = false;
          // Report the mode directly, exactly as the null-replica path does
          // below. There is nothing to "mark": the worker has latched the fact,
          // and every later replica call — including the start() a reconnect
          // triggers — replays it.
          if (mountedRef.current) setReplicaState({ mode: "no-replica" });
          queue.resume("recovery");
          applySync({ type: "replica-unavailable", error: message });
          return;
        }
```

- [ ] **Step 5: Verify no reference survives**

Run: `cd web && grep -rn 'markUnavailable\|disabled' src/sync/ src/replica/`
Expected: no `markUnavailable` anywhere; `disabled` only in unrelated contexts (e.g. a DOM
`disabled` attribute). Fix any straggler, including comments in
`docs/architecture/sync-and-offline.md` — those are Task 8's job, so just note them.

- [ ] **Step 6: Full verify and commit**

Run: `cd web && pnpm verify`
Expected: PASS.

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-61zt -s completed
git add web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts \
        web/src/sync/SyncProvider.tsx web/src/sync/SyncProvider.test.tsx .beans
git commit -m "refactor(pkm-61zt): delete markUnavailable() and replicaSync's disabled flag

Representations 3 and 4 of the availability fact. Both existed to make a
session's online-only commitment stick; the worker latch does that at the
source, so start() cannot revive a session even when nothing holds a flag —
init() replays the latched failure for the whole session. resetLocalData's
guard goes the same way: prepareRecovery rejects before `started` can be set.
SyncProvider reports mode no-replica directly, exactly as it already does for a
null replica.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 7: Stamp `base_text_hash` on the main thread (pkm-4ubd)

**Files:**
- Create: `web/src/outline/baseTextHash.ts`
- Create: `web/src/outline/baseTextHash.test.ts`
- Modify: `web/src/outline/useOutline.ts:170-201` (`run`)
- Modify: `web/src/outline/undoManager.ts:92-108` (`dispatch`)
- Test: `web/src/outline/baseTextHash.test.ts`, `web/src/sync/SyncProvider.test.tsx`,
  `web/src/outline/useOutline.test.tsx` (or whichever file covers `run`),
  `web/src/outline/undoManager.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `../replica/sha256`; `applyOps`, `findNode` from `./tree`;
  `BlockNode` from `../api/payloads`.
- Produces: `stampBaseTextHashes(blocks: BlockNode[], pageTitle: string,
  ops: readonly BlockOp[]): BlockOp[]`.

**Two traps:**
1. **History must record UNSTAMPED ops.** `recordHistory` stores the batch for undo/redo
   replay. A hash captured at record time is stale by replay time and would fork a spurious
   `[[conflict]]` sibling. `undoManager.dispatch` stamps freshly against the tree as it is
   at replay time. So `invertOps(pre, pageTitle, ops)` and `recordHistory({ ops: [...ops] })`
   keep the unstamped array.
2. **The hash must be of the text the op replaces, walking the batch in order** — the same
   thing the worker does inside its transaction ("capture BEFORE this op's own optimistic
   apply"). A user's own edit chain must still flush cleanly: op N leaves the text that op
   N+1's hash matches.

- [ ] **Step 1: Write the failing unit tests**

Create `web/src/outline/baseTextHash.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { stampBaseTextHashes } from "./baseTextHash";
import type { BlockNode } from "../api/payloads";

const node = (uid: string, text: string): BlockNode => ({
  uid, text, heading: null, view_type: null, collapsed: false, children: [],
} as unknown as BlockNode);

describe("stampBaseTextHashes", () => {
  test("stamps the hash of the text the op replaces", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "u1", text: "after" }];
    const [stamped] = stampBaseTextHashes([node("u1", "before")], "AI", ops);
    expect(stamped).toEqual({
      op: "update_text", uid: "u1", text: "after",
      base_text_hash: sha256Hex("before"),
    });
  });

  test("does not mutate the input ops", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "u1", text: "after" }];
    stampBaseTextHashes([node("u1", "before")], "AI", ops);
    expect(ops[0]).not.toHaveProperty("base_text_hash");
  });

  test("an edit chain hashes each op against the previous op's result", () => {
    // The property that makes a user's own chain flush cleanly instead of
    // conflicting with itself.
    const ops: BlockOp[] = [
      { op: "update_text", uid: "u1", text: "one" },
      { op: "update_text", uid: "u1", text: "two" },
    ];
    const stamped = stampBaseTextHashes([node("u1", "zero")], "AI", ops);
    expect(stamped[0]).toMatchObject({ base_text_hash: sha256Hex("zero") });
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("one") });
  });

  test("an explicitly supplied hash is preserved", () => {
    const ops: BlockOp[] = [
      { op: "update_text", uid: "u1", text: "after", base_text_hash: "deadbeef" },
    ];
    expect(stampBaseTextHashes([node("u1", "before")], "AI", ops)[0])
      .toMatchObject({ base_text_hash: "deadbeef" });
  });

  test("a block unknown in this tree gets no hash (plain LWW, as the worker does)", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "elsewhere", text: "after" }];
    expect(stampBaseTextHashes([node("u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("base_text_hash");
  });

  test("non-update_text ops pass through untouched and in order", () => {
    const ops: BlockOp[] = [
      { op: "delete", uid: "u2" },
      { op: "update_text", uid: "u1", text: "after" },
      { op: "set_collapsed", uid: "u1", collapsed: true },
    ];
    const stamped = stampBaseTextHashes([node("u1", "before"), node("u2", "x")], "AI", ops);
    expect(stamped[0]).toBe(ops[0]);
    expect(stamped[2]).toBe(ops[2]);
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("before") });
  });

  test("an empty batch is returned as an empty batch", () => {
    expect(stampBaseTextHashes([node("u1", "a")], "AI", [])).toEqual([]);
  });
});
```

Build `node()` against the real `BlockNode` shape (read `web/src/api/payloads.ts` and an
existing tree test's fixture helper — reuse it if one exists rather than writing a cast).

- [ ] **Step 2: Run and watch fail**

Run: `cd web && pnpm vitest run src/outline/baseTextHash.test.ts`
Expected: FAIL — `Failed to resolve import "./baseTextHash"`.

- [ ] **Step 3: Write the module**

Create `web/src/outline/baseTextHash.ts`:

```ts
// pattern: Functional Core
// Stamp update_text ops with the hash of the text they replace, at op
// construction time on the main thread.
//
// The worker fills base_text_hash in from the replica (replica/queue.ts) only
// when it is undefined, so any op that never reaches the database goes to the
// server unguarded — which is EVERY op in a session whose replica could not be
// opened, because those ride the in-memory fallback lane and post head.ops
// verbatim. The server then returns early into plain last-write-wins
// (ops_core.py, "check 3: legacy"), so a concurrent edit from the tab that DOES
// own the replica is overwritten outright instead of being preserved as a
// [[conflict]] sibling; and the edit-vs-delete path, also gated on the hash,
// raises "block not found" -> 400, which makes the lane discard the entry
// (pkm-4ubd). "Two tabs open is normal" is the load-bearing argument for
// pkm-bjae's online-only fallback, and this was that decision's cost.
//
// The hash is taken against the tree the batch was planned from, walking the
// batch in order, mirroring what the worker does inside its transaction:
// capture BEFORE this op's own optimistic apply. That is what lets a user's own
// edit chain flush cleanly — op N leaves the text op N+1's hash matches.
//
// Ownership is unchanged: the worker still defers to a supplied hash, so this
// is additive.
import type { BlockNode } from "../api/payloads";
import type { BlockOp, UpdateTextOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { applyOps, findNode } from "./tree";

const needsHash = (op: BlockOp): boolean =>
  op.op === "update_text" && op.base_text_hash === undefined;

export function stampBaseTextHashes(
  blocks: BlockNode[], pageTitle: string, ops: readonly BlockOp[],
): BlockOp[] {
  // applyOps clones the whole tree, so only re-apply while a later op still
  // needs a hash. A large paste batch on a big page would otherwise pay for a
  // clone per op for no benefit.
  const lastNeedingHash = ops.reduce(
    (last, op, index) => (needsHash(op) ? index : last), -1);
  if (lastNeedingHash === -1) return [...ops];
  let tree = blocks;
  const stamped: BlockOp[] = [];
  for (const [index, op] of ops.entries()) {
    let wireOp: BlockOp = op;
    if (needsHash(op)) {
      const node = findNode(tree, op.uid);
      // No node: this tree does not know the block (a cross-page op, or one
      // the batch itself creates). No hash means plain LWW — exactly what the
      // worker does when currentText returns null.
      if (node !== null) {
        wireOp = { ...op, base_text_hash: sha256Hex(node.text) } as UpdateTextOp;
      }
    }
    stamped.push(wireOp);
    if (index < lastNeedingHash) tree = applyOps(tree, [wireOp], pageTitle);
  }
  return stamped;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd web && pnpm vitest run src/outline/baseTextHash.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing provider repro from pkm-4ubd**

Add to `web/src/sync/SyncProvider.test.tsx`. This is the bean's recorded repro with its
assertion changed to the pin:

```ts
test("an online-only session's update_text still carries a base_text_hash (pkm-4ubd)",
async () => {
  const bodies: Array<{ ops: Array<Record<string, unknown>> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") return jsonResponse(SNAPSHOT);
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));
  const replica = unopenableReplica();
  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(sync.replicaMode).toBe("no-replica"); });
  await act(async () => {
    sync.enqueue([{ op: "update_text", uid: "block-1", text: "edited online-only",
                    base_text_hash: sha256Hex("hello") }]);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(bodies[0].ops[0]).toHaveProperty("base_text_hash");
});
```

**Note what this can and cannot prove.** `SyncProvider.enqueue` takes whatever ops it is
given: the provider is not where stamping happens, and it must not be — there is no tree
there. So this test pins the *lane*: an op that carries a hash keeps it all the way to the
POST body (the lane posts `head.ops` verbatim, so a lane that stripped or reordered fields
would fail here). The stamping itself is pinned by `baseTextHash.test.ts` and by the
`useOutline`/`undoManager` tests below. Say so in a comment on the test, or a future reader
will believe the provider does the stamping.

- [ ] **Step 6: Stamp in `useOutline.run`**

In `web/src/outline/useOutline.ts`, add the import and change `run` (lines 177-196):

```ts
import { stampBaseTextHashes } from "./baseTextHash";
```

```ts
    const ops = [...textOps, ...result.ops];
    if (ops.length === 0) return;
    const next = result.ops.length > 0 ? result.blocks : base;
    // Conflict protection must not depend on the ops reaching the database
    // (pkm-4ubd): base_text_hash is stamped here, against `pre` — the
    // pre-flush tree the whole batch grew from — because an online-only
    // session's ops never reach replica/queue.ts, which is where the worker
    // would otherwise fill it in.
    const wireOps = stampBaseTextHashes(pre, pageTitle, ops);
    const write = sync.enqueue(wireOps, ["page", pageTitle]);
    const handle = sessionRef.current;
    if (handle) handle.applyLocal(write, wireOps);
    else {
      blocksRef.current = next;
      setBlocks(next);
    }
    // Undo history (pkm-7q14): record the batch with its inverse, computed
    // against the pre-flush tree the full batch (textOps + result.ops) grew
    // from. Empty inverse = nothing undoable (collapse-only / create_page);
    // null = not invertible from this tree (cross-page move) — skip, history
    // stays best-effort.
    //
    // Deliberately the UNSTAMPED ops: a hash captured now is stale by the time
    // undo/redo replays the entry, and a stale hash forks a spurious
    // [[conflict]] sibling. undoManager stamps at replay time instead.
    const inverse = invertOps(pre, pageTitle, ops);
    if (inverse !== null && inverse.length > 0) {
      recordHistory({
        pageTitle, ops: [...ops], inverse,
        focusBefore: focusRef.current,
        focusAfter: result.focus ?? focusRef.current,
      });
    }
```

- [ ] **Step 7: Stamp in `undoManager.dispatch`**

In `web/src/outline/undoManager.ts`, add the import and rewrite `dispatch`:

```ts
import { stampBaseTextHashes } from "./baseTextHash";
```

```ts
function dispatch(sync: HistoryDispatch, batch: BlockOp[], title: string,
                  focus: FocusTarget | null): void {
  // Peek BEFORE enqueueing: the hash must be taken against the tree as it is
  // now, not as it was when the entry was recorded, or a replay after any later
  // edit would carry a stale hash and fork a spurious [[conflict]] sibling
  // (pkm-4ubd). With no mounted session there is no tree to hash against, so
  // the ops go out unstamped and the worker fills them in when the replica is
  // openable — the same fallback as a block this tree does not know.
  const handle = peekOutlineSession(title);
  const wireOps = handle
    ? stampBaseTextHashes(handle.getSnapshot().blocks, title, batch)
    : [...batch];
  const write = sync.enqueue(wireOps, ["page", title]);
  if (handle) {
    handle.applyLocal(write, wireOps);
    handle.release();
  }
  const registered = hooks.get(title);
  if (registered) {
    registered.forEach((h) => h.applyFocus(focus));
  } else {
    // No mounted outline to show the effect (a lingering session, if any,
    // already has correct data); bring the user to where it landed.
    navigator?.(pagePath(title));
  }
}
```

- [ ] **Step 8: Write the failing integration tests**

Add to the file that covers `useOutline`'s `run` (grep for `takePendingTextOps` or
`onDraftChange` in `web/src/outline/*.test.tsx` to find it):

```ts
test("a flushed draft posts update_text with the pre-edit text's hash (pkm-4ubd)", () => {
  // ... render the outline with a block whose text is "before", type "after",
  //     flush, and assert on the ops handed to the injected sync.enqueue:
  expect(enqueued[0][0]).toMatchObject({
    op: "update_text", uid: "u1", text: "after",
    base_text_hash: sha256Hex("before"),
  });
});
```

And to `web/src/outline/undoManager.test.ts`:

```ts
test("redo stamps against the current tree, not the recorded one (pkm-4ubd)", () => {
  // Record an entry when the block reads "one", let a later edit make it "two",
  // then redo: the hash must be sha256Hex("two"), the text the server will
  // actually be replacing. A hash of "one" would fork a [[conflict]] sibling
  // against the user's own edit.
});
```

Fill both in against the files' existing harnesses — read them first and reuse their fake
`sync`/session setup rather than inventing one.

- [ ] **Step 9: Run and confirm the worker still defers**

Run: `cd web && pnpm vitest run src/outline src/replica/queue.test.ts src/sync/SyncProvider.test.tsx`
Expected: PASS. `replica/queue.test.ts` must be untouched by this change — `queue.ts:41`
only fills the hash in when `undefined`, so there is no double hashing and no stale-hash
override. If any queue test changes behaviour, stop: ownership has moved when it should only
have been supplemented.

- [ ] **Step 10: Confirm the server side is already covered**

Run: `cd /Users/arthur/code/llm/pkm && grep -rn 'base_text_hash' server/tests/test_ops_core.py | head -20`
Expected: existing tests covering both the conflict fork and the no-hash LWW fallback. The
two-tab `[[conflict]]`-sibling behaviour is the *server's* and is already pinned there — do
**not** build a two-tab Playwright test for it. Record in pkm-4ubd which server tests carry
that half, so the bean's checklist item is closed by evidence rather than by assertion. If
no such server test exists, that is a finding: record it and add the missing server test.

- [ ] **Step 11: Full verify and commit**

Run: `cd web && pnpm verify` and `cd server && uv run pytest -q`
Expected: PASS both.

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-4ubd -s completed
git add web/src/outline/baseTextHash.ts web/src/outline/baseTextHash.test.ts \
        web/src/outline/useOutline.ts web/src/outline/undoManager.ts \
        web/src/outline/*.test.ts* web/src/sync/SyncProvider.test.tsx .beans
git commit -m "fix(pkm-4ubd): stamp base_text_hash on the main thread

base_text_hash was stamped inside the worker, so every op in an online-only
session reached the server unguarded: the server fell through to plain
last-write-wins and a concurrent edit from the tab that owns the replica was
overwritten outright instead of being preserved as a [[conflict]] sibling.
Stamping happens at op construction now — useOutline.run against the pre-flush
tree, undoManager.dispatch against the tree as it is at replay time, never the
tree as it was when the entry was recorded — and the worker still defers to a
supplied hash, so ownership is supplemented, not moved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

---

### Task 8: Docs, dead code, and epic closure

**Files:**
- Modify: `docs/architecture/sync-and-offline.md` (the replica-availability prose, ~lines
  380-500)
- Modify: `docs/architecture/frontend.md:91-100` (the module map)
- Modify: `web/src/replica/rpc.ts` (drop the transitional re-export line)
- Possibly delete: `isPoolExhausted` + its tests in `web/src/replica/poolCapacity.ts` /
  `poolCapacity.test.ts`
- Modify: `docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`
  (an addendum recording the two design refinements)
- Modify: `.beans/` (close pkm-q2jj; leave pkm-tu5k open with a note)

**Interfaces:** none — documentation and deletion only.

- [ ] **Step 1: Find what the deletions made dead**

Run:
```bash
cd /Users/arthur/code/llm/pkm/web
grep -rn 'isPoolExhausted' src/ | grep -v poolCapacity
grep -rn 'isSahPoolContention' src/ | grep -v openRetry
grep -rn 'from "../replica/rpc"\|from "./rpc"' src/
```
Expected: `isPoolExhausted` used only by its own test (openRetry uses
`isSahPoolContention`, which stays as the open retry's `isRetryable` default).

- [ ] **Step 2: Delete the dead classifier and the transitional re-export**

If `isPoolExhausted` has no production caller, delete the function and its tests, keeping
`poolCapacity.ts`'s header comment about pkm-ndcu and `ensureMinimumCapacity` untouched —
the *fix* is still live, only the classifier is dead. Add one sentence to that header
recording where retention decisions moved:

```ts
// The classifier that used to recognise this failure at the far end of the RPC
// is gone (pkm-s7af): the op queue retains every replica failure except one the
// replica reports as a rejection of the op, so a SQLITE_CANTOPEN write no
// longer needs identifying by message to survive.
```

Then delete the `export { … } from "./errors";` compatibility line from `rpc.ts` if
Step 1 showed no importer needs it.

- [ ] **Step 3: Rewrite the availability prose in `sync-and-offline.md`**

Every claim below is now false and must be corrected, not merely appended to:
- "`init()` is the one call that reports 'no openable database' as a value rather than an
  exception" — it rejects now.
- "startup calls `replicaSync.markUnavailable()`" — deleted; the provider reports the mode.
- "`markUnavailable()` exists rather than a second `start()` for a specific reason" — the
  reason is now the worker latch.
- "a probe that *rejects* means we could not ask" — the probe is gone; the error's type says
  it.
- "**Two invariants make that safe**… latching preserves the memoised error's *identity*,
  which `opQueue`'s storage-error whitelist depends on" — the whitelist is gone; the latch
  is explicit and the retention rule is a type check.
- "**The lane matches the durable path's policy, not its payload.** `base_text_hash` is
  stamped inside the worker … Stamping the hash on the main thread at op-construction time
  would fix it" — it is fixed.

Replace with prose that states, in this order: the two-valued fact and its evidentiary
asymmetry (what may lift the barrier and what may not, and why "we could not ask" is not
evidence); that the worker owns it and latches it until `close()`; that it travels as a
typed error over the `{message, quota, rejected, unavailable}` wire shape and why the wire
flag is a boolean while the fact is two-valued; the retention rule as a one-item blocklist,
including why a rejection of the op is the exception; that the queue stops asking a dead
replica and so a reconnect still bumps resync; and that the lane's payload now carries
`base_text_hash`. Keep the "**One case deliberately still holds the gate**" paragraph — that
is pkm-tu5k and it is unchanged.

Also grep for counts and enumerations the change invalidates:

```bash
cd /Users/arthur/code/llm/pkm && grep -rn 'five representations\|three representations\|two invariants' docs/
```

- [ ] **Step 4: Update the frontend module map**

In `docs/architecture/frontend.md`, add `errors.ts` to the `replica/` list (with a
three-word gloss: "the availability taxonomy") and `baseTextHash.ts` to whatever line
enumerates `outline/` modules. Verify the `sync/` line still describes `replicaSync.ts`
accurately now that `markUnavailable` is gone.

- [ ] **Step 5: Add the design addendum**

Append to
`docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`:

```markdown
## Addendum: two refinements found during implementation (2026-08-04)

1. **The retain rule is a one-item blocklist, not a two-value type check.**
   Section 3's table said `opQueue` "retains on type", meaning `unusable` /
   `unreachable`. That would have regressed pkm-ndcu: `isPoolExhausted`
   (`SQLITE_CANTOPEN`) fires on writes to a successfully OPEN database, so it is
   not an availability failure and would have fallen through to `onDesync`.
   The rule shipped is: retain every replica failure **except** one the replica
   reports as a rejection of the op itself (`LocalOpError` -> the `rejected`
   wire flag). This is what pkm-9x6u's own scope correction asked for, and it
   needs one extra wire flag rather than a whitelist.
2. **"Unreachable" retains at every level but latches only on permanent
   evidence.** `createRpcClient` latches its terminal state for `worker-error`,
   `message-error` and `disposed`, but a timeout rejects one request and leaves
   the client usable. So `isSessionFatal` gates whether a consumer may cache the
   availability state; `availabilityOf` alone gates retention.
```

- [ ] **Step 6: Docs-only commit**

Docs-only commits need no test run (nothing reads these files). The message must distinguish
corrections from additions, per CLAUDE.md.

```bash
cd /Users/arthur/code/llm/pkm
git add docs/architecture/sync-and-offline.md docs/architecture/frontend.md \
        docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md \
        web/src/replica/rpc.ts web/src/replica/poolCapacity.ts \
        web/src/replica/poolCapacity.test.ts
git commit -m "docs(pkm-q2jj): correct the replica-availability prose after the refactor

Corrected: init() rejects rather than reporting ok:false; markUnavailable() and
replicaSync's disabled flag no longer exist; the 'two invariants' paragraph no
longer describes a memoised-promise latch whose safety the message whitelist
depended on; the lane's payload now carries base_text_hash.
Added: the two-valued fact and its evidentiary asymmetry, the typed error and
why the wire flag is a boolean, and the retain rule as a one-item blocklist.
Also deletes the now-dead isPoolExhausted classifier and records two design
refinements as a spec addendum.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y3h23mUkce74fodzXjNzD1"
```

- [ ] **Step 7: Final whole-branch verification**

Run, from the repo root:
```bash
cd web && pnpm verify
cd ../server && uv run pytest -q && uv run pyrefly check && uv run ruff check
```
Expected: all green. Compare against the Task 2 baseline: test count up, coverage at or
above 97.7% statements / 93.09% branches, 51/51 e2e, zero jsdom warnings.

Then read the whole branch diff in one pass — cross-task regressions are what a
whole-branch review catches and a per-task one does not:
```bash
git diff main...HEAD --stat && git diff main...HEAD
```
Check specifically: no `grep -rn 'isSahPoolContention\|isPoolExhausted' src/sync/` hits; no
`markUnavailable`; no `\.ok\b` on an `init()` result; `stampBaseTextHashes` called at both
choke points and at neither more than once.

- [ ] **Step 8: Close the epic**

```bash
cd /Users/arthur/code/llm/pkm
beans update pkm-q2jj -s completed --body-append "## Summary of Changes

The worker latches a ReplicaUnavailableError on the first openDb() failure and
every handler rejects with it; it crosses the wire via two new flags on the
existing {message, quota} shape; every other representation is derived or gone.
Deleted: init().ok, replicaSync's \`disabled\`, markUnavailable(), SyncProvider's
init() viability probe and its \"unknown\" branch, and opQueue's
isSahPoolContention/isPoolExhausted message matching. Closed pkm-9x6u (both
halves, including the RpcLifecycleError case an availability mode alone would
have missed) and pkm-4ubd (base_text_hash stamped main-thread).

Two design refinements are recorded as a spec addendum: the retain rule is a
one-item blocklist rather than a two-value type check (a pool-exhausted write on
an OPEN database is not an availability failure, and a type check would have
regressed pkm-ndcu), and only session-fatal evidence may latch an availability
state (an RPC timeout is not terminal).

pkm-tu5k remains OPEN and unsequenced by design: this branch makes its fix
possible — the queue can now see that marking is impossible — without deciding
what to do about a rejection that can never be repaired."
git log --oneline main..HEAD
```

Then hand back for the merge decision rather than merging: use
`superpowers:finishing-a-development-branch`, and remember `git merge --no-ff`.

---

## Self-Review

**Spec coverage.** Design section 1 (worker owns it) → Task 3. Section 2 (typed error, the
wire flag's boolean-ness, the `isStallShaped` requirement) → Task 1. Section 3's table:
`opQueue` → Task 4; `replicaSync` → Tasks 5-6; `SyncProvider` → Tasks 5-6;
`OfflineIndicator` unchanged (verified: it renders off `problem.kind ===
"replica-unavailable"`, which is untouched). Section 4's four closure claims → pkm-9x6u
(Task 4), pkm-tu5k (explicitly deferred, stated in Global Constraints and Task 8),
pkm-4ubd (Task 7), the `"unknown"` branch (Task 5). Risk/mitigation → Task 2, including its
instruction to record unpinnable behaviour as findings. Ordering → Tasks 1-8 in the spec's
order, with step 5 split across two tasks because deleting `ReplicaInit.ok` is a mechanical
sweep that should not share a review gate with the provider's control flow. Testing section
→ covered per task, plus `pnpm verify` in every task and the whole-branch pass in Task 8.

**Gaps found and closed while reviewing:** the design's `opQueue` row would have regressed
pkm-ndcu (recorded as finding 1, changes Task 4); "unreachable" needed splitting by
permanence (finding 2, changes Tasks 1 and 4); `init().ok` needed an explicit decision
(finding 4, Task 5). The provider-level pkm-4ubd repro cannot prove stamping, only that the
lane preserves it — Task 7 Step 5 says so rather than letting the test overclaim.

**Type consistency.** `stampBaseTextHashes(blocks, pageTitle, ops)` — same name and argument
order at both call sites and in its tests. `availabilityOf` / `isSessionFatal` /
`ReplicaAvailability` / `ReplicaUnavailableError` / `ReplicaErrorFlags` used identically in
Tasks 1, 3, 4, 5, 6. `ReplicaError`'s constructor is `(message, flags?)` everywhere after
Task 1 Step 13. `ReplicaInit` drops `ok` in Task 5 and no later task references it.
