// pattern: Imperative Shell
// Does the oracle have teeth? Each deliberately broken transport or server must
// make checkQuiescent fail with the invariant that exists to catch it; a clean
// run and a correctly handled bad batch must pass. If a broken scenario passes,
// the oracle is blind and the gate fails before the property runs.
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { BatchId } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { FIXTURE_PAGE } from "./arbitraries";
import { startClient, type HarnessClient } from "./harnessClient";
import { checkQuiescent, CursorWatch, OracleError, type Expectation,
         type Invariant } from "./oracle";
import { quiesce, QuiesceError } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";
import type { Broken } from "./transport";
import { captureFaultWarnings } from "../warningsCapture";
import { uidOf, orderIdxOf, seqOf } from "../../test-helpers";

captureFaultWarnings("sync teeth");

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

async function start(name: string, broken?: Broken): Promise<HarnessClient> {
  const c = await startClient(name, server, broken);
  clients.push(c);
  return c;
}

const setText = (name: string, text: string): BlockOp[] =>
  [{ op: "update_text", uid: uidOf(name), text }];

/** The fixed command list every teeth scenario runs: A edits twice, B edits
 * once, both pull, then quiescence. Each client's delivery is awaited before
 * the next client acts, so a broken mode on A always meets A's two edits,
 * and A's first changes window always carries B's edit. */
async function scenario(broken?: Broken): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation;
}> {
  const a = await start("A", broken);
  const b = await start("B");
  const a1 = await a.edit(setText("pt_seed_1", "A one"));
  const a2 = await a.edit(setText("pt_seed_2", "A two"));
  await a.queue.drain();
  const b1 = await b.edit(setText("pt_seed_3", "B one"));
  await b.queue.drain();
  await a.pull();
  await b.pull();
  await quiesce([a, b], server);
  return {
    a, b,
    exp: { good: new Map([["A", [a1, a2]], ["B", [b1]]]), bad: new Set() },
  };
}

/** The invariants checkQuiescent reported, or [] when it passed. Logged, so
 * a run shows everything each scenario tripped, not just the one asserted. */
async function failures(
  label: string, run: Promise<void>,
): Promise<Invariant[]> {
  try {
    await run;
    console.log(`teeth ${label}: passed`);
    return [];
  } catch (error: unknown) {
    if (!(error instanceof OracleError)) throw error;
    console.log(`teeth ${label}: tripped ${error.failed.join(", ")}\n${error.message}`);
    return error.failed;
  }
}

test("clean run passes", async () => {
  const { a, b, exp } = await scenario();
  expect(await failures("clean", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("dropBatch trips accounting", async () => {
  const { a, b, exp } = await scenario("dropBatch");
  expect(await failures("dropBatch", checkQuiescent([a, b], server, exp)))
    .toContain("accounting");
});

test("reidBatch trips accounting", async () => {
  const { a, b, exp } = await scenario("reidBatch");
  expect(await failures("reidBatch", checkQuiescent([a, b], server, exp)))
    .toContain("accounting");
});

test("holdBatch trips per-client order", async () => {
  const { a, b, exp } = await scenario("holdBatch");
  expect(await failures("holdBatch", checkQuiescent([a, b], server, exp)))
    .toContain("per-client order");
});

test("skipWindow trips convergence", async () => {
  const { a, b, exp } = await scenario("skipWindow");
  expect(await failures("skipWindow", checkQuiescent([a, b], server, exp)))
    .toContain("convergence");
});

test("a tampered committed body trips serial replay", async () => {
  const { a, b, exp } = await scenario();
  const [a1] = exp.good.get("A") ?? [];
  const committed = new Map<BatchId, string>([
    ...a.transport.committed, ...b.transport.committed,
  ]);
  const body = committed.get(a1);
  expect(body).toContain("A one");
  committed.set(a1, (body ?? "").replace("A one", "tampered"));
  expect(await failures("tampered",
                        checkQuiescent([a, b], server, exp, { committed })))
    .toContain("serial replay");
});

/** A renames Second to Third between two of its batches, pulls it, and the
 * second batch creates on Second, which the server then get_or_creates
 * afresh: where the rename falls among the batches decides which page the
 * create lands on, so a replay that puts it back in the wrong place, or not
 * at all, builds a different graph. */
async function renameScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation; committed: Map<BatchId, string>;
}> {
  const a = await start("A");
  const b = await start("B");
  const a1 = await a.edit(setText("pt_sec_1", "before the rename"));
  await a.queue.drain();
  await a.transport.fetchJson(`/api/page/${encodeURIComponent("Second")}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_title: "Third", allow_merge: false }),
  });
  await a.pull();
  const a2 = await a.edit([{
    op: "create", uid: uidOf("pt_A_1"), page_title: "Second",
    parent_uid: null, order_idx: orderIdxOf(0), text: "on a new Second",
  }]);
  await a.queue.drain();
  await quiesce([a, b], server);
  return {
    a, b,
    exp: { good: new Map([["A", [a1, a2]], ["B", []]]), bad: new Set() },
    committed: new Map([...a.transport.committed, ...b.transport.committed]),
  };
}

test("a run with a rename replays clean", async () => {
  const { a, b, exp } = await renameScenario();
  expect((await server.renames()).map((r) => r.new_title)).toEqual(["Third"]);
  expect(await failures("rename", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("an omitted rename trips serial replay", async () => {
  const { a, b, exp, committed } = await renameScenario();
  expect(await failures("omitted rename",
                        checkQuiescent([a, b], server, exp, { committed, renames: [] })))
    .toContain("serial replay");
});

test("a rename replayed after the wrong batch trips serial replay", async () => {
  const { a, b, exp, committed } = await renameScenario();
  const [rename] = await server.renames();
  const [, a2] = exp.good.get("A") ?? [];
  expect(rename.after_batch_id).not.toBe(a2);
  expect(await failures("misplaced rename", checkQuiescent(
    [a, b], server, exp, { committed, renames: [{ ...rename, after_batch_id: a2 }] })))
    .toContain("serial replay");
});

/** B deletes Second while A, offline, has two batches made before it: a
 * split that copies a link to Second onto a new Proptest block, and a
 * top-level create on Second whose text links it. Both come back stale for
 * Second, so the server must unlink the links and park the create, and
 * Second stays deleted. */
async function staleDeleteScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation;
}> {
  const a = await start("A");
  const b = await start("B");
  a.offline();
  const a1 = await a.edit([
    { op: "update_text", uid: uidOf("pt_seed_1"), text: "left [[Second]]" },
    { op: "create", uid: uidOf("pt_A_1"), page_title: "Proptest", parent_uid: null,
      order_idx: orderIdxOf(5), text: "right [[Second]]" },
  ]);
  const a2 = await a.edit([{
    op: "create", uid: uidOf("pt_A_2"), page_title: "Second", parent_uid: null,
    order_idx: orderIdxOf(0), text: "parked [[Second]]",
  }]);
  await b.transport.fetchJson("/api/page/Second", { method: "DELETE" });
  await a.online();
  await a.queue.drain();
  await quiesce([a, b], server);
  expect((await server.deletes()).map((d) => d.title)).toEqual(["Second"]);
  return {
    a, b,
    exp: { good: new Map([["A", [a1, a2]], ["B", []]]), bad: new Set() },
  };
}

const pageTitles = async (): Promise<string[]> =>
  (await server.snapshot()).pages.map((p) => p.title);

test("a run where stale batches meet a page delete replays clean", async () => {
  const { a, b, exp } = await staleDeleteScenario();
  expect(await pageTitles()).not.toContain("Second");
  expect(await failures("stale delete", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("stale batches re-creating a deleted page trip delete wins", async () => {
  // The server as it was before stale batches: every batch is fresh.
  await server.setStaleTeeth(true);
  const { a, b, exp } = await staleDeleteScenario();
  expect(await pageTitles()).toContain("Second");
  expect(await failures("stale teeth", checkQuiescent([a, b], server, exp)))
    .toContain("delete wins");
});

/** A, offline, links Second from pt_sec_1, a block on Second, and B
 * deletes Second. The edit's block is gone, so the server parks its text on
 * the daily page, and the batch is stale for Second, so the parked text
 * links nothing: Second stays deleted. */
async function orphanEditScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation;
}> {
  const a = await start("A");
  const b = await start("B");
  a.offline();
  const a1 = await a.edit(setText("pt_sec_1", "parked [[Second]]"));
  await b.transport.fetchJson("/api/page/Second", { method: "DELETE" });
  await a.online();
  await a.queue.drain();
  await quiesce([a, b], server);
  expect((await server.deletes()).map((d) => d.title)).toEqual(["Second"]);
  expect((await server.snapshot()).blocks.some((blk) => blk.text.startsWith("parked ")))
    .toBe(true);
  return {
    a, b,
    exp: { good: new Map([["A", [a1]], ["B", []]]), bad: new Set() },
  };
}

test("a stale edit of a block on the deleted page parks its text unlinked", async () => {
  const { a, b, exp } = await orphanEditScenario();
  expect(await pageTitles()).not.toContain("Second");
  expect(await failures("stale orphan edit", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("a parked stale edit re-creating a deleted page trips delete wins", async () => {
  await server.setStaleTeeth(true);
  const { a, b, exp } = await orphanEditScenario();
  expect(await pageTitles()).toContain("Second");
  expect(await failures("stale orphan teeth", checkQuiescent([a, b], server, exp)))
    .toContain("delete wins");
});

/** B, the only client to write pt_seed_1, links Second there; offline, it
 * edits the block again, A renames Second to Third, and B edits once more
 * before it sees the rename. B's first offline edit is replayed through the
 * rename. The second is hashed against the text the first sent, so it lands
 * clean only if the server recorded what that replay wrote. */
async function chainedEditScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation;
}> {
  const a = await start("A");
  const b = await start("B");
  const b1 = await b.edit(setText("pt_seed_1", "[[Second]] one"));
  await b.queue.drain();
  b.offline();
  const b2 = await b.edit(setText("pt_seed_1", "[[Second]] two"));
  await a.transport.fetchJson(`/api/page/${encodeURIComponent("Second")}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_title: "Third", allow_merge: false }),
  });
  const b3 = await b.edit(setText("pt_seed_1", "[[Second]] three"));
  await b.online();
  await b.queue.drain();
  await quiesce([a, b], server);
  return {
    a, b,
    exp: { good: new Map([["A", []], ["B", [b1, b2, b3]]]), bad: new Set() },
  };
}

test("a device's edit chain across a rename lands clean", async () => {
  const { a, b, exp } = await chainedEditScenario();
  const text = (await server.snapshot()).blocks.find((blk) => blk.uid === "pt_seed_1")?.text;
  expect(text).toBe("[[Third]] three");
  expect(await server.conflicts()).toEqual([]);
  expect(await failures("chained edits", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("a chain that loses the replay's rewrite rows trips conflict noise", async () => {
  // The server as it was before replays recorded what they wrote.
  await server.setRewriteTeeth(true);
  const { a, b, exp } = await chainedEditScenario();
  expect((await server.conflicts()).map((c) => c.text)).toEqual(
    ["[[conflict]] [[Proptest]] — overwritten by ((pt_seed_1))"]);
  expect(await failures("rewrite teeth", checkQuiescent([a, b], server, exp)))
    .toContain("conflict noise");
});

test("a client's own edit after its lane write is not conflict noise", async () => {
  // The failed local write goes out from the lane unhashed and never reaches
  // the replica, so the next edit is hashed against the text before it and
  // conflicts with A's own lane text: the one single-device conflict the
  // invariant allows.
  const a = await start("A");
  a.failNextWrite();
  const a1 = await a.edit(setText("pt_seed_4", "from the lane"));
  const a2 = await a.edit(setText("pt_seed_4", "durable"));
  await quiesce([a], server);
  expect(a.laneBatches).toEqual([a1]);
  expect((await server.conflicts()).map((c) => c.text)).toEqual(
    ["[[conflict]] [[Proptest]] — overwritten by ((pt_seed_4))"]);
  const exp: Expectation = { good: new Map([["A", [a1, a2]]]), bad: new Set() };
  expect(await failures("lane", checkQuiescent([a], server, exp))).toEqual([]);
});

/** B deletes Second; A pulls the delete and only then creates on Second,
 * which may re-create it. */
async function freshRecreateScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; exp: Expectation;
}> {
  const a = await start("A");
  const b = await start("B");
  await b.transport.fetchJson("/api/page/Second", { method: "DELETE" });
  await a.pull();
  const a1 = await a.edit([{
    op: "create", uid: uidOf("pt_A_1"), page_title: "Second", parent_uid: null,
    order_idx: orderIdxOf(0), text: "after the delete",
  }]);
  await a.queue.drain();
  await quiesce([a, b], server);
  return {
    a, b,
    exp: { good: new Map([["A", [a1]], ["B", []]]), bad: new Set() },
  };
}

test("a page re-created by a batch that had seen its delete passes", async () => {
  const { a, b, exp } = await freshRecreateScenario();
  expect(await pageTitles()).toContain("Second");
  expect(await failures("fresh re-create", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("a replay that ignores the delete record's seqs trips serial replay", async () => {
  // Seqs past every batch's seen_seq: the replay maps A's seen_seq to before
  // the delete, so A's create is stale there and parks instead.
  const { a, b, exp } = await freshRecreateScenario();
  const deletes = (await server.deletes()).map((d) => ({ ...d, seq: seqOf(d.seq + 1000) }));
  expect(await failures("shifted delete seqs", checkQuiescent([a, b], server, exp, { deletes })))
    .toContain("serial replay");
});

test("quiesce reports liveness failure", async () => {
  const a = await start("A");
  a.offline();
  await a.edit(setText("pt_seed_1", "never delivered"));
  const started = Date.now();
  const settling = quiesce([a], server, 1_500);
  // quiesce has put the client online; the network goes down again under it.
  a.transport.setOffline(true);
  const error = await settling.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(QuiesceError);
  expect(String(error)).toMatch(/did not settle in 1500ms/);
  expect(String(error)).toMatch(/A: pending 1/);
  expect(Date.now() - started).toBeLessThan(10_000);
});

/** A enqueues a good batch and then a create of pt_seed_6, which is live on
 * the server for the whole example, so the server rejects it with a 400. */
async function badBatchScenario(): Promise<{
  a: HarnessClient; b: HarnessClient; good: BatchId; bad: BatchId; b1: BatchId;
}> {
  const a = await start("A");
  const b = await start("B");
  const good = await a.edit(setText("pt_seed_1", "good before bad"));
  const bad = await a.edit([{
    op: "create", uid: uidOf("pt_seed_6"), page_title: FIXTURE_PAGE,
    parent_uid: null, order_idx: orderIdxOf(60), text: "a create of a live uid",
  }]);
  const b1 = await b.edit(setText("pt_seed_2", "B alongside"));
  await quiesce([a, b], server);
  return { a, b, good, bad, b1 };
}

test("quiesce bounds a hung network", async () => {
  // A network that takes requests and never answers: no step of quiesce may
  // wait on it past the limit.
  const a = await start("A");
  a.offline();
  await a.edit(setText("pt_seed_1", "stuck behind a hung network"));
  a.transport.stall("");
  const started = Date.now();
  const error = await quiesce([a], server, 1_500).then(() => null, (e: unknown) => e);
  console.log(`teeth hung network: ${String(error)}`);
  expect(error).toBeInstanceOf(QuiesceError);
  expect(String(error)).toMatch(/did not settle in 1500ms \(.* hung\)/);
  expect(String(error)).toMatch(/A: pending 1, poisoned 0, lane 0/);
  expect(Date.now() - started).toBeLessThan(1_500 + 2_000);
});

test("quiesce bounds a hung round", async () => {
  // Going online finishes; then a pull inside a round never returns.
  const a = await start("A");
  a.pull = () => new Promise<void>(() => undefined);
  const error = await quiesce([a], server, 1_500).then(() => null, (e: unknown) => e);
  console.log(`teeth hung round: ${String(error)}`);
  expect(error).toBeInstanceOf(QuiesceError);
  expect(String(error)).toMatch(/did not settle in 1500ms \(a drain, pull or read hung\)/);
});

test("bad batch is poisoned and repaired", async () => {
  const { a, b, good, bad, b1 } = await badBatchScenario();
  expect(a.poisoned).toContain(bad);
  expect((await server.applied()).map((r) => r.batch_id)).not.toContain(bad);
  const exp: Expectation = {
    good: new Map([["A", [good]], ["B", [b1]]]), bad: new Set([bad]),
  };
  expect(await failures("bad batch", checkQuiescent([a, b], server, exp)))
    .toEqual([]);
});

test("quiesce waits for a lone client's poison repair", async () => {
  // No other traffic: the rejection moves no seq, so only the poisoned row
  // shows that the repair has not finished. The repair's delete of that row,
  // which follows its rebase, is held for a while, so a quiesce that ignores
  // the row returns mid-repair.
  const a = await start("A");
  const replica = a.replica;
  const deleteBatch = replica.deleteBatch.bind(replica);
  replica.deleteBatch = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return deleteBatch(...args);
  };
  const bad = await a.edit([{
    op: "create", uid: uidOf("pt_seed_6"), page_title: FIXTURE_PAGE,
    parent_uid: null, order_idx: orderIdxOf(60), text: "a create of a live uid",
  }]);
  await quiesce([a], server);
  expect(await a.replica.poisonedBatches()).toEqual([]);
  expect(a.poisoned).toEqual([bad]);
  const exp: Expectation = { good: new Map([["A", []]]), bad: new Set([bad]) };
  expect(await failures("lone bad batch", checkQuiescent([a], server, exp)))
    .toEqual([]);
});

test("an unexpected poison trips desync/poison", async () => {
  const { a, b, good, b1 } = await badBatchScenario();
  const exp: Expectation = { good: new Map([["A", [good]], ["B", [b1]]]), bad: new Set() };
  expect(await failures("unexpected poison", checkQuiescent([a, b], server, exp)))
    .toContain("desync/poison");
});

test("conflict copies replay equal", async () => {
  // Both clients edit the same block from the same base: the second commit
  // lands the lost text under a conflict header whose uids the server mints
  // at random, so the replay mints different ones for the same blocks.
  const a = await start("A");
  const b = await start("B");
  a.offline();
  b.offline();
  const a1 = await a.edit(setText("pt_seed_1", "A's version"));
  const b1 = await b.edit(setText("pt_seed_1", "B's version"));
  await a.online();
  await a.queue.drain();
  await b.online();
  await b.queue.drain();
  await quiesce([a, b], server);
  const snap = await server.snapshot();
  expect(snap.blocks.some((blk) => blk.text.includes("[[conflict]]"))).toBe(true);
  const exp: Expectation = { good: new Map([["A", [a1]], ["B", [b1]]]), bad: new Set() };
  expect(await failures("conflict", checkQuiescent([a, b], server, exp))).toEqual([]);
});

test("CursorWatch throws on a cursor that goes back", async () => {
  const a = await start("A");
  const watch = new CursorWatch();
  watch.observe([a]);
  await a.edit(setText("pt_seed_1", "moves the cursor"));
  await quiesce([a], server);
  watch.observe([a]);
  a.db.exec("UPDATE sync_client_meta SET value = '0' WHERE key = 'cursor'");
  expect(() => watch.observe([a])).toThrow(/cursor monotonic: A went from \d+ to 0/);
});
