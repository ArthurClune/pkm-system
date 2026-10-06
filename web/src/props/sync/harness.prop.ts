// pattern: Imperative Shell
// Self-tests for the harness client and its faulty transport, against the
// real proptest server (run through proptest/check.sh web).
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { BatchId, BlockUid, ClientId, OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { BAD_UID, SEED_PAGE } from "./arbitraries";
import { startClient, type HarnessClient } from "./harnessClient";
import { quiesce } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";
import { createTransport, withWindowLimit } from "./transport";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("sync harness");

let server: ServerControl;
let clients: HarnessClient[] = [];

beforeAll(async () => {
  server = await connectServer();
});

beforeEach(async () => {
  await server.reset();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.dispose()));
  clients = [];
});

async function start(name: string, windowLimit?: number): Promise<HarnessClient> {
  const c = await startClient(name, server, undefined, { windowLimit });
  clients.push(c);
  return c;
}

const setText = (uid: string, text: string): BlockOp[] =>
  [{ op: "update_text", uid: uid as BlockUid, text }];

const pendingRows = (c: HarnessClient): number =>
  c.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM pending_ops")[0].n;

const blockText = (c: HarnessClient, uid: string): string | undefined =>
  c.db.select<{ text: string }>(
    "SELECT text FROM blocks WHERE uid = ?", [uid])[0]?.text;

const appliedIds = async (): Promise<BatchId[]> =>
  (await server.applied()).map((row) => row.batch_id);

/** Drain and pull every client until nothing is pending anywhere and every
 * cursor has reached the server's latest seq. */
async function settle(cs: HarnessClient[], limitMs = 20_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    for (const c of cs) {
      await c.queue.drain();
      await c.pull();
    }
    const latest = await server.latestSeq();
    if (cs.every((c) => pendingRows(c) === 0 && c.unsentInMemory() === 0 &&
                        c.cursor() === latest)) return;
    if (Date.now() > deadline) throw new Error("clients did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("two clients converge on one edit", async () => {
  const a = await start("A");
  const b = await start("B");
  await a.edit(setText("pt_seed_1", "from A"));
  await a.queue.drain();
  await b.pull();
  expect(blockText(a, "pt_seed_1")).toBe("from A");
  expect(blockText(b, "pt_seed_1")).toBe("from A");
});

test("dropAck redelivers once", async () => {
  const a = await start("A");
  a.transport.arm("dropAck");
  const id = await a.edit(setText("pt_seed_1", "dropped ack"));
  // Redeliver before any pull: a window would name the committed batch as
  // applied, and the replica would settle it without a second send.
  await a.queue.drain();
  await a.queue.drain();
  await settle([a]);
  expect((await appliedIds()).filter((x) => x === id)).toEqual([id]);
  expect(pendingRows(a)).toBe(0);
  expect(a.transport.committed.has(id)).toBe(true);
  // The fault fired: the first send lost its ack, so the batch went twice.
  expect(a.transport.sends(id)).toBe(2);
});

test("dropAck applies to fetchJson posts too", async () => {
  const a = await start("A");
  // The transport stays up, so the queue holds the batch and only the
  // recovery flush can post it.
  a.queue.setOnline(false);
  const id = await a.edit(setText("pt_seed_2", "flushed by recovery"));
  await server.rotateGeneration();
  a.transport.arm("dropAck");
  await a.pull();
  // The flush posted through fetchJson and lost its ack: committed, but the
  // row is still queued.
  expect(await appliedIds()).toContain(id);
  expect(a.transport.committed.has(id)).toBe(true);
  expect(pendingRows(a)).toBe(1);
  await a.online();
  await settle([a]);
  expect((await appliedIds()).filter((x) => x === id)).toEqual([id]);
  expect(pendingRows(a)).toBe(0);
  expect(blockText(a, "pt_seed_2")).toBe("flushed by recovery");
});

test("duplicate is inert", async () => {
  const a = await start("A");
  a.transport.arm("duplicate");
  const id = await a.edit(setText("pt_seed_3", "sent twice"));
  await settle([a]);
  expect((await appliedIds()).filter((x) => x === id)).toEqual([id]);
  expect(pendingRows(a)).toBe(0);
  // The fault fired: one request went out twice, and the replay ack was
  // enough to settle it.
  expect(a.transport.sends(id)).toBe(2);
});

test("edits started together each get their own batch id", async () => {
  const a = await start("A");
  a.offline();
  const [first, second] = await Promise.all([
    a.edit(setText("pt_seed_1", "first")),
    a.edit(setText("pt_seed_2", "second")),
  ]);
  expect([first, second]).toEqual(a.enqueued);
  expect(first).not.toBe(second);
  const rows = a.db.select<{ batch_id: string; ops_json: string }>(
    "SELECT batch_id, ops_json FROM pending_ops ORDER BY id");
  expect(rows.map((r) => r.batch_id)).toEqual([first, second]);
  expect(rows[0].ops_json).toContain("first");
  expect(rows[1].ops_json).toContain("second");
});

test("writeFails goes through the lane", async () => {
  const a = await start("A");
  a.failNextWrite();
  const id = await a.edit(setText("pt_seed_4", "lane"));
  expect(a.unsentInMemory()).toBe(1);
  expect(pendingRows(a)).toBe(0);
  await a.queue.drain();
  expect(await appliedIds()).toContain(id);
  expect(a.unsentInMemory()).toBe(0);
});

test("a lane rejection whose repair fails offline is retried on reconnect", async () => {
  const a = await start("A");
  // The repair's authoritative read waits until the link has dropped under it.
  const release = a.transport.stall("/api/block/");
  a.failNextWrite();
  const bad = await a.edit([{
    op: "create", uid: BAD_UID as BlockUid, page_title: SEED_PAGE,
    parent_uid: null, order_idx: 60 as OrderIdx, text: "a create of a live uid",
  }]);
  expect(a.unsentInMemory()).toBe(1);
  await a.queue.drain();
  expect(a.desyncs).toHaveLength(1);
  a.offline();
  release();
  const repairOutcomes = (): string[] => a.syncEvents
    .filter((e) => e.type === "legacy-repair-failed" ||
                   e.type === "legacy-repair-succeeded")
    .map((e) => e.type);
  await vi.waitFor(() => {
    expect(repairOutcomes()).toEqual(["legacy-repair-failed"]);
  });
  const later = await a.edit(setText("pt_seed_1", "behind the failed repair"));

  // The reconnect alone reruns the repair and releases the later edit;
  // quiesce's own online() would be a second reconnect.
  await a.online();
  expect(repairOutcomes()).toEqual(["legacy-repair-failed", "legacy-repair-succeeded"]);
  await a.queue.drain();
  expect(await appliedIds()).toContain(later);
  expect(await appliedIds()).not.toContain(bad);
  await quiesce([a], server, 5_000);
});

test("reload keeps pending ops", async () => {
  const a = await start("A");
  a.offline();
  const id = await a.edit(setText("pt_seed_5", "survives reload"));
  expect(pendingRows(a)).toBe(1);
  await a.reload();
  expect(pendingRows(a)).toBe(1);
  await a.online();
  await settle([a]);
  expect((await appliedIds()).filter((x) => x === id)).toEqual([id]);
  expect(a.enqueued).toEqual([id]);
});

test("reload severs the old life", async () => {
  const a = await start("A");
  const oldReplica = a.replica;
  const oldQueue = a.queue;
  await a.reload();
  expect(a.replica).not.toBe(oldReplica);
  expect(a.queue).not.toBe(oldQueue);
  // The old facade's port is closed: a stray RPC rejects instead of reaching
  // the shared database.
  await expect(oldReplica.pendingCount()).rejects.toThrow();
  // The new life works over the same database.
  const id = await a.edit(setText("pt_seed_1", "after reload"));
  await settle([a]);
  expect(await appliedIds()).toContain(id);
});

test("a reply arriving after a new life is a network error, but is recorded", async () => {
  const t = createTransport(server);
  const life = t.newLife();
  const body = {
    client_id: "proptest-raw" as ClientId, batch_id: "raw-batch-1" as BatchId,
    ops: setText("pt_seed_1", "old life"),
  };
  const sent = life.post(body);
  t.newLife();
  await expect(sent).rejects.toThrow(TypeError);
  expect(t.committed.get(body.batch_id)).toBe(JSON.stringify(body));
  expect(await appliedIds()).toContain(body.batch_id);
  // A severed life sends nothing.
  await expect(life.post({ ...body, batch_id: "raw-batch-2" as BatchId }))
    .rejects.toThrow(TypeError);
  expect(await appliedIds()).not.toContain("raw-batch-2");
});

test("a window limit goes on changes-feed requests only", () => {
  expect(withWindowLimit("/api/sync/changes?since=3", 2))
    .toBe("/api/sync/changes?since=3&limit=2");
  expect(withWindowLimit("/api/sync/changes", 1)).toBe("/api/sync/changes?limit=1");
  expect(withWindowLimit("/api/sync/snapshot?pending=x", 1))
    .toBe("/api/sync/snapshot?pending=x");
  expect(withWindowLimit("/api/sync/changes?since=3", undefined))
    .toBe("/api/sync/changes?since=3");
});

test("a client pulling one journal row per window still catches up", async () => {
  const t = createTransport(server, undefined, { windowLimit: 1 });
  const feed = await t.fetchJson("/api/sync/changes?since=0") as
    { next_since: number; latest_seq: number };
  expect(feed.next_since).toBe(Math.min(1, feed.latest_seq));
  const a = await start("A");
  const b = await start("B", 1);
  await a.edit(setText("pt_seed_1", "one"));
  await a.edit(setText("pt_seed_2", "two"));
  await settle([a, b]);
  expect(b.cursor()).toBe(await server.latestSeq());
  expect(blockText(b, "pt_seed_2")).toBe("two");
});

test("offline sends nothing and keeps the armed fault", async () => {
  const t = createTransport(server);
  t.setOffline(true);
  t.arm("lostPull");
  await expect(t.fetchJson("/api/sync/snapshot")).rejects.toThrow(TypeError);
  t.setOffline(false);
  await expect(t.fetchJson("/api/sync/snapshot")).rejects.toThrow(TypeError);
  await expect(t.fetchJson("/api/sync/snapshot")).resolves.toBeTruthy();
});

test("dropBatch fakes an ack without sending", async () => {
  const t = createTransport(server, "dropBatch");
  const body = {
    client_id: "proptest-raw" as ClientId, batch_id: "raw-batch-3" as BatchId,
    ops: setText("pt_seed_1", "never sent"),
  };
  const ack = await t.post(body);
  expect(ack.ok).toBe(true);
  expect(await appliedIds()).not.toContain(body.batch_id);
  expect(t.committed.has(body.batch_id)).toBe(false);
});
