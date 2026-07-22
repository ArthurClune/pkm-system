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

  it("explains a stalled replica offline", () => {
    expect(computeEditability("reconnecting", "stalled", false)).toEqual({
      canEdit: false,
      readOnlyReason: "local data is stale — reset local data to recover",
    });
  });

  it("still allows connected editing while stalled (server-authoritative)", () => {
    expect(computeEditability("connected", "stalled", false)).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

  it("quota exhaustion still wins over a stalled replica", () => {
    expect(computeEditability("reconnecting", "stalled", true)).toEqual({
      canEdit: false,
      readOnlyReason: "local storage is full — reconnect to sync",
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

describe("transitionSync replica-stalled lifecycle", () => {
  it("sets a stalled problem with reset idle", () => {
    const t = transitionSync(createSyncState(), {
      type: "replica-stalled", error: "replica db locked",
    });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "replica db locked", reset: "idle",
    });
    expect(t.effects).toEqual([]);
  });

  it("never clobbers a delivery problem of a different kind", () => {
    const existing: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "running",
    };
    const t = transitionSync(withProblem(existing), {
      type: "replica-stalled", error: "replica db locked",
    });
    expect(t.state.problem).toEqual(existing);
    expect(t.effects).toEqual([]);
  });

  it("updates the error text on a re-report without stomping an in-flight reset", () => {
    const running = withProblem({
      kind: "replica-stalled", error: "old error", reset: "running",
    } as SyncProblem);
    const t = transitionSync(running, {
      type: "replica-stalled", error: "new error",
    });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "new error", reset: "running",
    });
  });

  it("updates the error text and pending/resetError on a re-report, preserving reset", () => {
    const blocked = withProblem({
      kind: "replica-stalled", error: "old error", reset: "blocked", pending: 3,
    } as SyncProblem);
    const t = transitionSync(blocked, {
      type: "replica-stalled", error: "new error",
    });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "new error", reset: "blocked", pending: 3,
    });
  });

  it("clears a replica-stalled problem on unstall when not mid-reset", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    }), { type: "replica-unstalled" });
    expect(t.state.problem).toBeUndefined();
  });

  it("does not clear a replica-stalled problem on unstall while a reset is running", () => {
    const running: SyncProblem = {
      kind: "replica-stalled", error: "x", reset: "running",
    };
    const t = transitionSync(withProblem(running), { type: "replica-unstalled" });
    expect(t.state.problem).toEqual(running);
  });

  it("leaves other problem kinds alone on unstall", () => {
    const other: SyncProblem = { kind: "poison-discovery", error: "y" };
    const t = transitionSync(withProblem(other), { type: "replica-unstalled" });
    expect(t.state.problem).toEqual(other);
  });

  it("does nothing on unstall when there is no problem", () => {
    const t = transitionSync(createSyncState(), { type: "replica-unstalled" });
    expect(t.state.problem).toBeUndefined();
    expect(t.effects).toEqual([]);
  });

  it("moves reset to running on reset-started, clearing pending/resetError", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "failed", resetError: "boom",
    }), { type: "reset-started" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "x", reset: "running",
      pending: undefined, resetError: undefined,
    });
    expect(t.effects).toEqual([]);
  });

  it("defensively creates a replica-stalled problem on reset-started if missing", () => {
    const t = transitionSync(createSyncState(), { type: "reset-started" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "", reset: "running",
      pending: undefined, resetError: undefined,
    });
  });

  it("carries pending on reset-blocked", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "running",
    }), { type: "reset-blocked", pending: 4 });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "x", reset: "blocked", pending: 4,
      resetError: undefined,
    });
  });

  it("carries resetError on reset-failed", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "running",
    }), { type: "reset-failed", error: "reset boom" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "x", reset: "failed",
      resetError: "reset boom", pending: undefined,
    });
  });

  it("clears the problem and bumps resync on reset-succeeded", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "running",
    }), { type: "reset-succeeded" });
    expect(t.state.problem).toBeUndefined();
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("bumps resync on reset-succeeded but leaves an unrelated problem alone", () => {
    const other: SyncProblem = { kind: "poison-discovery", error: "y" };
    const t = transitionSync(withProblem(other), { type: "reset-succeeded" });
    expect(t.state.problem).toEqual(other);
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("does not clobber a rejected-batch problem on reset-started", () => {
    const existing: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "running",
    };
    const t = transitionSync(withProblem(existing), { type: "reset-started" });
    expect(t.state.problem).toEqual(existing);
    expect(t.effects).toEqual([]);
  });

  it("does not clobber a rejected-batch problem on reset-blocked", () => {
    const existing: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "running",
    };
    const t = transitionSync(withProblem(existing), { type: "reset-blocked", pending: 2 });
    expect(t.state.problem).toEqual(existing);
    expect(t.effects).toEqual([]);
  });

  it("does not clobber a rejected-batch problem on reset-failed", () => {
    const existing: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "running",
    };
    const t = transitionSync(withProblem(existing), { type: "reset-failed", error: "boom" });
    expect(t.state.problem).toEqual(existing);
    expect(t.effects).toEqual([]);
  });

  it("defensively creates a replica-stalled problem with reset blocked when missing", () => {
    const t = transitionSync(createSyncState(), { type: "reset-blocked", pending: 5 });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "", reset: "blocked", pending: 5,
      resetError: undefined,
    });
  });

  it("defensively creates a replica-stalled problem with reset failed when missing", () => {
    const t = transitionSync(createSyncState(), { type: "reset-failed", error: "boom" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "", reset: "failed",
      resetError: "boom", pending: undefined,
    });
  });
});

describe("transitionSync exhaustiveness", () => {
  it("throws on an unknown event", () => {
    expect(() => transitionSync(createSyncState(), { type: "nope" } as unknown as SyncEvent))
      .toThrow();
  });
});
