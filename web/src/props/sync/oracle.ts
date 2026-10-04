// pattern: Imperative Shell
// The sync oracle, run once the clients are quiescent. It gathers the
// server's and every replica's state, evaluates every invariant (it never
// stops at the first failure), and throws one OracleError naming each one
// that failed, with the evidence:
//   convergence       each replica's graph equals the server's snapshot
//   accounting        applied_batches holds exactly the expected batches,
//                     no rejected batch, every rejected batch was reported
//                     as poisoned, and no pending or poisoned rows remain
//   per-client order  each client's batches landed in its enqueue order
//   desync/poison     no onDesync, and onPoison only for expected rejections
//   serial replay     replaying the recorded bodies in commit order, each at
//                     its applied_at, with every page rename put back after
//                     the batch it followed, at the clock it ran at, on a
//                     fresh server reproduces the graph
// The serial replay resets the server, so the faulted run's snapshot,
// applied list and renames are read before it, and afterwards the server
// holds the replay's state.
// CursorWatch is the sixth check, run after every command rather than here.
import type { BatchId, SyncSeq } from "../../api/brands";
import type { HarnessClient } from "./harnessClient";
import { canonicaliseMintedUids, diffGraphs, fromReplica, fromSnapshot,
         type NormalGraph, opUids } from "./normalise";
import type { RenameRecord, ServerControl } from "./serverControl";

export type Invariant =
  | "convergence" | "accounting" | "per-client order" | "desync/poison"
  | "serial replay";

export class OracleError extends Error {
  override name = "OracleError";
  constructor(readonly failed: Invariant[], message: string) {
    super(message);
  }
}

export interface Expectation {
  /** Client name -> the batch ids it enqueued that must land, in order. */
  good: Map<string, BatchId[]>;
  /** Batch ids the server must reject (and the client repair). */
  bad: Set<BatchId>;
}

export interface CheckOptions {
  /** The recorded POST /api/ops bodies the serial replay posts; by default
   * the union of the clients' transports' records. */
  committed?: ReadonlyMap<BatchId, string>;
  /** The page renames the serial replay puts back; by default the
   * server's record of them. */
  renames?: readonly RenameRecord[];
}

type Applied = { batch_id: BatchId; applied_at: number }[];

/** One invariant's findings: an empty list means it held. */
type Findings = string[];

const list = (ids: Iterable<string>): string => [...ids].join(", ");

function convergence(clients: HarnessClient[], server: NormalGraph): Findings {
  return clients.flatMap((c) => {
    const diff = diffGraphs(fromReplica(c.db), server, [`replica ${c.name}`, "server"]);
    return diff === null ? [] : [`client ${c.name} differs from the server:\n${diff}`];
  });
}

async function accounting(clients: HarnessClient[], applied: Applied,
                          exp: Expectation): Promise<Findings> {
  const out: Findings = [];
  const landed = new Set(applied.map((r) => r.batch_id));
  const expected = new Set([...exp.good.values()].flat());
  const missing = [...expected].filter((id) => !landed.has(id));
  const extra = [...landed].filter((id) => !expected.has(id));
  if (missing.length > 0) out.push(`expected but not applied: ${list(missing)}`);
  if (extra.length > 0) out.push(`applied but not expected: ${list(extra)}`);
  const rejectedLanded = [...exp.bad].filter((id) => landed.has(id));
  if (rejectedLanded.length > 0) {
    out.push(`expected rejected but applied: ${list(rejectedLanded)}`);
  }
  for (const id of exp.bad) {
    const owner = clients.find((c) => c.enqueued.includes(id));
    if (!owner) out.push(`expected rejection ${id} was never enqueued by any client`);
    else if (!owner.poisoned.includes(id)) {
      out.push(`expected rejection ${id} was never reported poisoned by ${owner.name}`);
    }
  }
  for (const c of clients) {
    const pending = await c.replica.pendingCount();
    if (pending > 0) out.push(`client ${c.name} still has pending rows: ${pending}`);
    const poisoned = await c.replica.poisonedBatches();
    if (poisoned.length > 0) {
      out.push(`client ${c.name} still has poisoned rows: ` +
               list(poisoned.map((p) => p.batch_id)));
    }
    if (c.unsentInMemory() > 0) {
      out.push(`client ${c.name} still has lane entries: ${c.unsentInMemory()}`);
    }
  }
  return out;
}

/** Only the relative order of the batches that did land: a missing batch is
 * accounting's finding. */
function perClientOrder(applied: Applied, exp: Expectation): Findings {
  const landed = applied.map((r) => r.batch_id);
  const landedSet = new Set(landed);
  return [...exp.good].flatMap(([name, ids]) => {
    const mine = new Set(ids);
    const actual = landed.filter((id) => mine.has(id));
    const wanted = ids.filter((id) => landedSet.has(id));
    return actual.join() === wanted.join()
      ? []
      : [`client ${name} enqueued ${list(wanted)} but they landed as ${list(actual)}`];
  });
}

function desyncPoison(clients: HarnessClient[], exp: Expectation): Findings {
  return clients.flatMap((c) => [
    ...c.desyncs.map((e) => `client ${c.name} reported a desync: ${String(e)}`),
    ...c.poisoned.filter((id) => !exp.bad.has(id))
      .map((id) => `client ${c.name} reported ${id} poisoned, which was not expected`),
  ]);
}

async function serialReplay(server: ServerControl, applied: Applied,
                            faulted: Awaited<ReturnType<ServerControl["snapshot"]>>,
                            committed: ReadonlyMap<BatchId, string>,
                            renames: readonly RenameRecord[]): Promise<Findings> {
  const unrecorded = applied.filter((r) => !committed.has(r.batch_id));
  if (unrecorded.length > 0) {
    return [`no recorded body for applied batches: ${list(unrecorded.map((r) => r.batch_id))}`];
  }
  const landed = new Set<BatchId | null>([null, ...applied.map((r) => r.batch_id)]);
  const stray = renames.filter((r) => !landed.has(r.after_batch_id));
  if (stray.length > 0) {
    return [`renames after a batch that never applied: ${
      list(stray.map((r) => `${r.old_title} -> ${r.new_title} after ${r.after_batch_id}`))}`];
  }
  const out: Findings = [];
  await server.reset();
  // Uids the clients chose, and the template's; the server mints the rest at
  // random, differently on each run, so those are compared by position.
  const known = new Set<string>((await server.snapshot()).blocks.map((b) => b.uid));
  for (const row of applied) {
    for (const uid of opUids(committed.get(row.batch_id) ?? "{}")) known.add(uid);
  }
  // A rename is no batch: it goes back between the two batches it fell
  // between in the faulted run, in the order the renames committed.
  const renamesAfter = async (batch: BatchId | null): Promise<void> => {
    for (const r of renames.filter((x) => x.after_batch_id === batch)) {
      await server.setClock(r.at);
      const res = await server.postRename(r.old_title, r.new_title);
      if (!res.ok) {
        out.push(`replaying rename ${r.old_title} -> ${r.new_title} got ${res.status}:` +
                 ` ${await res.text()}`);
      }
    }
  };
  await renamesAfter(null);
  for (const row of applied) {
    await server.setClock(row.applied_at);
    const res = await server.postRaw(committed.get(row.batch_id) ?? "");
    if (!res.ok) out.push(`replaying ${row.batch_id} got ${res.status}: ${await res.text()}`);
    await renamesAfter(row.batch_id);
  }
  const replayed = await server.snapshot();
  const diff = diffGraphs(
    canonicaliseMintedUids(fromSnapshot(faulted, { timestamps: true }), known),
    canonicaliseMintedUids(fromSnapshot(replayed, { timestamps: true }), known),
    ["faulted run", "serial replay"]);
  if (diff !== null) out.push(`the replay's graph differs:\n${diff}`);
  return out;
}

/** Runs one invariant, turning a throw into a finding so the rest still run. */
async function evaluate(run: () => Findings | Promise<Findings>): Promise<Findings> {
  try {
    return await run();
  } catch (error: unknown) {
    return [`the check itself threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`];
  }
}

export async function checkQuiescent(clients: HarnessClient[], server: ServerControl,
                                     exp: Expectation, opts: CheckOptions = {}): Promise<void> {
  const faulted = await server.snapshot();
  const applied = await server.applied();
  const renames = opts.renames ?? await server.renames();
  const committed = opts.committed ?? new Map(
    clients.flatMap((c) => [...c.transport.committed]));
  const results: [Invariant, Findings][] = [
    ["convergence", await evaluate(() => convergence(clients, fromSnapshot(faulted)))],
    ["accounting", await evaluate(() => accounting(clients, applied, exp))],
    ["per-client order", await evaluate(() => perClientOrder(applied, exp))],
    ["desync/poison", await evaluate(() => desyncPoison(clients, exp))],
    ["serial replay", await evaluate(() => serialReplay(server, applied, faulted, committed, renames))],
  ];
  const failed = results.filter(([, findings]) => findings.length > 0);
  if (failed.length === 0) return;
  throw new OracleError(
    failed.map(([name]) => name),
    `invariants failed: ${failed.map(([name]) => name).join(", ")}\n` +
    failed.map(([name, findings]) => `-- ${name} --\n${findings.join("\n")}`).join("\n"));
}

/** Cursor monotonic: after every command, no client's cursor may be below
 * the highest it has shown, across reloads and recoveries. */
export class CursorWatch {
  private readonly highest = new Map<string, SyncSeq>();

  observe(clients: HarnessClient[]): void {
    for (const c of clients) {
      const now = c.cursor();
      const before = this.highest.get(c.name);
      if (before !== undefined && now < before) {
        throw new Error(`cursor monotonic: ${c.name} went from ${before} to ${now}`);
      }
      if (before === undefined || now > before) this.highest.set(c.name, now);
    }
  }
}
