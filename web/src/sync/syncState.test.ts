import { describe, expect, it } from "vitest";
import type { PoisonEvent } from "./opQueue";
import {
  computeEditability,
  createSyncState,
  transitionSync,
  type SyncEvent,
  type SyncProblem,
} from "./syncState";

const poison = (over: Partial<PoisonEvent> = {}): PoisonEvent => ({
  rowId: 1,
  batchId: "b1",
  ops: [],
  status: 409,
  message: "conflict",
  ...over,
});

const withProblem = (problem: SyncProblem | undefined) => ({ problem });

describe("computeEditability", () => {
  it("allows editing while connected", () => {
    expect(computeEditability("connected", "starting", false)).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

  it("allows offline editing with a ready replica and free storage", () => {
    expect(computeEditability("reconnecting", "ready", false)).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

  it("freezes the editor when local storage is full offline", () => {
    expect(computeEditability("reconnecting", "ready", true)).toEqual({
      canEdit: false,
      readOnlyReason: "local storage is full — reconnect to sync",
    });
  });

  it("explains a failed recovery", () => {
    expect(computeEditability("reconnecting", "recovery-failed", false)).toEqual({
      canEdit: false,
      readOnlyReason: "local data recovery failed — reconnect to continue",
    });
  });

  it("explains a graph not yet available locally", () => {
    expect(computeEditability("reconnecting", "starting", false)).toEqual({
      canEdit: false,
      readOnlyReason: "offline — this graph is not yet available locally",
    });
  });
});

describe("transitionSync mode-ready resync", () => {
  it("bumps resync when the replica becomes ready while the socket is down", () => {
    const t = transitionSync(createSyncState(), {
      type: "mode-ready-check", prevMode: "starting", mode: "ready",
      status: "reconnecting",
    });
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("does not bump when already connected", () => {
    const t = transitionSync(createSyncState(), {
      type: "mode-ready-check", prevMode: "starting", mode: "ready",
      status: "connected",
    });
    expect(t.effects).toEqual([]);
  });

  it("does not bump when the mode was already ready", () => {
    const t = transitionSync(createSyncState(), {
      type: "mode-ready-check", prevMode: "ready", mode: "ready",
      status: "reconnecting",
    });
    expect(t.effects).toEqual([]);
  });
});

describe("transitionSync rejected-batch repair", () => {
  const event = poison();

  it("marks a poison mark failure", () => {
    const t = transitionSync(createSyncState(), {
      type: "poison-mark-failed", event, error: "rpc down",
    });
    expect(t.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "mark-failed", error: "rpc down",
    });
    expect(t.effects).toEqual([]);
  });

  it("runs then succeeds a repair, bumping resync only on success", () => {
    const running = transitionSync(createSyncState(), {
      type: "repair-started", event,
    });
    expect(running.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "running",
    });
    expect(running.effects).toEqual([]);

    const done = transitionSync(running.state, { type: "repair-succeeded", event });
    expect(done.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "repaired",
    });
    expect(done.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("records a repair failure without a resync bump", () => {
    const t = transitionSync(withProblem({
      kind: "rejected-batch", event, repair: "running",
    }), { type: "repair-failed", event, error: "boom" });
    expect(t.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "failed", error: "boom",
    });
    expect(t.effects).toEqual([]);
  });

  it("dismisses only a repaired problem", () => {
    const repaired = transitionSync(withProblem({
      kind: "rejected-batch", event, repair: "repaired",
    }), { type: "dismiss" });
    expect(repaired.state.problem).toBeUndefined();

    const running = transitionSync(withProblem({
      kind: "rejected-batch", event, repair: "running",
    }), { type: "dismiss" });
    expect(running.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "running",
    });
  });
});

describe("transitionSync poison discovery", () => {
  it("reports a discovery failure", () => {
    const t = transitionSync(createSyncState(), {
      type: "poison-discovery-failed", error: "read failed",
    });
    expect(t.state.problem).toEqual({ kind: "poison-discovery", error: "read failed" });
  });

  it("clears a discovery problem, leaving other problems alone", () => {
    const cleared = transitionSync(withProblem({
      kind: "poison-discovery", error: "x",
    }), { type: "poison-discovery-cleared" });
    expect(cleared.state.problem).toBeUndefined();

    const other: SyncProblem = {
      kind: "legacy-rejected", repair: "running", error: "y",
    };
    const kept = transitionSync(withProblem(other), {
      type: "poison-discovery-cleared",
    });
    expect(kept.state.problem).toEqual(other);
  });
});

describe("transitionSync legacy repair", () => {
  it("runs, succeeds (bumping resync), and fails", () => {
    const running = transitionSync(createSyncState(), {
      type: "legacy-repair-started", error: "reject",
    });
    expect(running.state.problem).toEqual({
      kind: "legacy-rejected", repair: "running", error: "reject",
    });

    const done = transitionSync(running.state, {
      type: "legacy-repair-succeeded", error: "reject",
    });
    expect(done.state.problem).toEqual({
      kind: "legacy-rejected", repair: "repaired", error: "reject",
    });
    expect(done.effects).toEqual([{ type: "bump-resync" }]);

    const failed = transitionSync(running.state, {
      type: "legacy-repair-failed", error: "reject", repairError: "still bad",
    });
    expect(failed.state.problem).toEqual({
      kind: "legacy-rejected", repair: "failed", error: "reject",
      repairError: "still bad",
    });
  });

  it("dismisses a repaired legacy problem", () => {
    const t = transitionSync(withProblem({
      kind: "legacy-rejected", repair: "repaired", error: "reject",
    }), { type: "dismiss" });
    expect(t.state.problem).toBeUndefined();
  });
});

describe("transitionSync exhaustiveness", () => {
  it("throws on an unknown event", () => {
    expect(() => transitionSync(createSyncState(), { type: "nope" } as unknown as SyncEvent))
      .toThrow();
  });
});
