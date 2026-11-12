// pattern: Functional Core
// The queue property's command alphabet (queueHarness.ts runs it). Edits
// carry their fate with them: how the worker's write goes, whether the queue
// or the replica refuses it, and whether the server rejects it. Each other
// command answers, holds or releases one thing the queue is waiting on.
import fc from "fast-check";
import type { QueueCmd, Respond } from "./queueHarness";
import type { Mark, Persist, Refusal } from "./queueModel";

/** What a failing example throws: the model's findings and the commands. */
export class QueueReport extends Error {
  override name = "QueueReport";
}

const edit: fc.Arbitrary<QueueCmd> = fc.record({
  persist: fc.oneof(
    { weight: 3, arbitrary: fc.constant<Persist>("ok") },
    { weight: 2, arbitrary: fc.constant<Persist>("writeFails") },
    { weight: 2, arbitrary: fc.constant<Persist>("lostReply") },
  ),
  refusal: fc.oneof(
    { weight: 6, arbitrary: fc.constant<Refusal>("none") },
    { weight: 2, arbitrary: fc.constantFrom<Refusal>("overLimit", "replicaRejected") },
  ),
  // One in three: a lane rejection needs a bad batch whose write failed.
  bad: fc.nat({ max: 2 }).map((n) => n === 0),
  // Read only for a bad batch's durable mark.
  mark: fc.oneof(
    { weight: 6, arbitrary: fc.constant<Mark>("ok") },
    { weight: 1, arbitrary: fc.constantFrom<Mark>("fails", "unmatched") },
  ),
}).map(({ persist, refusal, bad, mark }) => ({ t: "edit", persist, refusal, bad, mark }));

const simple = (t: Exclude<QueueCmd["t"], "edit" | "respond" | "repair">) =>
  fc.constant<QueueCmd>({ t } as QueueCmd);

export const queueCommand: fc.Arbitrary<QueueCmd> = fc.oneof(
  { weight: 6, arbitrary: edit },
  { weight: 8, arbitrary: fc.constantFrom<Respond>("ack", "ack", "lostAck", "netFail")
      .map((kind): QueueCmd => ({ t: "respond", kind })) },
  { weight: 1, arbitrary: simple("offline") },
  { weight: 1, arbitrary: simple("online") },
  { weight: 1, arbitrary: simple("pauseStartup") },
  { weight: 2, arbitrary: simple("resumeStartup") },
  { weight: 1, arbitrary: simple("recoveryStart") },
  { weight: 2, arbitrary: simple("recoveryEnd") },
  { weight: 1, arbitrary: simple("holdGate") },
  { weight: 2, arbitrary: simple("releaseGate") },
  { weight: 3, arbitrary: fc.boolean().map((ok): QueueCmd => ({ t: "repair", ok })) },
  { weight: 3, arbitrary: simple("outlineStable") },
  { weight: 1, arbitrary: simple("outlineFails") },
  { weight: 1, arbitrary: simple("outlineDone") },
  { weight: 1, arbitrary: simple("retryTimer") },
  { weight: 1, arbitrary: simple("drain") },
  { weight: 1, arbitrary: simple("retryMarks") },
  { weight: 1, arbitrary: simple("discard") },
  { weight: 2, arbitrary: simple("recoveryFlush") },
);

const fixedEdit = (persist: Persist, bad: boolean): fc.Arbitrary<QueueCmd> =>
  fc.constant<QueueCmd>({ t: "edit", persist, refusal: "none", bad, mark: "ok" });

// A recovery's leased flush meets a rejected lane entry ahead of its row only
// when the drain never posted that entry: it needs a bad lane-only edit, a
// durable edit behind it, and a recovery, all before the drain runs. The mix
// above draws that a few times in ten thousand, so some examples start
// offline and draw from this mix instead. Its bad durable edits and repairs
// keep the poison labels near the rates the mix above alone gives them.
const recoveryCommand: fc.Arbitrary<QueueCmd> = fc.oneof(
  { weight: 2, arbitrary: edit },
  { weight: 2, arbitrary: fixedEdit("ok", false) },
  { weight: 4, arbitrary: fixedEdit("writeFails", true) },
  { weight: 2, arbitrary: fixedEdit("ok", true) },
  { weight: 6, arbitrary: fc.constantFrom<Respond>("ack", "ack", "lostAck", "netFail")
      .map((kind): QueueCmd => ({ t: "respond", kind })) },
  { weight: 1, arbitrary: simple("offline") },
  { weight: 2, arbitrary: simple("online") },
  { weight: 1, arbitrary: simple("pauseStartup") },
  { weight: 2, arbitrary: simple("resumeStartup") },
  { weight: 3, arbitrary: simple("recoveryStart") },
  { weight: 1, arbitrary: simple("recoveryEnd") },
  { weight: 1, arbitrary: simple("holdGate") },
  { weight: 2, arbitrary: simple("releaseGate") },
  { weight: 4, arbitrary: fc.boolean().map((ok): QueueCmd => ({ t: "repair", ok })) },
  { weight: 2, arbitrary: simple("outlineStable") },
  { weight: 1, arbitrary: simple("outlineFails") },
  { weight: 1, arbitrary: simple("outlineDone") },
  { weight: 1, arbitrary: simple("retryTimer") },
  { weight: 1, arbitrary: simple("drain") },
  { weight: 1, arbitrary: simple("retryMarks") },
  { weight: 1, arbitrary: simple("discard") },
  { weight: 4, arbitrary: simple("recoveryFlush") },
);

export const queueCommands: fc.Arbitrary<QueueCmd[]> = fc.oneof(
  { weight: 6, arbitrary: fc.array(queueCommand, { minLength: 1, maxLength: 40, size: "max" }) },
  { weight: 1, arbitrary: fc.array(recoveryCommand, { minLength: 1, maxLength: 40, size: "max" })
      .map((cmds): QueueCmd[] => [{ t: "offline" }, ...cmds]) },
);
