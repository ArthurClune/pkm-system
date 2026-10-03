// pattern: Imperative Shell
// Does the oracle have teeth? Each deliberately broken transport must make
// checkQuiescent fail with the invariant that exists to catch it; a clean run
// and a correctly handled bad batch must pass. If a broken scenario passes,
// the oracle is blind and the gate fails before the property runs.
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { BatchId, BlockUid, OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { startClient, type HarnessClient } from "./harnessClient";
import { checkQuiescent, CursorWatch, OracleError, type Expectation,
         type Invariant } from "./oracle";
import { quiesce, QuiesceError } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";
import type { Broken } from "./transport";

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

const setText = (uid: string, text: string): BlockOp[] =>
  [{ op: "update_text", uid: uid as BlockUid, text }];

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
    op: "create", uid: "pt_seed_6" as BlockUid, page_title: "Proptest",
    parent_uid: null, order_idx: 60 as OrderIdx, text: "a create of a live uid",
  }]);
  const b1 = await b.edit(setText("pt_seed_2", "B alongside"));
  await quiesce([a, b], server);
  return { a, b, good, bad, b1 };
}

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
