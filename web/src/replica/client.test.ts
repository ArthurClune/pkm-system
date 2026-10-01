// @vitest-environment node
// End-to-end over a MessageChannel: the typed Replica facade on one side,
// buildHandlers over a real in-memory sqlite-wasm database on the other.
import { expect, test, vi } from "vitest";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { components } from "../api/types";
import type { Snapshot } from "./apply";
import {
  createReplica, type AckedBatch, type PendingRowId, type Replica,
  type ReplicaRpc,
} from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import { ReplicaUnusableError } from "./errors";
import { setMeta } from "./meta";
import { createRpcClient, serveRpc, toPortLike, type RpcHandlers } from "./rpc";
import { openRawTestDb, type TestDb } from "./testDb";
import { buildHandlers } from "./workerHandlers";
import { pageId, title, uid } from "../test-helpers";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Every test here picks an arbitrary batch-id string, same shape as the
// production mint (newUid()/crypto.randomUUID()); this mints the brand once
// rather than at every call.
const bid = (s: string): BatchId => s as BatchId;

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: (5 as SyncSeq),
  pages: [{ id: pageId(1), title: title("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uid("uid_b1"), page_id: pageId(1), parent_uid: null, order_idx: 0,
             text: "hello", heading: null, view_type: null, collapsed: 0, created_at: 1,
             updated_at: 1, refs: [] }],
  sidebar: [],
};

async function setup(prep?: (t: TestDb) => void): Promise<{ replica: Replica; current: () => TestDb }> {
  const t = await openRawTestDb();
  prep?.(t);
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => t.db,
  }));
  return { replica: createReplica(toPortLike(ch.port1)), current: () => t };
}

test("init on a fresh database installs the schema and reports empty", async () => {
  const { replica } = await setup();
  const init = await replica.init();
  expect(init).toEqual({ empty: true, cursor: 0,
                         schemaMismatch: false, pendingBatches: [] });
});

test("bootstrap then re-init reports cursor and not-empty", async () => {
  const { replica } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  const again = await replica.init();
  expect(again.empty).toBe(false);
  expect(again.cursor).toBe(5);
});

test("applyChanges round-trips through the port", async () => {
  const { replica } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  const result = await replica.applyChanges({
    reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
    next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq), pages: [], blocks: [], sidebar: [],
    tombstones: [{ kind: "block", entity_id: "uid_b1" }],
  });
  expect(result).toEqual({ status: "applied", cursor: 6 });
  const gone = await replica.applyChanges({
    reset: false, generation: "gen-2", plain_space_title_canonicalization: false,
    next_since: (0 as SyncSeq), latest_seq: (0 as SyncSeq),
    pages: [], blocks: [], sidebar: [], tombstones: [],
  });
  expect(gone).toEqual({ status: "needs-bootstrap" });
});

test("a feed fetched before an acknowledged batch deletion cannot overwrite it", async () => {
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue([
    { op: "update_text", uid: uid("uid_b1"), text: "acknowledged local text" },
  ], bid("batch-ack"));

  // The request was dispatched while this optimistic batch still existed.
  const pendingAtDispatch = (await replica.pendingBatches()).map((batch) => batch.id);
  const batch = (await replica.nextBatch())!;
  await replica.deleteBatch(batch.id, batch.batch_id); // its POST was acknowledged meanwhile

  const result = await replica.applyChanges({
    reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
    next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq), pages: [],
    blocks: [{ ...SNAP.blocks[0], text: "hello" }],
    sidebar: [], tombstones: [],
  }, pendingAtDispatch);

  expect(result).toEqual({ status: "pending-changed" });
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "acknowledged local text" }]);
});

test("a window whose latest_seq covers the acked batch applies despite the stale pending snapshot", async () => {
  // The save's WS nudge started this pull while the batch was
  // pending; the HTTP ack then deleted it, naming the journal seq of its
  // commit. The window was read at latest_seq >= that seq, so it already
  // carries the batch -- refetching would fetch the very same rows.
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue([
    { op: "update_text", uid: uid("uid_b1"), text: "acknowledged local text" },
  ], bid("batch-ack"));
  const pendingAtDispatch = (await replica.pendingBatches()).map((batch) => batch.id);
  const batch = (await replica.nextBatch())!;
  await replica.deleteBatch(batch.id, batch.batch_id, (6 as SyncSeq));

  const result = await replica.applyChanges({
    reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
    next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq), pages: [],
    blocks: [{ ...SNAP.blocks[0], text: "acknowledged local text" }],
    sidebar: [], tombstones: [],
  }, pendingAtDispatch);

  expect(result).toEqual({ status: "applied", cursor: 6 });
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "acknowledged local text" }]);
});

test("a window read before the acked batch committed is still refused", async () => {
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue([
    { op: "update_text", uid: uid("uid_b1"), text: "acknowledged local text" },
  ], bid("batch-ack"));
  const pendingAtDispatch = (await replica.pendingBatches()).map((batch) => batch.id);
  const batch = (await replica.nextBatch())!;
  await replica.deleteBatch(batch.id, batch.batch_id, (7 as SyncSeq)); // committed after the window's read

  const result = await replica.applyChanges({
    reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
    next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq), pages: [],
    blocks: [{ ...SNAP.blocks[0], text: "hello" }],
    sidebar: [], tombstones: [],
  }, pendingAtDispatch);

  expect(result).toEqual({ status: "pending-changed" });
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "acknowledged local text" }]);
});

test("a later seq-less delete of the same id forgets the recorded acked seq", async () => {
  const { replica } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue([{ op: "delete", uid: uid("uid_b1") }], bid("batch-1"));
  const pendingAtDispatch = (await replica.pendingBatches()).map((batch) => batch.id);
  const batch = (await replica.nextBatch())!;
  await replica.deleteBatch(batch.id, batch.batch_id, (6 as SyncSeq));
  await replica.deleteBatch(batch.id, batch.batch_id);

  await expect(replica.applyChanges({
    reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
    next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq), pages: [], blocks: [], sidebar: [],
    tombstones: [],
  }, pendingAtDispatch)).resolves.toEqual({ status: "pending-changed" });
});

test("a schema-version mismatch is reported with the pending queue intact", async () => {
  const { replica } = await setup((t) => {
    // simulate a database written by an older client: full schema but a
    // different stamped version, with one queued batch
    installSchema(t.db);
    setMeta(t.db, "schema_version", "0".repeat(64));
    setMeta(t.db, "generation", "gen-0");
    t.db.exec(
      "INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
      ["batch-1", JSON.stringify([{ op: "delete", uid: "uid_x1" }])]);
  });
  const init = await replica.init();
  expect(init.schemaMismatch).toBe(true);
  expect(init.pendingBatches).toEqual([{
    id: 1, batch_id: "batch-1", poisoned: false,
    ops: [{ op: "delete", uid: "uid_x1" }],
  }]);
});

test("reset destroys the database and reinstalls a fresh schema", async () => {
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.reset();
  const init = await replica.init();
  expect(init.empty).toBe(true);
  expect(init.schemaMismatch).toBe(false);
  const rows = current().db.select("SELECT value FROM sync_client_meta WHERE key='schema_version'");
  expect(rows).toEqual([{ value: SCHEMA_VERSION }]);
});

test("openDb failure rejects init() with the worker's latched error", async () => {
  // init() is just another handler: the worker's db() latch rejects it
  // exactly like every other call, and the typed error is what travels --
  // a failed open must never cross the RPC boundary as an ok:false value.
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => { throw new Error("OPFS unavailable"); },
  }));
  const replica = createReplica(toPortLike(ch.port1));
  const err = await replica.init().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaUnusableError);
  expect((err as Error).message).toBe("OPFS unavailable");
});

test("an edit arriving before init persists (schema installs on demand)", async () => {
  // the first keystroke can beat the socket connect that triggers init:
  // durability must not depend on that ordering
  const { replica } = await setup();
  const { pending } = await replica.enqueue([
    { op: "create", uid: uid("uid_pre"), page_title: "Today",
      parent_uid: null, order_idx: 0, text: "typed before init" },
  ], bid("batch-pre"));
  expect(pending).toBe(1);
  const init = await replica.init();
  expect(init.empty).toBe(true); // still needs the snapshot bootstrap
  expect(init.schemaMismatch).toBe(false);
  expect(init.pendingBatches).toHaveLength(1);
});

test("dispose closes the worker database before disposing the RPC facade", async () => {
  const events: string[] = [];
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => (await openRawTestDb()).db,
    closeDb: async () => { events.push("close-db"); },
  }));
  const replica = createReplica(toPortLike(ch.port1), () => {
    events.push("terminate-worker");
  });

  await replica.dispose();
  await replica.dispose();

  expect(events).toEqual(["close-db", "terminate-worker"]);
  await expect(replica.pendingCount()).rejects.toMatchObject({ kind: "disposed" });
});

test("snapshot and recovery RPCs use the long timeout; ordinary calls use the default", async () => {
  vi.useFakeTimers();
  try {
    const ch = new MessageChannel();
    const replica = createReplica(toPortLike(ch.port1));
    let snapshotSettled = false;
    const ordinary = replica.pendingCount().catch((error: unknown) => error);
    const snapshot = replica.applySnapshot(SNAP)
      .then(() => undefined, (error: unknown) => error)
      .finally(() => { snapshotSettled = true; });
    const reset = replica.reset().catch((error: unknown) => error);
    let prepareSettled = false;
    const prepare = replica.prepareRecovery()
      .then(() => undefined, (error: unknown) => error)
      .finally(() => { prepareSettled = true; });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(ordinary).resolves.toMatchObject({ kind: "timeout" });
    expect(snapshotSettled).toBe(false);
    expect(prepareSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(snapshot).resolves.toMatchObject({ kind: "timeout" });
    await expect(reset).resolves.toMatchObject({ kind: "timeout" });
    await expect(prepare).resolves.toMatchObject({ kind: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});

test("a prepare delayed past its client timeout cannot later orphan the worker lease", async () => {
  vi.useFakeTimers();
  try {
    const t = await openRawTestDb();
    const openStarted = deferred();
    const releaseOpen = deferred<TestDb["db"]>();
    const workerPrepareFinished = deferred();
    let workerPrepareOutcome: "pending" | "resolved" | "rejected" = "pending";
    const ch = new MessageChannel();
    const base = buildHandlers({
      openDb: async () => {
        openStarted.resolve();
        return releaseOpen.promise;
      },
      newBatchId: () => bid("batch-after-timeout"),
    });
    serveRpc<ReplicaRpc>(toPortLike(ch.port2), {
      ...base,
      prepareRecovery: async (payload) => {
        try {
          const result = await base.prepareRecovery(payload);
          workerPrepareOutcome = "resolved";
          return result;
        } catch (error: unknown) {
          workerPrepareOutcome = "rejected";
          throw error;
        } finally {
          workerPrepareFinished.resolve();
        }
      },
    });
    const replica = createReplica(toPortLike(ch.port1));

    const earlier = replica.pendingCount().catch((error: unknown) => error);
    await openStarted.promise;
    const prepare = replica.prepareRecovery().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(prepare).resolves.toMatchObject({ kind: "timeout" });

    releaseOpen.resolve(t.db);
    await workerPrepareFinished.promise;
    expect(workerPrepareOutcome).toBe("rejected");
    await expect(replica.enqueue([{ op: "delete", uid: uid("uid_after") }], bid("batch-after")))
      .resolves.toMatchObject({ pending: 1, batchId: expect.any(String) });
    await earlier;
  } finally {
    vi.useRealTimers();
  }
});

test("enqueue round-trips: persisted, optimistic, drainable", async () => {
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  const { pending } = await replica.enqueue([
    { op: "update_text", uid: uid("uid_b1"), text: "offline edit" },
  ], bid("batch-offline"));
  expect(pending).toBe(1);
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "offline edit" }]);
  const batch = (await replica.nextBatch())!;
  expect(batch.ops[0]).toMatchObject({ op: "update_text", text: "offline edit" });
  expect(batch.batch_id.length).toBeGreaterThanOrEqual(8);
  expect(await replica.pendingBatches()).toHaveLength(1);
  await replica.markPoisoned(batch.id, JSON.stringify({
    status: 422, message: "request failed: 422 /api/ops",
  }), batch.batch_id);
  await expect(replica.poisonedBatches()).resolves.toEqual([{
    id: batch.id,
    batch_id: batch.batch_id,
    ops: batch.ops,
    status: 422,
    message: "request failed: 422 /api/ops",
  }]);
  await replica.deleteBatch(batch.id, batch.batch_id);
  expect(await replica.pendingCount()).toBe(0);
  await expect(replica.markPoisoned((99 as PendingRowId), "gone", bid("gone-batch"))).resolves.toEqual({
    pending: 0, matched: false,
  });
});

test("a recovery lease gates enqueue and offline POST until the fresh database is ready", async () => {
  const t = await openRawTestDb();
  const enqueueDispatched = deferred();
  const localPostDispatched = deferred();
  const ch = new MessageChannel();
  const base = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: (() => {
      let id = 0;
      return () => bid(`batch-${++id}`);
    })(),
  });
  serveRpc<ReplicaRpc>(toPortLike(ch.port2), {
    ...base,
    enqueue: async (payload) => {
      enqueueDispatched.resolve();
      return base.enqueue(payload);
    },
    localApi: async (payload) => {
      localPostDispatched.resolve();
      return base.localApi(payload);
    },
  });
  const replica = createReplica(toPortLike(ch.port1));
  await replica.init();
  await replica.applySnapshot(SNAP);

  const lease = await replica.prepareRecovery();
  let enqueueSettled = false;
  let localPostSettled = false;
  const enqueue = replica.enqueue([
    { op: "update_text", uid: uid("uid_b1"), text: "after recovery" },
  ], bid("batch-after-recovery")).finally(() => { enqueueSettled = true; });
  const localPost = replica.localApi({
    method: "POST", path: "/api/pages", body: { title: "Offline Page" }, nowMs: 10,
  }).finally(() => { localPostSettled = true; });

  await Promise.all([enqueueDispatched.promise, localPostDispatched.promise]);
  expect(enqueueSettled).toBe(false);
  expect(localPostSettled).toBe(false);
  expect(t.db.select("SELECT COUNT(*) AS n FROM pending_ops")).toEqual([{ n: 0 }]);
  expect(t.db.select("SELECT id FROM pages WHERE title='Offline Page'")).toEqual([]);

  await replica.commitRecovery(lease.token, { kind: "reset", snapshot: SNAP });
  await Promise.all([enqueue, localPost]);

  expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "after recovery" }]);
  expect(t.db.select("SELECT title FROM pages WHERE title='Offline Page'"))
    .toEqual([{ title: "Offline Page" }]);
  expect(await replica.pendingCount()).toBe(2);
});

// Replica.deleteBatch's `id`/`ackedSeq` pair is the public shape of the
// worker's noteAck(id, seq): both are plain numbers at runtime, so the
// brands are the only thing stopping a caller from swapping them.
test("deleteBatch's id/ackedSeq brands reject a swapped call (compile-time only)", () => {
  const rowId = 1 as PendingRowId;
  const seq = 7 as SyncSeq;
  const deleteBatch: Replica["deleteBatch"] = async () => ({ pending: 0 });
  // @ts-expect-error ackedSeq takes a SyncSeq, not a PendingRowId
  void deleteBatch(rowId, bid("b"), rowId);
  // @ts-expect-error id takes a PendingRowId, not a SyncSeq
  void deleteBatch(seq, bid("b"), seq);
  // @ts-expect-error same pair, swapped: AckedBatch.id is a PendingRowId
  // and AckedBatch.seq is a SyncSeq | null, not the reverse
  const swapped: AckedBatch = { id: seq, batch_id: bid("b"), seq: rowId };
  expect(swapped).toBeDefined();
});

// OpBatch's client_id/batch_id look interchangeable as bare uid strings --
// this is the swap the brands exist to block at compile time (web's
// sync/opQueue.ts postOps builds exactly this body shape).
test("OpBatch's client_id/batch_id brands reject a swapped body (compile-time only)", () => {
  const clientId = "tab-1" as ClientId;
  const batchId = bid("batch-1");
  const swapped: components["schemas"]["OpBatch"] = {
    // @ts-expect-error client_id takes a ClientId, not a BatchId
    client_id: batchId,
    // @ts-expect-error batch_id takes a BatchId, not a ClientId
    batch_id: clientId,
    ops: [],
  };
  expect(swapped).toBeDefined();
});

// markPoisoned's `error`/`batchId` pair is two bare strings at runtime
// (JSON.stringify(...) and a uid); the brand is the only thing stopping a
// caller from passing the error message where the batch id belongs.
test("markPoisoned's error/batchId brand rejects an unbranded batchId (compile-time only)", () => {
  const rowId = 1 as PendingRowId;
  const error = "request failed: 422 /api/ops";
  const markPoisoned: Replica["markPoisoned"] = async () => (
    { pending: 0, matched: false }
  );
  // @ts-expect-error batchId takes a BatchId, not the bare error string
  void markPoisoned(rowId, error, error);
  expect(markPoisoned).toBeDefined();
});

// ReplicaRpc is the one contract createReplica's rpc.call and
// workerHandlers.ts's buildHandlers both compile against; these four probes
// are what a plain `Record<string, ...>` map (what rpc.ts had before) could
// not catch, each at build time rather than at "unknown replica method: …".
test("rpc.call rejects a method ReplicaRpc does not declare (compile-time only)", () => {
  const rpc = createRpcClient<ReplicaRpc>(toPortLike(new MessageChannel().port1));
  // @ts-expect-error "bogus" is not a key of ReplicaRpc
  void rpc.call("bogus");
  expect(rpc).toBeDefined();
});

test("rpc.call rejects a wrongly-shaped payload (compile-time only)", () => {
  const rpc = createRpcClient<ReplicaRpc>(toPortLike(new MessageChannel().port1));
  const rowId = 1 as PendingRowId;
  const seq = 7 as SyncSeq;
  // @ts-expect-error deleteBatch's batchId takes a BatchId, not a plain string
  void rpc.call("deleteBatch", { id: rowId, batchId: "b" });
  // @ts-expect-error deleteBatch's id takes a PendingRowId, not a SyncSeq
  void rpc.call("deleteBatch", { id: seq, batchId: bid("b") });
  expect(rpc).toBeDefined();
});

test("rpc.call's result is typed per method, not as a free type parameter (compile-time only)", () => {
  const rpc = createRpcClient<ReplicaRpc>(toPortLike(new MessageChannel().port1));
  // @ts-expect-error pendingCount resolves a number, not a string
  const asString: Promise<string> = rpc.call("pendingCount");
  expect(asString).toBeDefined();
});

test("RpcHandlers<ReplicaRpc> rejects an incomplete or mistyped handler record (compile-time only)", () => {
  // @ts-expect-error missing every method but init: not every key of
  // ReplicaRpc is covered
  const incomplete: RpcHandlers<ReplicaRpc> = {
    init: async () => ({
      empty: true, cursor: 0 as SyncSeq, schemaMismatch: false, pendingBatches: [],
    }),
  };
  const pendingCount: RpcHandlers<ReplicaRpc>["pendingCount"] =
    // @ts-expect-error pendingCount must resolve a number, not a string
    async () => "nope";
  expect(incomplete).toBeDefined();
  expect(pendingCount).toBeDefined();
});
