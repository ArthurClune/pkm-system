// @vitest-environment node
// End-to-end over a MessageChannel: the typed Replica facade on one side,
// buildHandlers over a real in-memory sqlite-wasm database on the other.
import { expect, test, vi } from "vitest";
import type { Snapshot } from "./apply";
import { createReplica, type Replica } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import { setMeta } from "./meta";
import { serveRpc, toPortLike } from "./rpc";
import { openRawTestDb, type TestDb } from "./testDb";
import { buildHandlers } from "./workerHandlers";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const SNAP: Snapshot = {
  generation: "gen-1", seq: 5,
  pages: [{ id: 1, title: "AI", created_at: 1, updated_at: 1 }],
  blocks: [{ uid: "uid_b1", page_id: 1, parent_uid: null, order_idx: 0,
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
  expect(init).toEqual({ ok: true, empty: true, cursor: 0,
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
    reset: false, generation: "gen-1", next_since: 6, latest_seq: 6,
    pages: [], blocks: [], sidebar: [],
    tombstones: [{ kind: "block", entity_id: "uid_b1" }],
  });
  expect(result).toEqual({ status: "applied", cursor: 6 });
  const gone = await replica.applyChanges({
    reset: false, generation: "gen-2", next_since: 0, latest_seq: 0,
    pages: [], blocks: [], sidebar: [], tombstones: [],
  });
  expect(gone).toEqual({ status: "needs-bootstrap" });
});

test("a feed fetched before an acknowledged batch deletion cannot overwrite it", async () => {
  const { replica, current } = await setup();
  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue([
    { op: "update_text", uid: "uid_b1", text: "acknowledged local text" },
  ]);

  // The request was dispatched while this optimistic batch still existed.
  const pendingAtDispatch = (await replica.pendingBatches()).map((batch) => batch.id);
  const batch = (await replica.nextBatch())!;
  await replica.deleteBatch(batch.id); // its POST was acknowledged meanwhile

  const result = await replica.applyChanges({
    reset: false, generation: "gen-1", next_since: 6, latest_seq: 6,
    pages: [],
    blocks: [{ ...SNAP.blocks[0], text: "hello" }],
    sidebar: [], tombstones: [],
  }, pendingAtDispatch);

  expect(result).toEqual({ status: "pending-changed" });
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "acknowledged local text" }]);
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

test("openDb failure degrades to no-replica mode instead of rejecting", async () => {
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => { throw new Error("OPFS unavailable"); },
  }));
  const replica = createReplica(toPortLike(ch.port1));
  await expect(replica.init()).resolves.toEqual({
    ok: false, empty: true, cursor: 0, schemaMismatch: false, pendingBatches: [],
  });
});

test("an edit arriving before init persists (schema installs on demand)", async () => {
  // the first keystroke can beat the socket connect that triggers init:
  // durability must not depend on that ordering
  const { replica } = await setup();
  const { pending } = await replica.enqueue([
    { op: "create", uid: "uid_pre", page_title: "Today",
      parent_uid: null, order_idx: 0, text: "typed before init" },
  ]);
  expect(pending).toBe(1);
  const init = await replica.init();
  expect(init.ok).toBe(true);
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
      newBatchId: () => "batch-after-timeout",
    });
    serveRpc(toPortLike(ch.port2), {
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
    await expect(replica.enqueue([{ op: "delete", uid: "uid_after" }]))
      .resolves.toEqual({ pending: 1 });
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
    { op: "update_text", uid: "uid_b1", text: "offline edit" },
  ]);
  expect(pending).toBe(1);
  expect(current().db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "offline edit" }]);
  const batch = (await replica.nextBatch())!;
  expect(batch.ops[0]).toMatchObject({ op: "update_text", text: "offline edit" });
  expect(batch.batch_id.length).toBeGreaterThanOrEqual(8);
  expect(await replica.pendingBatches()).toHaveLength(1);
  await replica.deleteBatch(batch.id);
  expect(await replica.pendingCount()).toBe(0);
  await expect(replica.markPoisoned(99, "gone")).resolves.toEqual({ pending: 0 });
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
      return () => `batch-${++id}`;
    })(),
  });
  serveRpc(toPortLike(ch.port2), {
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
    { op: "update_text", uid: "uid_b1", text: "after recovery" },
  ]).finally(() => { enqueueSettled = true; });
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
