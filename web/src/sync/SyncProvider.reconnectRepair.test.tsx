// A rejected batch's repair whose snapshot fetch fails (the network went
// away) is retried by the next socket reconnect, through the provider's own
// wiring, with the banner moving failed -> running -> repaired as it does for
// a click on Retry.
import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BatchId, SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { PendingRowId, Replica } from "../replica/client";
import { FakeWebSocket, jsonResponse, uid } from "../test-helpers";
import { SyncProvider, useSyncActions, useSyncHealth } from "./SyncProvider";

const SNAPSHOT = { generation: "g1", seq: 5, pages: [], blocks: [], sidebar: [] };
const EMPTY_FEED = { reset: false, generation: "g1", next_since: 5,
                     latest_seq: 5, pages: [], blocks: [], sidebar: [],
                     tombstones: [] };

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** A replica whose first row is the batch the server rejects. */
function rowReplica(): Replica {
  const rows: Array<{ id: PendingRowId; batch_id: BatchId; ops: BlockOp[];
                     poisoned: boolean }> = [];
  let nextId = 1;
  const pending = () => rows.filter((row) => !row.poisoned).length;
  return {
    init: async () => ({ empty: false, cursor: 5 as SyncSeq, schemaMismatch: false,
                         pendingBatches: [] }),
    applySnapshot: async () => undefined,
    applyChanges: async (f) => ({ status: "applied", cursor: f.next_since }),
    enqueue: async (ops) => {
      const id = nextId++ as PendingRowId;
      const batch_id = (id === 1 ? "bad-batch" : "good-batch") as BatchId;
      rows.push({ id, batch_id, ops, poisoned: false });
      return { pending: pending(), batchId: batch_id };
    },
    nextBatch: async () => rows.find((row) => !row.poisoned) ?? null,
    pendingBatches: async () => [...rows],
    poisonedBatches: async () => [],
    deleteBatch: async (id) => {
      rows.splice(rows.findIndex((row) => row.id === id), 1);
      return { pending: pending() };
    },
    markPoisoned: async (id) => {
      rows.find((row) => row.id === id)!.poisoned = true;
      return { pending: pending(), matched: true };
    },
    pendingCount: async () => pending(),
    localApi: async () => ({ handled: false as const }),
    prepareRecovery: async () => ({ token: "lease", batches: [...rows] }),
    commitRecovery: async () => undefined,
    abortRecovery: async () => undefined,
    reset: async () => undefined,
    diagnostics: async () => ({
      sqliteVersion: "fake", quickCheck: ["ok"],
      integrity: { blocks_fts: "ok", pages_fts: "ok" },
      counts: { pages: 0, blocks: 0, pending_ops: 0,
                pages_fts_docsize: 0, blocks_fts_docsize: 0 },
      meta: { cursor: "0", generation: null, schema_version: null },
    }),
    dispose: async () => undefined,
  };
}

test("a poison repair cut off by the network is retried on reconnect", async () => {
  let online = true;
  let snapshotCalls = 0;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      const batchId = (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id;
      posts.push(batchId);
      if (batchId === "bad-batch") {
        // The rejection arrives as the link drops: the repair that follows
        // finds no network for its snapshot.
        online = false;
        return jsonResponse({ detail: "bad op" }, 400);
      }
      return jsonResponse({ ok: true });
    }
    if (!online) throw new TypeError("fetch failed");
    if (url === "/api/sync/snapshot") {
      snapshotCalls += 1;
      return jsonResponse(SNAPSHOT);
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  let health!: ReturnType<typeof useSyncHealth>;
  let actions!: ReturnType<typeof useSyncActions>;
  function Grab() { health = useSyncHealth(); actions = useSyncActions(); return null; }
  render(<SyncProvider replica={rowReplica()}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await act(async () => {
    await actions.enqueue([{ op: "delete", uid: uid("bad") }]).settled;
    await actions.enqueue([{ op: "delete", uid: uid("good") }]).settled;
  });
  await vi.waitFor(() => { expect(health.problem).toMatchObject({
    kind: "rejected-batch", repair: "failed",
  }); });
  await act(async () => { lastWs().drop(); });
  expect(posts).toEqual(["bad-batch"]);

  online = true;
  await act(async () => { lastWs().open(); });

  await vi.waitFor(() => { expect(posts).toEqual(["bad-batch", "good-batch"]); });
  expect(health.problem).toMatchObject({ kind: "rejected-batch", repair: "repaired" });
  expect(snapshotCalls).toBe(1);
});
