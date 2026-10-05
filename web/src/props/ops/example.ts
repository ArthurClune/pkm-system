// pattern: Imperative Shell
// One example of the ops property: a start state seeded on the harness
// server, then raw batches or outline commands run through the server, the
// replica (optimistic apply, and replay over real feed windows) and the
// in-memory outline trees, checked against each other after every step.
//
// Checks, each reported with its own prefix:
//   check 1    an echo applied to a page's in-memory tree gives the server's
//              tree for that page (every pool page; a command step's own
//              page is check 2's);
//   check 2    a command's resulting tree is the server's tree;
//   check 3    the replica after the optimistic apply (and any replay) is the
//              server's graph;
//   check R    the replica after a feed window is a fresh replica built from
//              the snapshot with the same pending batches enqueued on it;
//   rejection  enqueueBatch refuses a batch for its title syntax exactly
//              when the server does, and never a command batch.
// The only exclusions are the spec's: rows the server minted, a page whose
// echo the session would reload instead of applying, and timestamps.
//
// Pending rows: the harness pulls windows without naming its pending
// batches, so no window lists one in `applied_batches` and applyChanges
// never drops a row. An acked batch's row is deleted here instead, as the
// drain does on the ack (deleteBatch), so the pending set a later step's
// replay and check R see is the unacked batches only. Its effect-ledger
// records stay until the next window at the journal head settles them, as
// in the app.
import type { BatchId, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { applyOpsWithChange, needsAuthoritativeReload } from "../../outline/tree";
import { type ApplyResult, applyChanges, applySnapshot, type Changes,
         type Snapshot } from "../../replica/apply";
import type { ReplicaDb } from "../../replica/db";
import { LocalOpError } from "../../replica/localOps";
import { getMeta } from "../../replica/meta";
import { allBatches, deleteBatch, enqueueBatch } from "../../replica/queue";
import { openTestDb } from "../../replica/testDb";
import { findOpTitleViolation } from "../../replica/titles";
import { runSequence } from "../outline/run";
import { diffGraphs, fromReplica, fromSnapshot, type NormalGraph } from "../sync/normalise";
import type { ServerControl } from "../sync/serverControl";
import { type Example, OPS_PAGES, type RawDraft, rawUidMinter, resolveRaw, seedOps,
         TITLE_POOL } from "./arbitraries";
import { diffTrees, pruneGraph, pruneTree, rankOrder, treesFromSnapshot } from "./compare";

/** The implementations a teeth check swaps for deliberately wrong ones. */
export interface OpsSeam {
  applyEcho(tree: BlockNode[], ops: BlockOp[], title: string): BlockNode[];
  enqueue(db: ReplicaDb, ops: BlockOp[], nowMs: number, batchId: BatchId): void;
  applyWindow(db: ReplicaDb, feed: Changes, nowMs: number): ApplyResult;
}

export const REAL_OPS: OpsSeam = {
  applyEcho: (tree, ops, title) => applyOpsWithChange(tree, ops, title).blocks,
  enqueue: (db, ops, nowMs, batchId) => { enqueueBatch(db, ops, nowMs, batchId); },
  applyWindow: (db, feed, nowMs) => applyChanges(db, feed, nowMs),
};

export interface Tally {
  examples: { raw: number; command: number };
  /** Resolved (raw) or sent (command) ops by kind. */
  opKinds: Record<string, number>;
  /** Raw-batch variations reached. */
  variations: Record<string, number>;
  /** O steps whose window re-shipped a row the pending batches touched,
   * those whose window did not, and O batches the server rejected. */
  others: { touched: number; untouched: number; rejected: number };
  /** Skipped ops by the ack's reason, B's and O's. */
  skipped: Record<string, number>;
  /** Pages set aside because the session would reload them. */
  reloads: number;
  /** B batches the server answered 400, by cause. */
  rejections: { "title syntax": number; other: number };
}

export function newTally(): Tally {
  return {
    examples: { raw: 0, command: 0 },
    opKinds: {},
    variations: {},
    others: { touched: 0, untouched: 0, rejected: 0 },
    skipped: {},
    reloads: 0,
    rejections: { "title syntax": 0, other: 0 },
  };
}

const bump = (r: Record<string, number>, key: string, n = 1): void => {
  r[key] = (r[key] ?? 0) + n;
};

const VARIATIONS = ["cycle", "missing parent", "cross-page create", "cross-page move",
                    "stale text hash", "stale subtree hash", "block named twice",
                    "forbidden title"] as const;

export function showTally(t: Tally): string {
  const row = (r: Record<string, number>): string =>
    Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none";
  return [
    "ops property tally",
    `  examples: raw ${t.examples.raw}, command ${t.examples.command}`,
    `  op kinds: ${row(t.opKinds)}`,
    `  variations: ${VARIATIONS.map((v) => `${v} ${t.variations[v] ?? 0}`).join(", ")}`,
    `  O steps: window re-shipped touched rows ${t.others.touched},` +
      ` did not ${t.others.untouched}, O rejected ${t.others.rejected}`,
    `  skipped ops: ${row(t.skipped)}`,
    `  pages set aside for an authoritative reload: ${t.reloads}`,
    `  rejections: title syntax ${t.rejections["title syntax"]},` +
      ` other ${t.rejections.other}`,
  ].join("\n");
}

const harness = (what: string): Error => new Error(`harness: ${what}`);

type Ack = { applied: number; skipped?: { index: number; op: string; uid: string;
                                           reason: string }[] };
type Posted = { status: 200; ack: Ack } | { status: 400; reason: string };

const isTitleSyntax = (reason: string): boolean => reason.includes("title syntax");

/** POST /api/ops as the queue sends it. 200 and 400 are answers the checks
 * read; anything else (a 409 above all: a reused batch id) is the harness's
 * own fault. */
async function post(server: ServerControl, batchId: BatchId, clientId: string,
                    ops: readonly BlockOp[]): Promise<Posted> {
  let res: Response;
  try {
    res = await server.postRaw(JSON.stringify({ batch_id: batchId, client_id: clientId, ops }));
  } catch (e) {
    throw harness(`POST /api/ops ${batchId} threw: ${String(e)}`);
  }
  const text = await res.text();
  if (res.status === 200) return { status: 200, ack: JSON.parse(text) as Ack };
  if (res.status === 400) {
    const detail = (JSON.parse(text) as { detail?: { reason?: unknown } }).detail;
    return { status: 400, reason: String(detail?.reason ?? text) };
  }
  throw harness(`POST /api/ops ${batchId} answered ${res.status}: ${text}`);
}

/** Every uid a batch creates. */
const createdUids = (ops: readonly BlockOp[]): string[] =>
  ops.flatMap((op) => (op.op === "create" ? [op.uid] : []));

/** Every page title a batch names. */
const namedTitles = (ops: readonly BlockOp[]): string[] =>
  ops.flatMap((op) => ("page_title" in op && typeof op.page_title === "string"
    ? [op.page_title] : []));

const showOps = (ops: readonly BlockOp[]): string =>
  ops.map((op) => JSON.stringify(op)).join("\n      ");

const showAck = (p: Posted): string => p.status === 400
  ? `400 ${p.reason}`
  : `200 applied ${p.ack.applied}, skipped ${JSON.stringify(p.ack.skipped ?? [])}`;

/** Raw-batch variations, as drafted and as resolved against `g`. */
function tallyRaw(t: Tally, drafts: readonly RawDraft[], ops: readonly BlockOp[],
                  g: NormalGraph): void {
  for (const op of ops) bump(t.opKinds, op.op);
  const seen = new Set<string>();
  for (const d of drafts) {
    if ((d.kind === "move") && d.parent.to === "cycle") seen.add("cycle");
    if ((d.kind === "move" || d.kind === "create") && d.parent.to === "missing") {
      seen.add("missing parent");
    }
    if (d.kind === "update_text" && d.hash === "stale") seen.add("stale text hash");
    if (d.kind === "delete" && d.hash === "stale") seen.add("stale subtree hash");
  }
  const pageOf = new Map(g.blocks.map((b) => [b.uid, b.page]));
  const named = new Map<string, number>();
  for (const op of ops) {
    if (op.op === "create_page") continue;
    named.set(op.uid, (named.get(op.uid) ?? 0) + 1);
    if (op.op === "create" && op.parent_uid != null) {
      const parentPage = pageOf.get(op.parent_uid);
      if (parentPage !== undefined && parentPage !== op.page_title) seen.add("cross-page create");
    }
    if (op.op === "move") {
      const own = pageOf.get(op.uid);
      const dest = op.parent_uid != null ? pageOf.get(op.parent_uid)
        : op.page_title ?? own;
      if (own !== undefined && dest !== undefined && own !== dest) seen.add("cross-page move");
    }
  }
  if ([...named.values()].some((n) => n > 1)) seen.add("block named twice");
  if (findOpTitleViolation(ops) !== null) seen.add("forbidden title");
  for (const v of seen) bump(t.variations, v);
}

/** Every uid a batch's ops name, as subject or parent. */
const opUidsOf = (ops: readonly BlockOp[]): string[] => ops.flatMap((op) => {
  if (op.op === "create_page") return [];
  const parent = "parent_uid" in op && typeof op.parent_uid === "string" ? [op.parent_uid] : [];
  return [op.uid, ...parent];
});

export interface RunOptions {
  seam?: OpsSeam;
  tally?: Tally;
  /** Runs once the seed's echo is cleared, before the first step. */
  afterSeed?: () => Promise<void>;
  /** The batch id for the n-th POST of this example (n = 0: the seed). A
   * fixed scenario passes one that repeats to provoke a 409. */
  batchId?: (n: number) => BatchId;
}

let exampleCount = 0;

/** Runs `ex` and returns the problems found at its first failing step (a
 * step header, the steps so far, then one line per difference, each with
 * its check's prefix), or `[]`. A harness fault throws `harness: …`. */
export async function runExample(server: ServerControl, ex: Example,
                                 opts: RunOptions = {}): Promise<string[]> {
  const seam = opts.seam ?? REAL_OPS;
  const tally = opts.tally ?? newTally();
  const example = exampleCount++;
  let posts = 0;
  const nextBatchId = (): BatchId => {
    const n = posts++;
    // Padded: the server wants eight characters at least.
    return opts.batchId ? opts.batchId(n)
      : `ops-${String(example).padStart(3, "0")}-${String(n).padStart(2, "0")}` as BatchId;
  };
  // The replica's clock: never compared, only kept moving.
  let clock = 1_900_000_000_000;
  const now = (): number => clock++;
  tally.examples[ex.kind] += 1;

  const replica = await openTestDb();
  try {
    // Seed.
    await server.reset();
    const seeded = await post(server, nextBatchId(), "ops-seed", seedOps(ex.start));
    if (seeded.status !== 200 || (seeded.ack.skipped ?? []).length > 0) {
      throw harness(`seed batch: ${showAck(seeded)}`);
    }
    const s0 = await server.snapshot();
    applySnapshot(replica.db, s0, now());
    const trees = treesFromSnapshot(s0, TITLE_POOL);
    for (const p of OPS_PAGES) {
      const off = diffTrees(trees.get(p) ?? [], ex.start.pages[p], ["server", "start"]);
      if (off.length > 0) throw harness(`seed of ${p} differs from the start:\n${off.join("\n")}`);
    }
    await server.takeEcho();
    await opts.afterSeed?.();

    const known = new Set<string>(s0.blocks.map((b) => b.uid));
    const keep = new Set<string>(s0.pages.map((p) => p.title));
    const learn = (ops: readonly BlockOp[]): void => {
      for (const u of createdUids(ops)) known.add(u);
      for (const t of namedTitles(ops)) keep.add(t);
    };
    const trace: string[] = [];
    const fail = (header: string, problems: string[]): string[] =>
      [header, ...trace, ...problems];

    /** Check 1 for every title in `titles`; advances the trees. */
    const checkEcho = (echo: BlockOp[], after: Snapshot, titles: readonly string[],
                       label: string): string[] => {
      const held = treesFromSnapshot(after, TITLE_POOL);
      const problems: string[] = [];
      for (const p of titles) {
        const expected = pruneTree(held.get(p) ?? [], known);
        const tree = trees.get(p) ?? [];
        if (needsAuthoritativeReload(tree, echo, p)) {
          tally.reloads += 1;
          trees.set(p, expected);
          continue;
        }
        const next = seam.applyEcho(tree, echo, p);
        for (const line of diffTrees(next, expected, ["tree", "server"])) {
          problems.push(`check 1: ${label}, page ${JSON.stringify(p)}: ${line}`);
        }
        trees.set(p, next);
      }
      return problems;
    };

    /** Check 3: the replica against the server's graph. */
    const checkReplica = (after: Snapshot, ranked: boolean): string[] => {
      const shape = ranked ? rankOrder : (g: NormalGraph) => g;
      const diff = diffGraphs(shape(pruneGraph(fromReplica(replica.db), known, keep)),
                              shape(pruneGraph(fromSnapshot(after), known, keep)),
                              ["replica", "server"]);
      return diff === null ? []
        : diff.split("\n").map((l) => `check 3${ranked ? " (sibling ranks)" : ""}: ${l}`);
    };

    const ackSkips = (p: Posted): void => {
      if (p.status === 200) for (const s of p.ack.skipped ?? []) bump(tally.skipped, s.reason);
    };

    const pendingRow = (batchId: BatchId) =>
      allBatches(replica.db).find((b) => b.batch_id === batchId && !b.poisoned);

    if (ex.kind === "command") {
      const run = runSequence(ex.start.pages["Outline Props"], ex.commands,
                              // Two digits at least: a uid needs six characters.
                              { mintPrefix: "opsn0" });
      for (const b of run.batches) learn(b.ops);
      const others = TITLE_POOL.filter((t) => t !== "Outline Props");
      for (const [i, batch] of run.batches.entries()) {
        const header = `at command batch ${i + 1} of ${run.batches.length}`;
        for (const op of batch.ops) bump(tally.opKinds, op.op);
        const batchId = nextBatchId();
        const problems: string[] = [];
        let refused = false;
        try {
          seam.enqueue(replica.db, batch.ops, now(), batchId);
        } catch (e) {
          if (!(e instanceof LocalOpError)) throw e;
          refused = true;
          problems.push(`rejection: enqueueBatch refused a command batch: ${e.message}`);
        }
        const row = pendingRow(batchId);
        const sent = row?.ops ?? batch.ops;
        const posted = await post(server, batchId, "ops-device", sent);
        ackSkips(posted);
        trace.push(`  command batch ${i + 1} (${batchId}): ${showAck(posted)}`,
                   `      ${showOps(sent)}`);
        if (posted.status === 400) {
          tally.rejections[isTitleSyntax(posted.reason) ? "title syntax" : "other"] += 1;
          problems.push(`check 2: the server rejected a command batch: ${posted.reason}`);
          return fail(header, problems);
        }
        if ((posted.ack.skipped ?? []).length > 0) {
          problems.push(`check 2: the server skipped command ops:` +
                        ` ${JSON.stringify(posted.ack.skipped)}`);
        }
        if (row) deleteBatch(replica.db, row.id, row.batch_id);
        const echo = await server.takeEcho();
        if (echo === null) throw harness(`no echo after ${batchId}'s 200`);
        const s1 = await server.snapshot();
        const outline = pruneTree(treesFromSnapshot(s1, ["Outline Props"]).get("Outline Props") ?? [],
                                  known);
        for (const line of diffTrees(batch.after, outline, ["editor", "server"])) {
          problems.push(`check 2: ${line}`);
        }
        problems.push(...checkEcho(echo, s1, others, "command echo"));
        if (!refused) problems.push(...checkReplica(s1, false));
        if (problems.length > 0) return fail(header, problems);
      }
      return [];
    }

    // One shared supply, so B's and O's creates never collide.
    const mint = rawUidMinter();
    for (const [i, step] of ex.steps.entries()) {
      const header = `at raw step ${i + 1} of ${ex.steps.length}`;
      const problems: string[] = [];
      const g = fromSnapshot(await server.snapshot());
      const opsB = resolveRaw(step.batch, g, mint);
      tallyRaw(tally, step.batch, opsB, g);
      learn(opsB);
      const batchB = nextBatchId();
      let refused: LocalOpError | null = null;
      try {
        seam.enqueue(replica.db, opsB, now(), batchB);
      } catch (e) {
        if (!(e instanceof LocalOpError)) throw e;
        refused = e;
      }

      // Another device's batch, then a window over B's optimistic apply.
      let ranked = false;
      if (step.other !== null) {
        const gO = fromSnapshot(await server.snapshot());
        const opsO = resolveRaw(step.other, gO, mint);
        learn(opsO);
        const batchO = nextBatchId();
        const postedO = await post(server, batchO, "ops-other", opsO);
        ackSkips(postedO);
        trace.push(`  step ${i + 1} O (${batchO}): ${showAck(postedO)}`,
                   `      ${showOps(opsO)}`);
        if (postedO.status === 400) {
          tally.others.rejected += 1;
          if (await server.takeEcho() !== null) throw harness(`an echo after ${batchO}'s 400`);
        } else {
          const echoO = await server.takeEcho();
          if (echoO === null) throw harness(`no echo after ${batchO}'s 200`);
          const sO = await server.snapshot();
          problems.push(...checkEcho(echoO, sO, TITLE_POOL, "O's echo"));

          const pending = allBatches(replica.db).filter((b) => !b.poisoned);
          const ids = pending.map((b) => b.batch_id);
          const touched = new Set<string>(pending.flatMap((b) => opUidsOf(b.ops)));
          if (ids.length > 0) {
            for (const r of replica.db.select<{ uid: string }>(
              `SELECT uid FROM effect_ledger WHERE batch_id IN (${ids.map(() => "?").join(",")})`,
              ids)) touched.add(r.uid);
          }
          const cursor = Number(getMeta(replica.db, "cursor")) as SyncSeq;
          const feed = await server.changes(cursor);
          if (feed.next_since !== feed.latest_seq) {
            throw harness(`window from ${cursor} stops at ${feed.next_since},` +
                          ` short of the head ${feed.latest_seq}`);
          }
          const reshipped = new Set<string>([
            ...feed.blocks.map((b) => b.uid),
            ...feed.tombstones.filter((tm) => tm.kind === "block").map((tm) => tm.entity_id),
          ]);
          ranked = [...touched].some((u) => reshipped.has(u));
          tally.others[ranked ? "touched" : "untouched"] += 1;
          const applied = seam.applyWindow(replica.db, feed, now());
          if (applied.status !== "applied") {
            problems.push(`check R: applyChanges answered ${applied.status} to a head window`);
            return fail(header, problems);
          }
          const fresh = await openTestDb();
          try {
            applySnapshot(fresh.db, sO, now());
            for (const b of pending) REAL_OPS.enqueue(fresh.db, b.ops, now(), b.batch_id);
            const shape = ranked ? rankOrder : (x: NormalGraph) => x;
            const diff = diffGraphs(shape(pruneGraph(fromReplica(replica.db), known, keep)),
                                    shape(pruneGraph(fromReplica(fresh.db), known, keep)),
                                    ["replayed", "fresh"]);
            if (diff !== null) {
              problems.push(...diff.split("\n").map(
                (l) => `check R${ranked ? " (sibling ranks)" : ""}: ${l}`));
            }
          } finally {
            fresh.close();
          }
        }
      }

      // B goes out as the queue would send it: the ops its row stored.
      const row = pendingRow(batchB);
      const sent = row?.ops ?? opsB;
      const posted = await post(server, batchB, "ops-device", sent);
      ackSkips(posted);
      trace.push(`  step ${i + 1} B (${batchB}): ${showAck(posted)}`,
                 `      ${showOps(sent)}`);
      if (posted.status === 400) {
        const titled = isTitleSyntax(posted.reason);
        tally.rejections[titled ? "title syntax" : "other"] += 1;
        if (await server.takeEcho() !== null) throw harness(`an echo after ${batchB}'s 400`);
        if (titled !== (refused !== null)) {
          problems.push(refused === null
            ? `rejection: the server refused B for its title syntax (${posted.reason})` +
              " but enqueueBatch took it"
            : `rejection: enqueueBatch refused B (${refused.message}) but the server` +
              ` answered 400 ${posted.reason}`);
        }
        if (problems.length > 0) return fail(header, problems);
        // A batch the poison path would repair: nothing further to compare.
        if (!titled) return [];
        continue;
      }
      if (refused !== null) {
        problems.push(`rejection: enqueueBatch refused B (${refused.message})` +
                      " but the server applied it");
        return fail(header, problems);
      }
      if (row) deleteBatch(replica.db, row.id, row.batch_id);
      const echo = await server.takeEcho();
      if (echo === null) throw harness(`no echo after ${batchB}'s 200`);
      const s1 = await server.snapshot();
      problems.push(...checkEcho(echo, s1, TITLE_POOL, "B's echo"));
      problems.push(...checkReplica(s1, ranked));
      if (problems.length > 0) return fail(header, problems);
    }
    return [];
  } finally {
    replica.close();
  }
}
