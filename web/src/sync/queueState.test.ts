import { describe, expect, it } from "vitest";
import {
  createQueueState,
  RETRY_DELAYS,
  terminalReason,
  transitionQueue,
  type QueueEvent,
  type QueueState,
} from "./queueState";

const base = (over: Partial<QueueState> = {}): QueueState => ({
  ...createQueueState(),
  ...over,
});

describe("terminalReason", () => {
  it("prioritises disposed over recovering over offline", () => {
    expect(terminalReason(base({
      disposed: true, holders: new Set(["poison"]), online: false,
    }))).toBe("disposed");
    expect(terminalReason(base({ holders: new Set(["lane"]), online: false })))
      .toBe("recovering");
    expect(terminalReason(base({ online: false }))).toBe("offline");
    expect(terminalReason(base())).toBeNull();
  });
});

describe("transitionQueue connectivity", () => {
  it("going online clears any retry and kicks the pump", () => {
    const t = transitionQueue(base({ retryScheduled: true, retryIndex: 2 }), {
      type: "set-online", online: true,
    });
    expect(t.state).toMatchObject({ online: true, retryScheduled: false, retryIndex: 0 });
    expect(t.effects).toEqual([{ type: "clear-timer" }, { type: "kick" }]);
  });

  it("going offline clears the retry without kicking", () => {
    const t = transitionQueue(base({ retryScheduled: true, retryIndex: 2 }), {
      type: "set-online", online: false,
    });
    expect(t.state).toMatchObject({ online: false, retryScheduled: false, retryIndex: 0 });
    expect(t.effects).toEqual([{ type: "clear-timer" }]);
  });

  it("pause enters recovery and cancels the timer, keeping the retry index", () => {
    const t = transitionQueue(base({ retryScheduled: true, retryIndex: 2 }),
                              { type: "pause", owner: "recovery" });
    expect(t.state).toMatchObject({ retryScheduled: false, retryIndex: 2 });
    expect([...t.state.holders]).toEqual(["recovery"]);
    expect(t.effects).toEqual([{ type: "clear-timer" }]);
  });

  it("resume releases only its own owner, and kicks when none is left", () => {
    const both = base({ holders: new Set(["poison", "lane"]) });
    const one = transitionQueue(both, { type: "resume", owner: "lane" });
    expect([...one.state.holders]).toEqual(["poison"]);
    expect(terminalReason(one.state)).toBe("recovering");
    expect(one.effects).toEqual([]);

    const none = transitionQueue(one.state, { type: "resume", owner: "poison" });
    expect(none.state.holders.size).toBe(0);
    expect(none.effects).toEqual([{ type: "kick" }]);
  });

  it("a resume by an owner that holds nothing changes nothing", () => {
    const held = base({ holders: new Set(["poison"]) });
    const noop = transitionQueue(held, { type: "resume", owner: "lane" });
    expect(noop.state).toBe(held);
    expect(noop.effects).toEqual([]);

    const idle = transitionQueue(base(), { type: "resume", owner: "recovery" });
    expect(idle.effects).toEqual([]);
  });

  it("dispose is terminal and idempotent", () => {
    const t = transitionQueue(base({ retryScheduled: true }), { type: "dispose" });
    expect(t.state).toMatchObject({ disposed: true, online: false, retryScheduled: false });
    expect(t.effects).toEqual([{ type: "clear-timer" }]);

    const again = transitionQueue(t.state, { type: "dispose" });
    expect(again.state).toEqual(t.state);
    expect(again.effects).toEqual([]);
  });
});

describe("transitionQueue delivery outcomes", () => {
  it("a successful batch resets the retry backoff", () => {
    const t = transitionQueue(base({ retryScheduled: true, retryIndex: 3 }), {
      type: "batch-succeeded",
    });
    expect(t.state).toMatchObject({ retryScheduled: false, retryIndex: 0 });
    expect(t.effects).toEqual([{ type: "clear-timer" }]);
  });

  it("a retryable failure schedules an escalating backoff", () => {
    const first = transitionQueue(base(), { type: "delivery-failed" });
    expect(first.blockedReason).toBe("retryable");
    expect(first.effects).toEqual([{ type: "start-timer", delayMs: RETRY_DELAYS[0] }]);
    expect(first.state.retryIndex).toBe(1);

    const second = transitionQueue(first.state, { type: "delivery-failed" });
    // already scheduled: still retryable, but no second timer.
    expect(second.blockedReason).toBe("retryable");
    expect(second.effects).toEqual([]);
  });

  it("caps the backoff at the last configured delay", () => {
    let s = base({ retryIndex: RETRY_DELAYS.length - 1 });
    const t = transitionQueue(s, { type: "delivery-failed" });
    expect(t.effects).toEqual([{
      type: "start-timer", delayMs: RETRY_DELAYS[RETRY_DELAYS.length - 1],
    }]);
    expect(t.state.retryIndex).toBe(RETRY_DELAYS.length - 1);
    // retry-fired re-opens scheduling for the next failure.
    s = transitionQueue(t.state, { type: "retry-fired" }).state;
    expect(s.retryScheduled).toBe(false);
  });

  it("a terminal failure reports its reason and never schedules a retry", () => {
    for (const [state, reason] of [
      [base({ disposed: true }), "disposed"],
      [base({ holders: new Set(["startup"]) }), "recovering"],
      [base({ online: false }), "offline"],
    ] as [QueueState, string][]) {
      const t = transitionQueue(state, { type: "delivery-failed" });
      expect(t.blockedReason).toBe(reason);
      expect(t.effects).toEqual([]);
    }
  });

  it("is exhaustive over its event union", () => {
    expect(() => transitionQueue(base(), { type: "bogus" } as unknown as QueueEvent))
      .toThrow();
  });
});
