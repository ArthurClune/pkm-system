import { describe, expect, it } from "vitest";
import { planRetry, type RetryPlan } from "./retryPolicy";
import type { SyncProblem } from "./syncState";

const event = {
  rowId: 7, batchId: "bad-batch",
  ops: [{ op: "delete" as const, uid: "uid_bad" }],
  status: 400, message: "request failed: 400 /api/ops",
};

const open = { startupDiscoveringPoison: true };
const closed = { startupDiscoveringPoison: false };

const cases: Array<[string, SyncProblem | undefined,
                    { startupDiscoveringPoison: boolean }, RetryPlan]> = [
  ["no problem at all", undefined, closed, { kind: "none" }],
  ["a legacy repair still running",
   { kind: "legacy-rejected", repair: "running", error: "400" }, closed,
   { kind: "none" }],
  ["a repaired legacy rejection (Dismiss, not Retry)",
   { kind: "legacy-rejected", repair: "repaired", error: "400" }, closed,
   { kind: "none" }],
  ["a failed legacy repair",
   { kind: "legacy-rejected", repair: "failed", error: "400",
     repairError: "page read failed" }, closed, { kind: "legacy-repair" }],
  ["a rejected batch mid-repair",
   { kind: "rejected-batch", event, repair: "running" }, closed,
   { kind: "none" }],
  ["a repaired rejected batch",
   { kind: "rejected-batch", event, repair: "repaired" }, closed,
   { kind: "none" }],
  ["a failed rejected-batch repair",
   { kind: "rejected-batch", event, repair: "failed", error: "snapshot 503" },
   closed, { kind: "repair-targets" }],
  ["a failed durable mark, startup already past discovery",
   { kind: "rejected-batch", event, repair: "mark-failed", error: "no worker" },
   closed, { kind: "retry-poison-marks", continueStartup: false }],
  ["a failed durable mark while startup discovery is still gated",
   { kind: "rejected-batch", event, repair: "mark-failed", error: "no worker" },
   open, { kind: "retry-poison-marks", continueStartup: true }],
  ["failed poison discovery",
   { kind: "poison-discovery", error: "worker read failed" }, closed,
   { kind: "continue-startup" }],
  ["an online-only session (Reload, not Retry)",
   { kind: "replica-unavailable", error: "no access handles" }, open,
   { kind: "none" }],
  ["a stalled replica (Reset local data, not Retry)",
   { kind: "replica-stalled", error: "db locked", reset: "idle" }, open,
   { kind: "none" }],
];

describe("planRetry", () => {
  it.each(cases)("plans %s", (_name, problem, context, expected) => {
    expect(planRetry(problem, context)).toEqual(expected);
  });

  it("prefers the mark retry over a repair for a mark-failed rejection", () => {
    // Precedence, not coincidence: repairing rows whose poison mark never
    // landed would rebase over batches the queue still believes are deliverable.
    expect(planRetry(
      { kind: "rejected-batch", event, repair: "mark-failed", error: "x" },
      closed,
    )).toMatchObject({ kind: "retry-poison-marks" });
  });

  it("rejects an unknown problem kind rather than silently doing nothing", () => {
    expect(() => planRetry(
      { kind: "brand-new" } as unknown as SyncProblem, closed,
    )).toThrow(/unhandled sync problem/);
  });
});
