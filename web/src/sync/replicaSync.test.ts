import { expect, test, vi } from "vitest";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { PendingBatch, Replica, ReplicaInit } from "../replica/client";
import { createReplicaSync, type ReplicaState } from "./replicaSync";

const SNAP: Snapshot = {
  generation: "gen-1", seq: 5, pages: [], blocks: [], sidebar: [],
};

const feed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", next_since: 5, latest_seq: 5,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

function fakeReplica(over: Partial<Replica> = {},
                     init: Partial<ReplicaInit> = {}): Replica & { calls: string[] } {
  const calls: string[] = [];
  const rec = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    calls,
    init: () => rec("init", { ok: true, empty: false, cursor: 5,
                              schemaMismatch: false, pendingBatches: [],
                              ...init } as ReplicaInit),
    applySnapshot: () => rec("applySnapshot", undefined),
    applyChanges: (f: Changes) =>
      rec<ApplyResult>("applyChanges", { status: "applied", cursor: f.next_since }),
    enqueue: () => rec("enqueue", { pending: 0 }),
    nextBatch: () => rec<PendingBatch | null>("nextBatch", null),
    deleteBatch: () => rec("deleteBatch", { pending: 0 }),
    markPoisoned: () => rec("markPoisoned", { pending: 0 }),
    pendingCount: () => rec("pendingCount", 0),
    pendingBatches: () => rec<PendingBatch[]>("pendingBatches", []),
    localApi: () => rec("localApi", null),
    reset: () => rec("reset", undefined),
    ...over,
  };
}

function collector() {
  const states: ReplicaState[] = [];
  return { states, onState: (s: ReplicaState) => { states.push(s); } };
}

test("start on an empty replica bootstraps from the snapshot then is ready", async () => {
  const replica = fakeReplica({}, { empty: true, cursor: 0 });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/sync/snapshot") return SNAP;
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/snapshot");
  expect(replica.calls).toContain("applySnapshot");
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("start on a warm replica skips the snapshot and catches up the feed", async () => {
  const replica = fakeReplica();
  const fetchJson = vi.fn(async () => feed({ next_since: 9, latest_seq: 9 }));
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/changes?since=5");
  expect(fetchJson).not.toHaveBeenCalledWith("/api/sync/snapshot");
});

test("no-replica init reports mode and never fetches", async () => {
  const replica = fakeReplica({}, { ok: false });
  const fetchJson = vi.fn();
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(states.at(-1)).toEqual({ mode: "no-replica" });
  expect(fetchJson).not.toHaveBeenCalled();
});

test("onSeq beyond the cursor pulls windows until latest, below it does nothing", async () => {
  const replica = fakeReplica();
  const windows = [
    feed({ next_since: 7, latest_seq: 9 }),
    feed({ next_since: 9, latest_seq: 9 }),
  ];
  const fetchJson = vi.fn(async (path: string) => {
    if (path.startsWith("/api/sync/changes")) return windows.shift() ?? feed({ next_since: 9, latest_seq: 9 });
    throw new Error(`unexpected ${path}`);
  });
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start(); // catches up to 9 (two windows)
  const callsAfterStart = fetchJson.mock.calls.length;
  sync.onSeq(3); // stale nudge: cursor is already 9
  await sync.idle();
  expect(fetchJson.mock.calls.length).toBe(callsAfterStart);
  sync.onSeq(12);
  await sync.idle();
  expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=9");
});

test("a needs-bootstrap feed answer re-bootstraps when the queue is empty", async () => {
  const replica = fakeReplica({
    applyChanges: vi.fn()
      .mockResolvedValueOnce({ status: "needs-bootstrap" })
      .mockResolvedValue({ status: "applied", cursor: 5 }),
  });
  const fetchJson = vi.fn(async (path: string) =>
    path === "/api/sync/snapshot" ? SNAP : feed());
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(replica.calls).toContain("pendingCount");
  expect(replica.calls).toContain("reset");
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/snapshot");
});

test("schema mismatch flushes pending batches before reset, in order", async () => {
  const posted: unknown[] = [];
  const replica = fakeReplica({}, {
    schemaMismatch: true,
    pendingBatches: [
      { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
      { id: 2, batch_id: "b-2", ops: [{ op: "delete", uid: "uid_a2" }], poisoned: true },
      { id: 3, batch_id: "b-3", ops: [{ op: "delete", uid: "uid_a3" }], poisoned: false },
    ],
  });
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") { posted.push(JSON.parse(String(init?.body))); return { ok: true }; }
    if (path === "/api/sync/snapshot") return SNAP;
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  // poisoned batch b-2 is NOT retried; the others flush oldest-first
  expect(posted.map((b) => (b as { batch_id: string }).batch_id)).toEqual(["b-1", "b-3"]);
  expect(replica.calls).toContain("reset");
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("a failed recovery flush keeps the database and reports the failure", async () => {
  const replica = fakeReplica({}, {
    schemaMismatch: true,
    pendingBatches: [
      { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
    ],
  });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") throw new Error("network down");
    return SNAP;
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(replica.calls).not.toContain("reset");
  expect(states.at(-1)).toEqual({ mode: "recovery-failed", error: "network down" });
});

test("overlapping nudges coalesce into a trailing pull", async () => {
  const replica = fakeReplica();
  let release!: (v: Changes) => void;
  const gate = new Promise<Changes>((r) => { release = r; });
  const fetchJson = vi.fn()
    .mockImplementationOnce(async () => gate)               // start's catch-up pull
    .mockImplementation(async () => feed({ next_since: 20, latest_seq: 20 }));
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  const started = sync.start();
  while (fetchJson.mock.calls.length === 0) await Promise.resolve();
  sync.onSeq(15);
  sync.onSeq(16); // both while the first pull hangs -> one trailing pull
  release(feed({ next_since: 9, latest_seq: 9 }));
  await started;
  await sync.idle();
  // one hanging pull + windows: no unbounded fan-out
  expect(fetchJson.mock.calls.length).toBeLessThanOrEqual(3);
  expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=9");
});
