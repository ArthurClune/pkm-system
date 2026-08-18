// pattern: Functional Core
// Which recovery a "Retry" click means. The banner offers one button for five
// different problem states, and the answer depends only on the current problem
// plus whether startup's poison gate is still up — no I/O, so it is decided
// here and executed by SyncProvider.
//
// Precedence is the order below and is load-bearing: a rejected batch whose
// durable mark never landed must retry the MARK (never a repair over unmarked
// rows), and a mark retry that happens while startup discovery is still gated
// must continue startup with the marks it just got rather than resume delivery.
import type { SyncProblem } from "./syncState";

export type RetryPlan =
  /** Re-run the legacy active-outline repair for the retained rejection. */
  | { kind: "legacy-repair" }
  /** Retry durable poison marking only; never an /api/ops POST. When
   * `continueStartup`, the returned marks feed startup's discovery gate,
   * otherwise the in-flight repair is awaited and the replica restarted. */
  | { kind: "retry-poison-marks"; continueStartup: boolean }
  /** Discovery itself failed: re-run startup with no returned marks. */
  | { kind: "continue-startup" }
  /** Repair the retained poison targets again, then restart the replica. */
  | { kind: "repair-targets" }
  /** Nothing retryable (no problem, or one whose state offers no Retry). */
  | { kind: "none" };

export function planRetry(
  problem: SyncProblem | undefined,
  context: { startupDiscoveringPoison: boolean },
): RetryPlan {
  if (problem === undefined) return { kind: "none" };
  switch (problem.kind) {
    case "legacy-rejected":
      return problem.repair === "failed"
        ? { kind: "legacy-repair" } : { kind: "none" };
    case "rejected-batch":
      if (problem.repair === "mark-failed") {
        return { kind: "retry-poison-marks",
                 continueStartup: context.startupDiscoveringPoison };
      }
      return problem.repair === "failed"
        ? { kind: "repair-targets" } : { kind: "none" };
    case "poison-discovery":
      return { kind: "continue-startup" };
    case "replica-unavailable":
    case "replica-stalled":
      // Neither offers a Retry: the first is latched for the session and the
      // banner offers Reload, the second offers Reset local data.
      return { kind: "none" };
    default: {
      const exhaustive: never = problem;
      throw new Error(`unhandled sync problem: ${String(exhaustive)}`);
    }
  }
}
