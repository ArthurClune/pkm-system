// pattern: Imperative Shell
// The queue property's world: the real op queue, client runtime and outline
// repair, wired by hand as createSyncSession (sync/session.ts) wires them,
// around stand-ins the property steps one command at a time. A session
// would bring the real replicaSync, whose repair snapshot and recovery the
// stand-ins below replace so that a command can step them. Every stand-in
// is a part of the app's surroundings, never of the code under test:
//   worker    a FIFO of replica calls behind a gate, as the replica worker's
//             recovery gate runs them; a held gate keeps every later call
//             waiting, a timed-out enqueue's write included
//   server    one POST in flight at a time, answered by a command; a batch
//             drawn bad is rejected with a 400 whenever it is posted
//   repairs   the poison repair's snapshot (replicaSync.rebaseAuthoritative)
//             and the outline repair's outline read each wait on a command
//   recovery  replicaSync's runRecovery: pause("recovery"), the lease's gate,
//             its preemptible flush through deliverLeased one row per
//             command, then a commit that deletes the rows it got acks for
//             (an abort, after a failed flush, keeps them), the gate and
//             resume("recovery"); it starts only once startup has let go,
//             as replicaSync starts after the runtime's startup
//   marks     a bad batch's first mark fails, or finds no row (the
//             stand-in deletes it first, as a reset would have), as drawn;
//             the banner's Retry and Discard are commands too, offered
//             once a mark has failed, and Discard also while a repair
//             runs, which the runtime's rule covers
// The model (queueModel.ts) watches the same events and judges each POST as
// it starts. Retry timers are vitest's fake setTimeout, fired only by the
// retryTimer command, so an example replays from its seed.
import { vi } from "vitest";
import { ApiError } from "../../api/client";
import type { BatchId } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { OpBatch, OpsAck } from "../../api/payloads";
import { MAX_LINK_NESTING } from "../../grammar/textLimits";
import type { PendingBatch, Replica } from "../../replica/client";
import { ReplicaError, RpcLifecycleError } from "../../replica/errors";
import { createClientRuntime } from "../../sync/clientRuntime";
import { createOutlineRepair } from "../../sync/outlineRepair";
import { memReplica } from "../../sync/memReplica";
import { createOpQueue, type DeliveryOutcome } from "../../sync/opQueue";
import { batchIdOf, pendingRowIdOf, seqOf, uidOf } from "../../test-helpers";
import { accepted, claimProblems, deliveryProblems, holders, initialModel, noteApplied,
         notePoisonRelease, notePost, noteRepairDelete, releaseProblems, type BatchInfo,
         type Mark, type Owner, type Persist, type Refusal } from "./queueModel";

export type Respond = "ack" | "lostAck" | "netFail";

export type QueueCmd =
  | { t: "edit"; persist: Persist; refusal: Refusal; bad: boolean; mark: Mark }
  | { t: "respond"; kind: Respond }
  | { t: "offline" }
  | { t: "online" }
  | { t: "pauseStartup" }
  | { t: "resumeStartup" }
  | { t: "recoveryStart" }
  | { t: "recoveryEnd" }
  | { t: "holdGate" }
  | { t: "releaseGate" }
  | { t: "repair"; ok: boolean }
  | { t: "outlineStable" }
  | { t: "outlineFails" }
  | { t: "outlineDone" }
  | { t: "retryTimer" }
  | { t: "drain" }
  | { t: "retryMarks" }
  | { t: "discard" }
  | { t: "recoveryFlush" };

export const showCmd = (c: QueueCmd): string => {
  switch (c.t) {
    case "edit":
      return `edit(${c.persist}${c.refusal === "none" ? "" : `, ${c.refusal}`}` +
        `${c.bad ? ", bad" : ""}${c.bad && c.mark !== "ok" ? `, mark ${c.mark}` : ""})`;
    case "respond": return `respond(${c.kind})`;
    case "repair": return `repair(${c.ok ? "ok" : "fails"})`;
    default: return c.t;
  }
};

/** Batch ids whose enqueue reply the worker will lose: a teeth mutant reads
 * it to drop exactly the marks the old code set only after the reply. */
export const lostReplyIds = new Set<BatchId>();

const NESTED = `${"[[".repeat(MAX_LINK_NESTING + 1)}x${"]]".repeat(MAX_LINK_NESTING + 1)}`;
const QUIESCE_ROUNDS = 60;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

interface Read {
  onStable: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  stable: boolean;
}

interface InFlight {
  batchId: BatchId;
  copy: "durable" | "lane";
  /** Posted by the recovery's leased flush. */
  leased: boolean;
  resolve: (ack: OpsAck) => void;
  reject: (error: unknown) => void;
}

/** Runs one example; returns what the model found wrong, empty when nothing. */
export async function runQueueExample(
  cmds: readonly QueueCmd[], tally: (key: string) => void,
  transcript: string[] = [],
): Promise<string[]> {
  // Off while quiescing, so the rates count what the commands reached.
  let counting = true;
  const count = (key: string): void => { if (counting) tally(key); };
  const model = initialModel();
  lostReplyIds.clear();
  const rows: PendingBatch[] = [];
  let nextRow = 1;
  const fifo: (() => void)[] = [];
  let recoveryHold = false;
  let extraHold = false;
  const gateHeld = (): boolean => recoveryHold || extraHold;
  const pump = (): void => {
    while (!gateHeld() && fifo.length > 0) fifo.shift()!();
  };
  const work = <T>(fn: () => T): Promise<T> => new Promise<T>((resolve, reject) => {
    fifo.push(() => {
      try { resolve(fn()); } catch (error: unknown) { reject(error); }
    });
    pump();
  });
  const live = (): number => rows.filter((r) => !r.poisoned).length;
  // Lane entries not yet answered, by enqueue position: reach only.
  const laneWaiting = new Set<BatchId>();
  let lastHanded: BatchId | null = null;
  let repairFailed = false;
  /** Bad batches whose drawn mark fault has fired: only the first mark. */
  const markFaulted = new Set<BatchId>();
  /** A mark failed and neither Retry nor Discard has answered it: the
   * failed mark's banner, which offers both. */
  let markFailed = false;
  let repairRunning = false;
  /** The batch the leased flush is delivering, while deliverLeased runs. */
  let leasing: BatchId | null = null;
  /** This recovery's acked leased rows, and whether its flush failed. */
  const leaseAcked = new Set<BatchId>();
  let flushFailed = false;

  const replica: Replica = {
    ...memReplica(),
    enqueue: (ops, batchId) => {
      const info = model.batches.get(batchId)!;
      const lost = info.persist === "lostReply" && info.refusal === "none";
      if (lost && gateHeld()) count("lost reply: the row persists after the timeout");
      if (lost && [...laneWaiting].some((b) => model.batches.get(b)!.idx < info.idx)) {
        count("lost reply: an earlier lane entry is waiting");
      }
      const stored = work(() => {
        if (info.refusal === "replicaRejected") {
          throw new ReplicaError("unsupported title", { rejected: true });
        }
        if (info.persist === "writeFails") throw new Error("SQLITE_IOERR: disk I/O error");
        rows.push({ id: pendingRowIdOf(nextRow), batch_id: batchId, ops, poisoned: false });
        nextRow += 1;
        return { pending: live(), batchId };
      });
      if (!lost) return stored;
      stored.catch(() => undefined);
      return Promise.reject(new RpcLifecycleError("timeout", "replica RPC enqueue timed out"));
    },
    nextBatch: () => work(() => {
      const row = rows.find((r) => !r.poisoned) ?? null;
      lastHanded = row?.batch_id ?? null;
      if (row !== null && model.batches.get(row.batch_id)!.persist === "lostReply" &&
          [...laneWaiting].some((b) =>
            model.batches.get(b)!.idx < model.batches.get(row.batch_id)!.idx)) {
        count("lost reply: its row handed out behind a waiting lane entry");
      }
      return row === null ? null : { ...row };
    }),
    deleteBatch: (id, batchId) => work(() => {
      const at = rows.findIndex((r) => r.id === id && r.batch_id === batchId);
      if (at !== -1) rows.splice(at, 1);
      if (model.poison.has(batchId)) {
        if (holders(model).length > 1) count("poison released, others held");
        if (model.releaseWithRepair) count("poison left to a repair released by it");
        noteRepairDelete(model, batchId);
      }
      return { pending: live() };
    }),
    markPoisoned: (id, _error, batchId) => {
      const drawn = model.batches.get(batchId)?.mark ?? "ok";
      const fault = drawn === "ok" || markFaulted.has(batchId) ? null : drawn;
      markFaulted.add(batchId);
      const where = repairRunning ? "during a repair" : "no repair running";
      return work(() => {
        if (fault === "fails") {
          count(`mark fails, ${where}`);
          throw new Error("SQLITE_BUSY: database is locked");
        }
        if (fault === "unmatched") {
          count(`mark finds no row, ${where}`);
          const at = rows.findIndex((r) => r.id === id && r.batch_id === batchId);
          if (at !== -1) rows.splice(at, 1);
        }
        const row = rows.find((r) => r.id === id && r.batch_id === batchId);
        if (row) row.poisoned = true;
        return { pending: live(), matched: row !== undefined };
      });
    },
    pendingCount: () => work(live),
    poisonedBatches: () => work(() => rows.filter((r) => r.poisoned).map((r) => ({
      id: r.id, batch_id: r.batch_id, ops: r.ops, status: 400, message: "bad batch",
    }))),
  };

  /** Answered oldest first. Only a leased POST may overlap another. */
  const inFlight: InFlight[] = [];
  const post = (body: OpBatch): Promise<OpsAck> => {
    const leased = leasing !== null;
    const copy = body.batch_id === lastHanded || body.batch_id === leasing ? "durable" : "lane";
    if (!leased) lastHanded = null;
    if (!leased && inFlight.some((p) => !p.leased)) {
      model.violations.push(`two POSTs at once: ${body.batch_id}`);
    }
    if (leased && inFlight.length > 0) count("leased POST beside another");
    notePost(model, body.batch_id, copy, leased);
    return new Promise<OpsAck>((resolve, reject) => {
      inFlight.push({ batchId: body.batch_id, copy, leased, resolve, reject });
    });
  };

  const pending: { minted: BatchInfo[] } = { minted: [] };
  const queue = createOpQueue(replica, {
    post,
    poisonStore: { read: () => [], write: () => undefined },
    newBatchId: () => {
      const info = pending.minted.shift()!;
      const id = batchIdOf(`q-${info.idx}`);
      model.batches.set(id, info);
      if (info.persist === "lostReply" && info.refusal === "none") lostReplyIds.add(id);
      return id;
    },
  });
  let unsent = 0;
  queue.onUnsentInMemory((n) => { unsent = n; });

  const rebases: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const runtime = createClientRuntime({
    queue, replica,
    replicaSync: {
      start: async () => true,
      rebaseAuthoritative: () => new Promise<void>((resolve, reject) => {
        rebases.push({ resolve, reject });
      }),
      noteUnavailable: () => undefined,
    },
    onSyncEvent: (e) => {
      if (e.type === "repair-started") repairRunning = true;
      if (e.type === "repair-succeeded" || e.type === "repair-failed") repairRunning = false;
    },
  });
  queue.onPoisonMarkFailed(() => { markFailed = true; });
  // The queue's report that a marking round matched nothing.
  queue.onPoisonMarkUnmatched(() => {
    count(repairRunning ? "unmatched round during a repair" : "unmatched round, no repair");
    notePoisonRelease(model, repairRunning);
  });
  const reads: Read[] = [];
  const outline = createOutlineRepair({
    repairSessions: (onStable) => new Promise<void>((resolve, reject) => {
      reads.push({ onStable, resolve, reject, stable: false });
    }),
    onEvent: () => undefined,
    resume: () => queue.resume("lane"),
    isMounted: () => true,
  });
  queue.onDesync((desync) => {
    count(desync.lane ? "desync: lane rejection" : "desync: local refusal");
    void outline.run(desync.error, desync);
  });

  const outcomes: { info: BatchInfo; outcome: DeliveryOutcome | null }[] = [];
  let online = true;
  let edits = 0;

  const released = (owner: Owner): void => {
    if (holders(model).some((o) => o !== owner)) count(`${owner} released, others held`);
  };

  /** Runs one command; false when its precondition does not hold. */
  const step = (c: QueueCmd): boolean => {
    switch (c.t) {
      case "edit": {
        edits += 1;
        const info: BatchInfo = {
          idx: edits, persist: c.persist, refusal: c.refusal, bad: c.bad, mark: c.mark,
        };
        const uid = uidOf(`tuid-q${edits}`);
        const ops: BlockOp[] = c.refusal === "overLimit"
          ? [{ op: "update_text", uid, text: NESTED }]
          : [{ op: "delete", uid }];
        if (c.refusal !== "overLimit") pending.minted.push(info);
        const entry = { info, outcome: null as DeliveryOutcome | null };
        outcomes.push(entry);
        const ticket = queue.enqueue(ops);
        void ticket.delivered.then((o) => { entry.outcome = o; });
        if (c.persist !== "ok" && c.refusal === "none") {
          void ticket.settled.then(() => {
            if (info.persist !== "ok") laneWaiting.add(batchIdOf(`q-${info.idx}`));
          });
        }
        return true;
      }
      case "respond": {
        const p = inFlight.shift();
        if (p === undefined) return false;
        const info = model.batches.get(p.batchId)!;
        if (info.bad && p.leased) {
          // deliverLeased throws: no poison mark, and a lane entry stays.
          count(`leased ${p.copy} batch rejected`);
          p.reject(new ApiError(400, "/api/ops", "bad batch"));
          return true;
        }
        if (info.bad) {
          if (leasing !== null) count("durable rejection while a leased flush runs");
          if (p.copy === "durable") {
            count("durable batch rejected");
            model.poison.add(p.batchId);
          } else {
            count("lane batch rejected");
            if (reads.some((r) => r.stable)) {
              count("lane rejected after an outline repair's onStable");
            }
            laneWaiting.delete(p.batchId);
            model.lane = true;
          }
          p.reject(new ApiError(400, "/api/ops", "bad batch"));
          return true;
        }
        count(`respond ${c.kind} (${p.leased ? "leased " : ""}${p.copy})`);
        if (c.kind === "netFail") {
          p.reject(new ApiError(503, "/api/ops"));
          return true;
        }
        noteApplied(model, p.batchId);
        if (p.copy === "lane") laneWaiting.delete(p.batchId);
        if (c.kind === "ack") p.resolve({ ok: true, ts: 1, applied: 1, seq: seqOf(1) });
        else p.reject(new TypeError("network error"));
        return true;
      }
      case "offline":
        if (!online) return false;
        online = false;
        queue.setOnline(false);
        return true;
      case "online":
        if (online) return false;
        online = true;
        queue.setOnline(true);
        // reconnectFlow.begin's first step.
        void (async () => {
          await runtime.retryFailedRepair();
          await outline.retryFailed();
        })();
        return true;
      case "pauseStartup":
        if (model.startup) return false;
        model.startup = true;
        queue.pause("startup");
        return true;
      case "resumeStartup":
        if (!model.startup) return false;
        released("startup");
        model.startup = false;
        queue.resume("startup");
        return true;
      case "recoveryStart":
        if (model.recovery) return false;
        if (inFlight.some((p) => p.copy === "lane")) count("recovery started over a lane POST");
        model.recovery = true;
        queue.pause("recovery");
        recoveryHold = true;
        leaseAcked.clear();
        flushFailed = false;
        return true;
      case "recoveryFlush": {
        if (!model.recovery || model.startup || leasing !== null || flushFailed) return false;
        const row = rows.find((r) => !r.poisoned && !leaseAcked.has(r.batch_id));
        if (row === undefined) return false;
        // replicaSync's preemptible flush: a poison claim abandons it.
        const beforePost = (): void => {
          if (queue.holds("poison")) throw new Error("poison preempted the flush");
        };
        try {
          beforePost();
        } catch {
          count("leased flush preempted before its batch");
          flushFailed = true;
          return true;
        }
        const idx = model.batches.get(row.batch_id)!.idx;
        if ([...laneWaiting].some((b) => model.batches.get(b)!.idx < idx)) {
          count("leased flush with a lane entry ahead");
        }
        leasing = row.batch_id;
        void queue.deliverLeased({ ...row }, beforePost).then(() => {
          leaseAcked.add(row.batch_id);
        }, (error: unknown) => {
          count(error instanceof Error && error.message === "poison preempted the flush"
            ? "leased flush preempted after its lane ahead" : "leased flush failed");
          flushFailed = true;
        }).finally(() => { leasing = null; });
        return true;
      }
      case "recoveryEnd": {
        if (!model.recovery || leasing !== null) return false;
        if (model.lane) count("recovery ended while lane held");
        released("recovery");
        // The commit deletes the rows its flush got acks for; an abort keeps
        // every row.
        const committed = flushFailed ? [] : [...leaseAcked];
        if (committed.length > 0) count("recovery committed leased acks");
        for (const id of committed) {
          const at = rows.findIndex((r) => r.batch_id === id);
          if (at !== -1) rows.splice(at, 1);
        }
        recoveryHold = false;
        pump();
        model.recovery = false;
        queue.resume("recovery");
        queue.settleCommitted(committed.map((batch_id) => ({ batch_id, skipped: [] })));
        return true;
      }
      case "retryMarks":
        if (!markFailed) return false;
        markFailed = false;
        void runtime.runRetry({ kind: "retry-poison-marks", continueStartup: false });
        return true;
      case "discard":
        if (!markFailed && !repairRunning) return false;
        count(`discard${markFailed ? " of a failed mark" : ""}, ${
          repairRunning ? "during a repair" : "no repair running"}`);
        markFailed = false;
        notePoisonRelease(model, repairRunning);
        void runtime.discardPoisonIntents();
        return true;
      case "holdGate":
        if (extraHold) return false;
        extraHold = true;
        return true;
      case "releaseGate":
        if (!extraHold) return false;
        extraHold = false;
        pump();
        return true;
      case "repair": {
        const r = rebases.shift();
        if (r === undefined) return false;
        count(c.ok ? "poison repair succeeds" : "poison repair fails");
        repairFailed = !c.ok;
        if (c.ok) r.resolve();
        else r.reject(new TypeError("snapshot fetch failed"));
        return true;
      }
      case "outlineStable": {
        const r = reads.find((x) => !x.stable);
        if (r === undefined) return false;
        if (model.lane) {
          released("lane");
          count("outline stable: lane owed");
          model.lane = false;
        } else if (model.poison.size > 0 && repairFailed) {
          count("outline stable: nothing owed, poison repair failed");
        } else {
          count("outline stable: nothing owed");
        }
        r.stable = true;
        r.onStable();
        return true;
      }
      case "outlineFails": {
        const at = reads.findIndex((x) => !x.stable);
        if (at === -1) return false;
        count("outline repair fails");
        const [r] = reads.splice(at, 1);
        r.reject(new TypeError("fetch failed"));
        return true;
      }
      case "outlineDone": {
        const at = reads.findIndex((x) => x.stable);
        if (at === -1) return false;
        const [r] = reads.splice(at, 1);
        r.resolve();
        return true;
      }
      case "retryTimer":
        vi.advanceTimersByTime(10_000);
        return true;
      case "drain":
        void queue.drain();
        return true;
    }
  };

  const findings: string[] = [];
  try {
    await runtime.startup();
    queue.setOnline(true);
    await settle();
    for (const c of cmds) {
      const ran = step(c);
      count(ran ? showCmd(c).replace(/\(.*/, "") : `${c.t} skipped`);
      if (ran) transcript.push(showCmd(c));
      await settle();
      for (const problem of claimProblems(model, queue.holds)) {
        if (!model.violations.includes(problem)) model.violations.push(problem);
      }
    }
    // Quiesce: every hold lets go, every request is answered as the server
    // and the network would answer it once healthy.
    counting = false;
    let quiet = false;
    for (let round = 0; round < QUIESCE_ROUNDS && !quiet; round += 1) {
      if (model.startup) step({ t: "resumeStartup" });
      if (model.recovery) step({ t: "recoveryEnd" });
      if (extraHold) step({ t: "releaseGate" });
      if (!online) step({ t: "online" });
      if (inFlight.length > 0) step({ t: "respond", kind: "ack" });
      step({ t: "retryMarks" });
      if (rebases.length > 0) step({ t: "repair", ok: true });
      if (!step({ t: "outlineStable" })) step({ t: "outlineDone" });
      void runtime.retryFailedRepair().then(() => outline.retryFailed());
      vi.advanceTimersByTime(10_000);
      void queue.drain();
      await settle();
      quiet = inFlight.length === 0 && rebases.length === 0 && reads.length === 0 &&
        rows.length === 0 && unsent === 0 && holders(model).length === 0 &&
        outcomes.every((o) => o.outcome !== null || o.info.refusal === "overLimit");
    }
    if (!quiet) {
      findings.push(`not quiescent after ${QUIESCE_ROUNDS} rounds: ` +
        `in flight ${inFlight.map((p) => p.batchId).join(" ") || "none"}, ` +
        `rebases ${rebases.length}, reads ${reads.length}, rows ${rows.length}, ` +
        `lane ${unsent}, held ${holders(model).join(", ") || "none"}`);
    }
    findings.push(...releaseProblems(model, queue.holds));
    findings.push(...deliveryProblems(model));
    for (const { info, outcome } of outcomes) {
      if (outcome === null) continue;
      const want = accepted(info) ? "delivered" : "failed";
      if (outcome.status !== want) {
        findings.push(`delivery: edit ${info.idx}'s ticket ${outcome.status}, want ${want}`);
      }
    }
  } finally {
    queue.dispose();
    runtime.dispose();
  }
  return [...model.violations, ...findings];
}
