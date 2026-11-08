// pattern: Functional Core
// The queue property's command alphabet (queueHarness.ts runs it). Edits
// carry their fate with them: how the worker's write goes, whether the queue
// or the replica refuses it, and whether the server rejects it. Each other
// command answers, holds or releases one thing the queue is waiting on.
import fc from "fast-check";
import type { QueueCmd, Respond } from "./queueHarness";
import type { Persist, Refusal } from "./queueModel";

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
}).map(({ persist, refusal, bad }) => ({ t: "edit", persist, refusal, bad }));

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
  { weight: 3, arbitrary: simple("legacyStable") },
  { weight: 1, arbitrary: simple("legacyFails") },
  { weight: 1, arbitrary: simple("legacyDone") },
  { weight: 1, arbitrary: simple("retryTimer") },
  { weight: 1, arbitrary: simple("drain") },
);

export const queueCommands: fc.Arbitrary<QueueCmd[]> =
  fc.array(queueCommand, { minLength: 1, maxLength: 40, size: "max" });
