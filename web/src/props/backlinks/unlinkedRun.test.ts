import { describe, expect, it } from "vitest";
import type { Example } from "./unlinkedArbitraries";
import { REAL_OPS, runExample } from "./unlinkedRun";

const chain = (block: number): Example["steps"] => [
  { block, to: "pending" }, { block, to: "settled" }, { block, to: "delivered" },
  { block, to: "error a" },
];

describe("the unlinked property's runner", () => {
  it("walks the lifecycle and sees a delivered block stay delivered", () => {
    const run = runExample({ loaded: 4, steps: chain(1) });
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("delivered stays delivered");
  });

  it("sees a delivered block that can fail", () => {
    const run = runExample({ loaded: 4, steps: chain(0) }, {
      ...REAL_OPS,
      withStatus: (statuses, uid, status) =>
        statuses.get(uid) === "delivered" && typeof status === "object"
          ? new Map(statuses).set(uid, status)
          : REAL_OPS.withStatus(statuses, uid, status),
    });
    expect(run.problems.some((p) => p.startsWith("lifecycle: "))).toBe(true);
  });
});
