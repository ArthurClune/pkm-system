import { describe, expect, it } from "vitest";
import type { PoisonEvent } from "../../sync/opQueue";
import type { SyncEvent } from "../../sync/syncState";
import { expectedBanner } from "./bannerModel";
import { batchIdOf, pendingRowIdOf } from "../../test-helpers";

const event: PoisonEvent = {
  id: pendingRowIdOf(1), batch_id: batchIdOf("b-1"), ops: [], status: 400, message: "bad",
};
const mode = (m: "ready" | "stalled" | "no-replica" | "recovery-failed",
              status: "connected" | "reconnecting" = "connected"): SyncEvent => ({
  type: "replica-state", prev: "ready", status,
  state: m === "ready" ? { mode: m } : { mode: m, error: "x" },
});
const view = (events: SyncEvent[], held = false): unknown => {
  const want = expectedBanner(events, held);
  return "view" in want ? want.view : want;
};

describe("expectedBanner", () => {
  it("shows the poison problem's latest phase while the replica is there", () => {
    expect(view([{ type: "repair-started", event }])).toBe("rejected-batch running");
    expect(view([{ type: "poison-mark-failed", event, error: "e" },
                 { type: "poison-intents-discarded" }])).toBe("none");
  });

  it("shows a stall only while connected or stalled, until ready", () => {
    expect(view([mode("recovery-failed", "reconnecting")])).toBe("none");
    expect(view([mode("recovery-failed")])).toBe("replica-stalled");
    expect(view([mode("stalled"), mode("ready")])).toBe("none");
  });

  it("puts the online-only banner over a stall and a problem that needs the worker", () => {
    expect(view([mode("stalled"), mode("no-replica")])).toBe("replica-unusable");
    expect(view([{ type: "repair-started", event }, mode("no-replica")], true))
      .toBe("replica-unusable paused");
    expect(view([mode("no-replica"), { type: "poison-discovery-failed", error: "e" }], true))
      .toBe("replica-unusable paused");
  });

  it("keeps a failed mark and a repaired batch, and comes back when one ends", () => {
    const marked: SyncEvent[] = [{ type: "poison-mark-failed", event, error: "e" },
                                 mode("no-replica")];
    expect(view(marked)).toBe("rejected-batch mark-failed");
    expect(view([...marked, { type: "poison-intents-discarded" }]))
      .toBe("replica-unusable");
    expect(view([{ type: "repair-succeeded", event }, mode("no-replica")]))
      .toBe("rejected-batch repaired");
  });

  it("does not judge what the docs leave to the code", () => {
    expect(expectedBanner([{ type: "dismiss" }], false)).toEqual({ unmodelled: "dismiss" });
    expect(expectedBanner([mode("stalled"), { type: "repair-started", event }], false))
      .toEqual({ unmodelled: "a stall report beside a poison problem" });
  });
});
