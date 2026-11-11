// pattern: Functional Core
// The queue property's model, from sync-recovery.md § The recovery barrier
// and § The in-memory fallback lane, never from opQueue: who holds the
// barrier, which batches the server has applied, and what each POST may be.
//   barrier   no POST starts while any owner holds the barrier:
//               startup   between the property's pause and resume
//               recovery  between a recovery's start and end
//               poison    while a durable row the server rejected is still
//                         in the replica
//               lane      from a lane entry's rejection until the next
//                         outline repair turns stable
//   order     the server applies this client's batches in enqueue order,
//             lane and durable copies alike
//   delivery  once quiescent, every batch the server accepts is applied,
//             and no other batch is
//   claim     after every command settles, the queue holds every owner the
//             model holds; it may hold one longer (it releases poison after
//             the repair's delete loop, the model at the delete)
//   release   once quiescent, the queue holds no owner; a run cut off before
//             quiescence names each owner the queue holds and the model
//             does not
import type { BatchId } from "../../api/brands";

export type Owner = "startup" | "poison" | "recovery" | "lane";

export type Persist = "ok" | "writeFails" | "lostReply";
export type Refusal = "none" | "overLimit" | "replicaRejected";

export interface BatchInfo {
  /** Position in enqueue order. */
  idx: number;
  persist: Persist;
  refusal: Refusal;
  /** The server rejects this batch whenever it is posted. */
  bad: boolean;
}

export interface QueueModel {
  startup: boolean;
  recovery: boolean;
  /** Rejected durable rows still in the replica. */
  poison: Set<BatchId>;
  lane: boolean;
  batches: Map<BatchId, BatchInfo>;
  /** First applications, in server order. */
  applied: BatchId[];
  violations: string[];
}

export function initialModel(): QueueModel {
  return {
    startup: false, recovery: false, poison: new Set(), lane: false,
    batches: new Map(), applied: [], violations: [],
  };
}

export function holders(m: QueueModel): Owner[] {
  const out: Owner[] = [];
  if (m.startup) out.push("startup");
  if (m.poison.size > 0) out.push("poison");
  if (m.recovery) out.push("recovery");
  if (m.lane) out.push("lane");
  return out;
}

/** A POST is starting: the barrier must be clear. */
export function notePost(m: QueueModel, batchId: BatchId, copy: string): void {
  const held = holders(m);
  if (held.length > 0) {
    m.violations.push(`barrier: ${copy} ${batchId} posted while ${held.join(", ")} held`);
  }
}

/** The server applies `batchId` (first time or replay). */
export function noteApplied(m: QueueModel, batchId: BatchId): void {
  if (m.applied.includes(batchId)) return;
  const info = m.batches.get(batchId);
  if (info === undefined) {
    m.violations.push(`order: unknown batch ${batchId} applied`);
    return;
  }
  const later = m.applied.filter((b) => (m.batches.get(b)?.idx ?? -1) > info.idx);
  if (later.length > 0) {
    m.violations.push(`order: ${batchId} applied after later ${later.join(", ")}`);
  }
  m.applied.push(batchId);
}

/** Whether the server accepts this batch when posted. */
export function accepted(info: BatchInfo): boolean {
  return !info.bad && info.refusal === "none";
}

const OWNERS: readonly Owner[] = ["startup", "poison", "recovery", "lane"];

/** After a command settles: every owner the model holds, the queue holds. */
export function claimProblems(m: QueueModel, holds: (o: Owner) => boolean): string[] {
  return holders(m).filter((o) => !holds(o))
    .map((o) => `claim: the model holds ${o}, the queue does not`);
}

/** After quiescing: the queue holds no owner the model has let go. */
export function releaseProblems(m: QueueModel, holds: (o: Owner) => boolean): string[] {
  const model = holders(m);
  return OWNERS.filter((o) => holds(o) && !model.includes(o))
    .map((o) => `release: ${o} still held by the queue`);
}

/** Once quiescent: what was applied matches what the server accepts. */
export function deliveryProblems(m: QueueModel): string[] {
  const problems: string[] = [];
  for (const [id, info] of m.batches) {
    const applied = m.applied.includes(id);
    if (accepted(info) && !applied) problems.push(`delivery: ${id} never applied`);
    if (!accepted(info) && applied) problems.push(`delivery: refused ${id} applied`);
  }
  return problems;
}
