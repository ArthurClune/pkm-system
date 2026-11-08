// @vitest-environment node
// The worker's queue handlers over a pending_ops that can turn unreadable at
// any step. The model is the queue rule in sync-recovery.md § Reset, rebase
// and file replacement: the queue is the user's intent, so a file whose
// queue cannot be read is replaced by one holding every row that still can
// be, with the carry as the rows' durable copy from before the unlink until
// the new file has them. Invariants:
//   no wedge   a handler fails only while a discard is armed to throw over a
//              damaged queue, or as a commit whose lease met fresh damage;
//              any other call succeeds
//   rows       after each success the file holds every model row, with its
//              id, batch id and poison mark; the only others it may hold
//              are rows the damage cut that a later salvage could still
//              read
//   no carry   no carry is left once a handler succeeds
//   carry      when a file is discarded, the carry holds every model row
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BatchId } from "../api/brands";
import type { Snapshot } from "./apply";
import { createCarryStore } from "./carryStore";
import type { PendingRowId } from "./client";
import type { ReplicaDb } from "./db";
import { fakeCarryFiles, openRawTestDb, type TestDb, withDamagedFreelist,
         withUnreadableQueue } from "./testDb";
import { buildHandlers } from "./workerHandlers";
import { batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, pendingRowIdOf,
         seqOf, uidOf } from "../test-helpers";

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: seqOf(5),
  pages: [{ id: pageIdOf(1), title: canonicalTitleOf("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uidOf("uid_b1"), page_id: pageIdOf(1), parent_uid: null,
    order_idx: orderIdxOf(0), text: "hello", heading: null, view_type: null,
    collapsed: 0, created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};

/** Where the damage cuts the queue: before the row at this index of the
 * model's ids (past the end, every row is readable), or the schema; or
 * "drops", a broken freelist that fails only a rebuild's DROPs. */
type Damage = { cut: number } | "schema" | "drops";

type Cmd =
  | { t: "enqueue" }
  | { t: "delete"; pick: number }
  | { t: "mark"; pick: number }
  | { t: "nextBatch" }
  | { t: "init" }
  | { t: "pendingBatches" }
  | { t: "poisonedBatches" }
  | { t: "pendingCount" }
  | { t: "recovery"; end: "reset" | "rebase" | "abort"; between: Damage | null }
  | { t: "damage"; damage: Damage }
  | { t: "discardThrows" };

const damageArb: fc.Arbitrary<Damage> = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: 3 }).map((cut) => ({ cut })) },
  { weight: 1, arbitrary: fc.constant<Damage>("schema") },
  { weight: 1, arbitrary: fc.constant<Damage>("drops") },
);

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Cmd>({ t: "enqueue" }) },
  { weight: 1, arbitrary: fc.nat().map((pick): Cmd => ({ t: "delete", pick })) },
  { weight: 1, arbitrary: fc.nat().map((pick): Cmd => ({ t: "mark", pick })) },
  { weight: 1, arbitrary: fc.constantFrom<Cmd>(
      { t: "nextBatch" }, { t: "init" }, { t: "pendingBatches" },
      { t: "poisonedBatches" }, { t: "pendingCount" }) },
  { weight: 2, arbitrary: fc.record({
      t: fc.constant("recovery" as const),
      end: fc.constantFrom("reset" as const, "rebase" as const, "abort" as const),
      between: fc.option(damageArb, { freq: 3 }),
    }) },
  { weight: 2, arbitrary: damageArb.map((damage): Cmd => ({ t: "damage", damage })) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ t: "discardThrows" }) },
);

interface ModelRow { id: number; batch_id: BatchId; poisoned: boolean }

const tally = new Map<string, number>();
const count = (key: string): void => { tally.set(key, (tally.get(key) ?? 0) + 1); };

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  console.log(`queue-unreadable property tally:\n${[...tally].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `  ${k}  ${n}`).join("\n")}`);
});

const rawRows = (db: ReplicaDb): ModelRow[] => db.select(
  "SELECT id AS pending_row_id, batch_id, poisoned FROM pending_ops ORDER BY id",
  ["pending_row_id", "batch_id", "poisoned"],
).map((r) => ({ id: r.pending_row_id, batch_id: r.batch_id, poisoned: r.poisoned === 1 }));

async function runExample(cmds: readonly Cmd[]): Promise<string[]> {
  const findings: string[] = [];
  const files: TestDb[] = [];
  const carry = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  let current = await openRawTestDb();
  files.push(current);
  // The damage on `file` while it is the current one.
  let damage: { file: TestDb; readableBelow: number; schema: boolean } | null = null;
  // A broken freelist on this file: its rebuild's DROPs fail.
  let dropDamage: TestDb | null = null;
  let discardThrows = 0;
  // A handle the worker opened; a discard closes the last one.
  let lastHandle: { closed: boolean } = { closed: false };
  let model: ModelRow[] = [];
  // Rows the damage cut from the model while the file holding them is
  // still current: a later salvage, under milder damage, may read them.
  let cut: ModelRow[] = [];
  // The damage has been met and the model cut to what it left readable;
  // reset once a handler succeeds on a clean file.
  let cutDone = false;
  let minted = 0;

  const handlers = buildHandlers({
    openDb: async () => {
      const file = current;
      const handle = { closed: false };
      lastHandle = handle;
      const freelist = withDamagedFreelist(file.db, /^DROP /i, () => dropDamage === file);
      const damaged = withUnreadableQueue(freelist, {
        isDamaged: () => damage?.file === file,
        readableBelow: () => damage?.readableBelow ?? 0,
        schema: () => damage?.schema ?? false,
      });
      const live = <T>(f: () => T): T => {
        if (handle.closed) throw new Error("database is closed");
        return f();
      };
      return {
        exec: (sql, params) => live(() => damaged.exec(sql, params)),
        select(sql, keys, params) {
          if (handle.closed) throw new Error("database is closed");
          return damaged.select(sql, keys, params);
        },
        introspect: (sql, params) => live(() => damaged.introspect(sql, params)),
        transaction: (fn) => live(() => damaged.transaction(fn)),
      };
    },
    discardDbFile: async () => {
      const carried = carry.exists() ? carry.read() : [];
      const missing = model.filter((m) => !carried.some((r) =>
        r.id === m.id && r.batch_id === m.batch_id));
      if (missing.length > 0) {
        findings.push(`carry: the file was discarded while the carry lacked ${
          missing.map((m) => `${m.id}/${m.batch_id}`).join(", ")}`);
      }
      lastHandle.closed = true;
      if (discardThrows > 0) {
        discardThrows -= 1;
        count("discard threw");
        throw new Error("unlink failed");
      }
      count("file replaced");
      const fresh = await openRawTestDb();
      if (damage?.file === current) damage = null;
      if (dropDamage === current) dropDamage = null;
      current = fresh;
      files.push(fresh);
    },
    carry,
    nowMs: () => 10,
  });

  /** The damage is about to be met: the model keeps what it left readable. */
  const meetDamage = (): void => {
    if (damage?.file !== current || cutDone) return;
    cutDone = true;
    const before = model.length;
    const kept = damage.schema ? [] : model.filter((m) => m.id < damage!.readableBelow);
    cut = [...cut, ...model.filter((m) => !kept.includes(m))];
    model = kept;
    count(model.length === before ? "damage met: every row readable"
      : model.length === 0 ? "damage met: no row readable" : "damage met: a prefix readable");
  };

  /** One handler call: a failure is allowed only when `mayFail`. */
  const call = async <T>(name: string, run: () => Promise<T>, mayFail: boolean):
      Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      const value = await run();
      if (carry.exists()) findings.push(`no carry: ${name} succeeded with a carry left`);
      const raw = rawRows(current.db);
      const same = (a: ModelRow, b: ModelRow): boolean =>
        a.id === b.id && a.batch_id === b.batch_id;
      const back = raw.filter((r) => !model.some((m) => same(m, r)) &&
                                     cut.some((c) => same(c, r)));
      if (back.length > 0) count("cut rows read back by a later salvage");
      const expected = [...model, ...back].sort((a, b) => a.id - b.id);
      if (JSON.stringify(raw) !== JSON.stringify(expected)) {
        findings.push(`rows: after ${name} the file holds ${JSON.stringify(raw)},` +
                      ` the model ${JSON.stringify(model)}`);
      }
      model = raw;
      if (damage?.file !== current) {
        cutDone = false;
        cut = [];
      }
      return { ok: true, value };
    } catch (error: unknown) {
      if (!mayFail) {
        findings.push(`no wedge: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        count(`${name} failed as allowed`);
      }
      return { ok: false };
    }
  };

  /** A handler over the queue: it may fail only while damage is unmet and a
   * discard is armed to throw, or while a failed discard left a carry. */
  const queueCall = <T>(name: string, run: () => Promise<T>) => {
    const damaged = damage?.file === current;
    meetDamage();
    return call(name, run, (damaged || carry.exists()) && discardThrows > 0);
  };

  const damageOf = (d: Damage): void => {
    if (d === "drops") {
      dropDamage = current;
      return;
    }
    const ids = model.map((m) => m.id);
    damage = d === "schema"
      ? { file: current, readableBelow: 0, schema: true }
      : { file: current, readableBelow: d.cut < ids.length ? ids[d.cut] : Number.MAX_SAFE_INTEGER,
          schema: false };
    cutDone = false;
  };

  await call("init", () => handlers.init(undefined), false);
  await call("applySnapshot",
             () => handlers.applySnapshot({ snapshot: SNAP, expectedPendingIds: [] }), false);
  for (const cmd of cmds) {
    if (findings.length > 0) break;
    switch (cmd.t) {
      case "enqueue": {
        minted += 1;
        const batchId = batchIdOf(`b${minted}`);
        const r = await queueCall("enqueue", async () => {
          const out = await handlers.enqueue({
            ops: [{ op: "update_text", uid: uidOf("uid_b1"), text: `t${minted}` }], batchId,
          });
          // the new row's id, before the check reads the file
          const row = rawRows(current.db).find((x) => x.batch_id === batchId);
          if (row) model = [...model, row];
          return out;
        });
        if (r.ok && damage === null && files.length > 1) count("enqueue onto a replaced file");
        break;
      }
      case "delete": {
        const target = model[cmd.pick % Math.max(1, model.length)];
        if (target === undefined) break;
        await queueCall("deleteBatch", async () => {
          const out = await handlers.deleteBatch({
            id: pendingRowIdOf(target.id), batchId: target.batch_id });
          model = model.filter((m) => m.batch_id !== target.batch_id);
          return out;
        });
        break;
      }
      case "mark": {
        const target = model[cmd.pick % Math.max(1, model.length)];
        if (target === undefined) break;
        await queueCall("markPoisoned", async () => {
          const out = await handlers.markPoisoned({
            id: pendingRowIdOf(target.id), error: "HTTP 400", batchId: target.batch_id });
          model = model.map((m) => m.batch_id === target.batch_id ? { ...m, poisoned: true } : m);
          return out;
        });
        break;
      }
      case "nextBatch": {
        const r = await queueCall("nextBatch", () => handlers.nextBatch(undefined));
        if (r.ok) {
          const head = model.find((m) => !m.poisoned);
          const got = r.value;
          if ((got?.batch_id ?? null) !== (head?.batch_id ?? null)) {
            findings.push(`rows: nextBatch gave ${got?.batch_id}, the model's head is ${head?.batch_id}`);
          }
        }
        break;
      }
      case "init":
        await queueCall("init", () => handlers.init(undefined));
        break;
      case "pendingBatches":
        await queueCall("pendingBatches", () => handlers.pendingBatches(undefined));
        break;
      case "poisonedBatches":
        await queueCall("poisonedBatches", () => handlers.poisonedBatches(undefined));
        break;
      case "pendingCount":
        await queueCall("pendingCount", () => handlers.pendingCount(undefined));
        break;
      case "recovery": {
        const lease = await queueCall("prepareRecovery",
                                      () => handlers.prepareRecovery(undefined));
        if (!lease.ok) break;
        const { token, batches } = lease.value;
        if (JSON.stringify(batches.map((b) => b.batch_id)) !==
            JSON.stringify(model.map((m) => m.batch_id))) {
          findings.push(`rows: the lease named ${batches.map((b) => b.batch_id).join(",")}` +
                        `, the model ${model.map((m) => m.batch_id).join(",")}`);
        }
        if (cmd.between !== null) {
          damageOf(cmd.between);
          count("damage between prepare and commit");
        }
        if (cmd.end === "abort") {
          await call("abortRecovery", () => handlers.abortRecovery(token), false);
          count("recovery aborted");
          break;
        }
        // The commit reads the queue unwrapped: fresh damage to it fails
        // the commit, and the next handler replaces the file. A reset over
        // a broken freelist replaces the file itself, failing only if the
        // discard throws.
        const queueHit = cmd.between !== null && cmd.between !== "drops";
        const resetReplaces = cmd.end === "reset" && dropDamage === current;
        if (resetReplaces && !queueHit) count("reset over a broken freelist");
        const commitMayFail = queueHit || (resetReplaces && discardThrows > 0);
        const kept = model;
        if (cmd.end === "reset" && !queueHit) model = [];
        const acked: { id: PendingRowId; batch_id: BatchId; seq: null }[] = [];
        const r = await call(`commitRecovery ${cmd.end}`, () => handlers.commitRecovery({
          token,
          input: cmd.end === "reset" ? { kind: "reset", snapshot: SNAP }
                                     : { kind: "rebase", snapshot: SNAP, acked },
        }), commitMayFail);
        if (!r.ok) {
          model = kept;
          await handlers.abortRecovery(token).catch(() => undefined);
        } else {
          count(`recovery ${cmd.end} committed`);
        }
        break;
      }
      case "damage":
        damageOf(cmd.damage);
        count(typeof cmd.damage === "string" ? `damage injected: ${cmd.damage}`
                                             : "damage injected: rows");
        break;
      case "discardThrows":
        discardThrows += 1;
        count("discard armed to throw");
        break;
    }
  }
  // Once the damage and the armed throws are spent, the queue works.
  discardThrows = 0;
  await queueCall("pendingBatches at the end", () => handlers.pendingBatches(undefined));
  for (const f of files) f.close();
  return findings;
}

test("an unreadable queue never wedges the worker and keeps every readable row", async () => {
  await fc.assert(fc.asyncProperty(fc.array(cmdArb, { maxLength: 25 }), async (cmds) => {
    const findings = await runExample(cmds);
    if (findings.length > 0) throw new Error(findings.join("\n"));
  }), { numRuns: 300 });
  for (const label of ["damage met: a prefix readable", "damage met: no row readable",
                       "damage met: every row readable", "discard threw", "file replaced",
                       "damage between prepare and commit", "enqueue onto a replaced file",
                       "reset over a broken freelist"]) {
    expect(tally.get(label) ?? 0, label).toBeGreaterThan(0);
  }
});
