import { describe, expect, it } from "vitest";
import type { PoisonEvent } from "./opQueue";
import type { ReplicaState } from "./replicaSync";
import { computeEditability, transitionSync, type ReplicaMode, type SyncEvent,
         type SyncProblem, type SyncState, type SyncStatus } from "./syncState";
import { pendingRowIdOf, batchIdOf, offType } from "../test-helpers";

// Test-only: production code builds a SyncState inline (session.ts starts
// from `{ problem: undefined }`), so this constructor lives here rather than
// as a production export.
const createSyncState = (): SyncState => ({ problem: undefined });

const poison = (over: Partial<PoisonEvent> = {}): PoisonEvent => ({
  id: pendingRowIdOf(1),
  batch_id: batchIdOf("b1"),
  ops: [],
  status: 409,
  message: "conflict",
  ...over,
});

const withProblem = (problem: SyncProblem | undefined) => ({ problem });

const modeReport = (
  state: ReplicaState, status: SyncStatus = "connected",
  prev: ReplicaMode = "starting",
): SyncEvent => ({ type: "replica-state", prev, state, status });

const STATUSES: readonly SyncStatus[] = ["connecting", "connected", "reconnecting"];

describe("computeEditability", () => {
  it("allows editing while connected", () => {
    expect(computeEditability("connected", "starting")).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

  it("allows offline editing with a ready replica, even if writes may fail", () => {
    // There is no storage-exhaustion read-only mode: an exhausted disk is
    // indistinguishable from any other SQLITE_IOERR, so a write that
    // cannot be persisted is retained by the op queue rather than refused here.
    expect(computeEditability("reconnecting", "ready")).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

  it("explains a failed recovery", () => {
    expect(computeEditability("reconnecting", "recovery-failed")).toEqual({
      canEdit: false,
      readOnlyReason: "local data recovery failed — reconnect to continue",
    });
  });

  it("explains a graph not yet available locally", () => {
    expect(computeEditability("reconnecting", "starting")).toEqual({
      canEdit: false,
      readOnlyReason: "offline — this graph is not yet available locally",
    });
  });

  it("explains a stalled replica offline", () => {
    expect(computeEditability("reconnecting", "stalled")).toEqual({
      canEdit: false,
      readOnlyReason: "local data is stale — reset local data to recover",
    });
  });

  it("still allows connected editing while stalled (server-authoritative)", () => {
    expect(computeEditability("connected", "stalled")).toEqual({
      canEdit: true, readOnlyReason: undefined,
    });
  });

});

describe("transitionSync mode-ready resync", () => {
  it("bumps resync when the replica becomes ready while the socket is down", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "ready" }, "reconnecting", "starting"));
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("does not bump when already connected", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "ready" }, "connected", "starting"));
    expect(t.effects).toEqual([]);
  });

  it("does not bump when the mode was already ready", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "ready" }, "reconnecting", "ready"));
    expect(t.effects).toEqual([]);
  });
});

describe("transitionSync replica-state", () => {
  it.each(STATUSES)("stalled raises replica-stalled whatever the socket (%s)",
    (status) => {
      const t = transitionSync(createSyncState(),
        modeReport({ mode: "stalled", error: "db locked" }, status));
      expect(t.state.problem).toEqual({
        kind: "replica-stalled", error: "db locked", reset: "idle",
      });
      expect(t.effects).toEqual([]);
    });

  it("recovery-failed raises replica-stalled only while connected", () => {
    const failed: ReplicaState = { mode: "recovery-failed", error: "boom" };
    const connected = transitionSync(createSyncState(),
      modeReport(failed, "connected"));
    expect(connected.state.problem).toEqual({
      kind: "replica-stalled", error: "boom", reset: "idle",
    });
    for (const status of ["connecting", "reconnecting"] as const) {
      const before = createSyncState();
      const t = transitionSync(before, modeReport(failed, status));
      expect(t.state).toBe(before);
      expect(t.effects).toEqual([]);
    }
  });

  it("ready clears an idle stalled problem", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    }), modeReport({ mode: "ready" }, "connected", "stalled"));
    expect(t.state.problem).toBeUndefined();
    expect(t.effects).toEqual([]);
  });

  it("ready keeps a stalled problem whose reset is running", () => {
    const running: SyncProblem = {
      kind: "replica-stalled", error: "x", reset: "running",
    };
    const t = transitionSync(withProblem(running),
      modeReport({ mode: "ready" }, "connected", "stalled"));
    expect(t.state.problem).toEqual(running);
  });

  it("no-replica with an error raises replica-unusable", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "no-replica", error: "worker died" }, "connected", "ready"));
    expect(t.state.problem).toEqual({
      kind: "replica-unusable", error: "worker died",
    });
    expect(t.effects).toEqual([]);
  });

  it("a no-replica report replaces a stalled banner", () => {
    // Reset local data cannot work on a replica that is gone: the stalled
    // banner's Reset gives way to the online-only banner's Reload.
    for (const reset of ["idle", "running", "blocked", "failed"] as const) {
      const t = transitionSync(withProblem({
        kind: "replica-stalled", error: "x", reset,
      }), modeReport({ mode: "no-replica", error: "worker died" },
                     "connected", "stalled"));
      expect(t.state.problem).toEqual({
        kind: "replica-unusable", error: "worker died",
      });
    }
  });

  it("a delivery problem that ends after a no-replica report gives way to " +
     "the online-only banner", () => {
    // The replica's death is reported once, so a banner held off by a
    // delivery problem must come back when that problem ends.
    const gone = modeReport({ mode: "no-replica", error: "worker died" });
    const unusable = { kind: "replica-unusable", error: "worker died" };
    const ends: [SyncProblem, SyncEvent][] = [
      [{ kind: "rejected-batch", event: poison(), repair: "mark-failed",
         error: "e" }, { type: "poison-intents-discarded" }],
      [{ kind: "rejected-batch", event: poison(), repair: "repaired" },
       { type: "dismiss" }],
      [{ kind: "outline-rejected", repair: "repaired", error: "e" },
       { type: "dismiss" }],
    ];
    for (const [current, end] of ends) {
      const held = transitionSync(withProblem(current), gone).state;
      expect(held.problem).toEqual(current);
      expect(transitionSync(held, end).state.problem).toEqual(unusable);
    }
  });

  it("the online-only banner keeps its identity across unrelated events", () => {
    const shown = transitionSync(createSyncState(),
      modeReport({ mode: "no-replica", error: "worker died" })).state;
    const after = transitionSync(shown, { type: "ops-skipped" });
    expect(after.state.problem).toBe(shown.problem);
    expect(after.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("a no-replica report keeps a delivery problem whose action works " +
     "without the worker", () => {
    const kept: SyncProblem[] = [
      { kind: "rejected-batch", event: poison(), repair: "mark-failed",
        error: "e" },
      { kind: "rejected-batch", event: poison(), repair: "repaired" },
      { kind: "outline-rejected", repair: "failed", error: "e",
        repairError: "r" },
      { kind: "outline-rejected", repair: "running", error: "e" },
      { kind: "outline-rejected", repair: "repaired", error: "e" },
    ];
    for (const current of kept) {
      const t = transitionSync(withProblem(current),
        modeReport({ mode: "no-replica", error: "worker died" }, "connected"));
      expect(t.state.problem).toEqual(current);
    }
  });

  it("starting changes nothing", () => {
    const stalled = withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    });
    for (const status of STATUSES) {
      const t = transitionSync(stalled,
        modeReport({ mode: "starting" }, status, "ready"));
      expect(t.state).toBe(stalled);
      expect(t.effects).toEqual([]);
    }
  });

  it.each(["connecting", "reconnecting"] as const)(
    "turning ready while disconnected bumps resync (%s)", (status) => {
      const t = transitionSync(createSyncState(),
        modeReport({ mode: "ready" }, status, "starting"));
      expect(t.state.problem).toBeUndefined();
      expect(t.effects).toEqual([{ type: "bump-resync" }]);
    });

  it("turning ready while disconnected clears an idle stall and bumps", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    }), modeReport({ mode: "ready" }, "reconnecting", "stalled"));
    expect(t.state.problem).toBeUndefined();
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("turning ready while connected does not bump", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "ready" }, "connected", "starting"));
    expect(t.effects).toEqual([]);
  });

  it("a ready re-report does not bump", () => {
    for (const status of STATUSES) {
      const t = transitionSync(createSyncState(),
        modeReport({ mode: "ready" }, status, "ready"));
      expect(t.effects).toEqual([]);
    }
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

  it("clears a mark-failed problem when its retained intents are discarded", () => {
    // The discard escape hatch. replica-unusable deliberately
    // never stomps another problem kind, so without this event the stale
    // mark-failed banner would outlive the intents it reports on.
    const t = transitionSync(withProblem({
      kind: "rejected-batch", event, repair: "mark-failed", error: "rpc down",
    }), { type: "poison-intents-discarded" });
    expect(t.state.problem).toBeUndefined();
    expect(t.effects).toEqual([]);
  });

  it("leaves non-mark-failed problems untouched on intent discard", () => {
    // Discard is only offered on the mark-failed banner; a racing repair or
    // an unrelated problem must not lose its state to a late click.
    const running = transitionSync(withProblem({
      kind: "rejected-batch", event, repair: "running",
    }), { type: "poison-intents-discarded" });
    expect(running.state.problem).toEqual({
      kind: "rejected-batch", event, repair: "running",
    });

    const stalled = transitionSync(withProblem({
      kind: "replica-stalled", error: "stall", reset: "idle",
    }), { type: "poison-intents-discarded" });
    expect(stalled.state.problem).toEqual({
      kind: "replica-stalled", error: "stall", reset: "idle",
    });
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

  it("reports a session committed to online-only", () => {
    // This state must not be silent. The user has lost offline
    // editing for the session and needs to know, and to have a way out.
    const t = transitionSync(createSyncState(), modeReport({
      mode: "no-replica", error: "Access Handles cannot be created",
    }));
    expect(t.state.problem).toEqual({
      kind: "replica-unusable",
      error: "Access Handles cannot be created",
    });
  });

  it("online-only never stomps a delivery problem the user can act on", () => {
    // replica-unusable needs a precedence rule: without one it would
    // overwrite a failed outline repair — and with it the Retry that reaches
    // the outline repair (outlineRepair.ts), stranding that repair.
    const failed: SyncProblem = {
      kind: "outline-rejected", repair: "failed",
      error: "rejected", repairError: "snapshot unavailable",
    };
    const t = transitionSync(withProblem(failed), modeReport({
      mode: "no-replica", error: "Access Handles cannot be created",
    }));
    expect(t.state.problem).toEqual(failed);
  });

  it("clears a discovery problem, leaving other problems alone", () => {
    const cleared = transitionSync(withProblem({
      kind: "poison-discovery", error: "x",
    }), { type: "poison-discovery-cleared" });
    expect(cleared.state.problem).toBeUndefined();

    const other: SyncProblem = {
      kind: "outline-rejected", repair: "running", error: "y",
    };
    const kept = transitionSync(withProblem(other), {
      type: "poison-discovery-cleared",
    });
    expect(kept.state.problem).toEqual(other);
  });
});

describe("transitionSync with the replica gone", () => {
  // A rejected batch's repair and startup's poison discovery both run on the
  // replica worker, so once it is gone their Retry cannot work: the
  // online-only banner's Reload takes their place.
  const event = poison();
  const gone = modeReport({ mode: "no-replica", error: "worker died" });
  const unusable: SyncProblem = { kind: "replica-unusable", error: "worker died" };
  const fold = (state: SyncState, ...events: SyncEvent[]): SyncState =>
    events.reduce((s, e) => transitionSync(s, e).state, state);
  const repairFailed: SyncEvent = { type: "repair-failed", event, error: "rpc" };
  const discoveryFailed: SyncEvent = {
    type: "poison-discovery-failed", error: "rpc",
  };

  it("a repair that fails after the replica died offers Reload", () => {
    const state = fold(createSyncState(),
      { type: "repair-started", event }, gone, repairFailed);
    expect(state.problem).toEqual(unusable);
  });

  it("a replica that dies after a repair failed offers Reload", () => {
    const state = fold(createSyncState(),
      { type: "repair-started", event }, repairFailed, gone);
    expect(state.problem).toEqual(unusable);
  });

  it("a running repair yields when the replica dies, and its failure " +
     "keeps the same banner", () => {
    const yielded = fold(createSyncState(), { type: "repair-started", event }, gone);
    expect(yielded.problem).toEqual(unusable);
    const t = transitionSync(yielded, repairFailed);
    expect(t.state.problem).toBe(yielded.problem);
  });

  it("a discovery that fails after the replica died offers Reload", () => {
    expect(fold(createSyncState(), gone, discoveryFailed).problem)
      .toEqual(unusable);
  });

  it("a replica that dies after discovery failed offers Reload", () => {
    expect(fold(createSyncState(), discoveryFailed, gone).problem)
      .toEqual(unusable);
  });

  it("a reconnect's repair rerun does not bring back a Retry", () => {
    const yielded = fold(createSyncState(), gone, discoveryFailed);
    for (const next of [
      { type: "repair-started", event } as const, repairFailed,
      discoveryFailed,
    ]) {
      expect(transitionSync(yielded, next).state.problem).toBe(yielded.problem);
    }
  });

  it("clearing discovery or a dismiss leaves the online-only banner", () => {
    const yielded = fold(createSyncState(), discoveryFailed, gone);
    for (const next of [
      { type: "poison-discovery-cleared" } as const, { type: "dismiss" } as const,
      { type: "poison-intents-discarded" } as const,
    ]) {
      expect(transitionSync(yielded, next).state.problem).toBe(yielded.problem);
    }
  });

  it("a repair that succeeds after all shows repaired, then Reload once " +
     "dismissed", () => {
    const repaired = fold(createSyncState(),
      { type: "repair-started", event }, gone,
      { type: "repair-succeeded", event });
    expect(repaired.problem).toEqual({
      kind: "rejected-batch", event, repair: "repaired",
    });
    expect(fold(repaired, { type: "dismiss" }).problem).toEqual(unusable);
  });

  it("a failed mark keeps its banner: Discard needs no worker", () => {
    // A replica that can never open fails the same mark on every reload, so
    // Reload is no way out; Discard is.
    const markFailed: SyncEvent = {
      type: "poison-mark-failed", event, error: "rpc",
    };
    for (const state of [fold(createSyncState(), gone, markFailed),
                         fold(createSyncState(), markFailed, gone)]) {
      expect(state.problem).toEqual({
        kind: "rejected-batch", event, repair: "mark-failed", error: "rpc",
      });
    }
  });

  it("an outline problem held behind a yielded repair comes forward", () => {
    // Its Retry reads through the server, so it works without the worker,
    // and it outranks the online-only banner as it always has.
    const outlineFailed: SyncEvent = {
      type: "outline-repair-failed", error: "reject", repairError: "bad",
    };
    const state = fold(createSyncState(),
      { type: "repair-started", event }, outlineFailed, repairFailed, gone);
    expect(state.problem).toEqual({
      kind: "outline-rejected", repair: "failed", error: "reject",
      repairError: "bad",
    });
    expect(state.outlineBehind).toBeUndefined();
    const done = fold(state, { type: "outline-repair-succeeded", error: "reject" },
                      { type: "dismiss" });
    expect(done.problem).toEqual(unusable);
  });

  it("an outline repair that starts after a yielded one is shown", () => {
    const state = fold(createSyncState(), discoveryFailed, gone,
                       { type: "outline-repair-started", error: "reject" });
    expect(state.problem).toEqual({
      kind: "outline-rejected", repair: "running", error: "reject",
    });
  });
});

describe("transitionSync delivery held for a poison repair", () => {
  // Delivery waits while "poison" or "startup" holds the barrier. With the
  // replica gone neither claim can be released by a repair or discovery, so
  // the online-only banner says changes are paused.
  const event = poison();
  const gone = modeReport({ mode: "no-replica", error: "worker died" });
  const held: SyncEvent = { type: "delivery-held", held: true };
  const released: SyncEvent = { type: "delivery-held", held: false };
  const paused: SyncProblem = {
    kind: "replica-unusable", error: "worker died", paused: true,
  };
  const fold = (state: SyncState, ...events: SyncEvent[]): SyncState =>
    events.reduce((s, e) => transitionSync(s, e).state, state);

  it("a yielded repair's banner says delivery is paused", () => {
    const state = fold(createSyncState(), held,
      { type: "repair-started", event }, gone,
      { type: "repair-failed", event, error: "rpc" });
    expect(state.problem).toEqual(paused);
  });

  it("a hold that starts after the banner marks it paused, and its " +
     "release unmarks it", () => {
    const shown = fold(createSyncState(), gone);
    expect(shown.problem).toEqual({ kind: "replica-unusable", error: "worker died" });
    const pausedState = fold(shown, held);
    expect(pausedState.problem).toEqual(paused);
    expect(fold(pausedState, released).problem)
      .toEqual({ kind: "replica-unusable", error: "worker died" });
  });

  it("the hold outlives an outline problem that comes forward and is " +
     "dismissed", () => {
    const state = fold(createSyncState(), held,
      { type: "repair-started", event },
      { type: "outline-repair-failed", error: "reject", repairError: "bad" },
      { type: "repair-failed", event, error: "rpc" }, gone);
    expect(state.problem).toMatchObject({ kind: "outline-rejected" });
    const done = fold(state,
      { type: "outline-repair-succeeded", error: "reject" }, { type: "dismiss" });
    expect(done.problem).toEqual(paused);
  });

  it("the paused banner keeps its identity across unrelated events and " +
     "a repeated hold", () => {
    const shown = fold(createSyncState(), held, gone);
    for (const next of [{ type: "ops-skipped" } as const, held]) {
      expect(transitionSync(shown, next).state.problem).toBe(shown.problem);
    }
  });

  it("a hold changes no other problem", () => {
    const markFailed: SyncProblem = {
      kind: "rejected-batch", event, repair: "mark-failed", error: "rpc",
    };
    const state = fold(withProblem(markFailed), gone, held);
    expect(state.problem).toEqual(markFailed);
    expect(fold(state, { type: "poison-intents-discarded" }).problem)
      .toEqual(paused);
  });

  it("with the replica present a hold shows nothing", () => {
    expect(fold(createSyncState(), held).problem).toBeUndefined();
  });
});

describe("transitionSync outline repair", () => {
  it("runs, succeeds (bumping resync), and fails", () => {
    const running = transitionSync(createSyncState(), {
      type: "outline-repair-started", error: "reject",
    });
    expect(running.state.problem).toEqual({
      kind: "outline-rejected", repair: "running", error: "reject",
    });

    const done = transitionSync(running.state, {
      type: "outline-repair-succeeded", error: "reject",
    });
    expect(done.state.problem).toEqual({
      kind: "outline-rejected", repair: "repaired", error: "reject",
    });
    expect(done.effects).toEqual([{ type: "bump-resync" }]);

    const failed = transitionSync(running.state, {
      type: "outline-repair-failed", error: "reject", repairError: "still bad",
    });
    expect(failed.state.problem).toEqual({
      kind: "outline-rejected", repair: "failed", error: "reject",
      repairError: "still bad",
    });
  });

  it("waits behind an unrepaired rejected batch, keeping its Retry", () => {
    const failed: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "failed", error: "boom",
    };
    const started = transitionSync(withProblem(failed), {
      type: "outline-repair-started", error: "over limit",
    });
    expect(started.state.problem).toEqual(failed);
    const succeeded = transitionSync(started.state, {
      type: "outline-repair-succeeded", error: "over limit",
    });
    expect(succeeded.state.problem).toEqual(failed);
    expect(succeeded.effects).toEqual([{ type: "bump-resync" }]);
  });

  it("shows a hidden outline failure once the rejected batch is repaired", () => {
    const failed: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "failed", error: "boom",
    };
    const hidden = transitionSync(withProblem(failed), {
      type: "outline-repair-failed", error: "reject", repairError: "still bad",
    });
    const running = transitionSync(hidden.state, {
      type: "repair-started", event: poison(),
    });
    expect(running.state.problem).toMatchObject({
      kind: "rejected-batch", repair: "running",
    });
    const repaired = transitionSync(running.state, {
      type: "repair-succeeded", event: poison(),
    });
    expect(repaired.state.problem).toEqual({
      kind: "outline-rejected", repair: "failed", error: "reject",
      repairError: "still bad",
    });
  });

  it("moves an unrepaired outline problem behind a rejected batch", () => {
    const outline: SyncProblem = {
      kind: "outline-rejected", repair: "failed", error: "reject",
      repairError: "still bad",
    };
    const marked = transitionSync(withProblem(outline), {
      type: "poison-mark-failed", event: poison(), error: "io",
    });
    expect(marked.state.problem).toMatchObject({
      kind: "rejected-batch", repair: "mark-failed",
    });
    const discarded = transitionSync(marked.state, {
      type: "poison-intents-discarded",
    });
    expect(discarded.state.problem).toEqual(outline);
  });

  it("dismisses a repaired outline problem", () => {
    const t = transitionSync(withProblem({
      kind: "outline-rejected", repair: "repaired", error: "reject",
    }), { type: "dismiss" });
    expect(t.state.problem).toBeUndefined();
  });
});

describe("transitionSync replica-stalled lifecycle", () => {
  it("sets a stalled problem with reset idle", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "stalled", error: "replica db locked" }));
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "replica db locked", reset: "idle",
    });
    expect(t.effects).toEqual([]);
  });

  it("never clobbers a delivery problem of a different kind", () => {
    const existing: SyncProblem = {
      kind: "rejected-batch", event: poison(), repair: "running",
    };
    const t = transitionSync(withProblem(existing),
      modeReport({ mode: "stalled", error: "replica db locked" }));
    expect(t.state.problem).toEqual(existing);
    expect(t.effects).toEqual([]);
  });

  it("updates the error text on a re-report without stomping an in-flight reset", () => {
    const running = withProblem({
      kind: "replica-stalled", error: "old error", reset: "running",
    });
    const t = transitionSync(running,
      modeReport({ mode: "stalled", error: "new error" }, "connected", "stalled"));
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "new error", reset: "running",
    });
  });

  it("updates the error text and pending/resetError on a re-report, preserving reset", () => {
    const blocked = withProblem({
      kind: "replica-stalled", error: "old error", reset: "blocked", pending: 3,
    });
    const t = transitionSync(blocked,
      modeReport({ mode: "stalled", error: "new error" }, "connected", "stalled"));
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "new error", reset: "blocked", pending: 3,
    });
  });

  it("clears a replica-stalled problem on unstall when not mid-reset", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    }), modeReport({ mode: "ready" }, "connected", "stalled"));
    expect(t.state.problem).toBeUndefined();
  });

  it("does not clear a replica-stalled problem on unstall while a reset is running", () => {
    const running: SyncProblem = {
      kind: "replica-stalled", error: "x", reset: "running",
    };
    const t = transitionSync(withProblem(running),
      modeReport({ mode: "ready" }, "connected", "stalled"));
    expect(t.state.problem).toEqual(running);
  });

  it("leaves other problem kinds alone on unstall", () => {
    const other: SyncProblem = { kind: "poison-discovery", error: "y" };
    const t = transitionSync(withProblem(other),
      modeReport({ mode: "ready" }, "connected", "stalled"));
    expect(t.state.problem).toEqual(other);
  });

  it("does nothing on unstall when there is no problem", () => {
    const t = transitionSync(createSyncState(),
      modeReport({ mode: "ready" }, "connected", "stalled"));
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

  it("dismisses a blocked replica-stalled problem", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "blocked", pending: 3,
    }), { type: "dismiss" });
    expect(t.state.problem).toBeUndefined();
  });

  it("dismisses a failed replica-stalled problem", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "failed", resetError: "boom",
    }), { type: "dismiss" });
    expect(t.state.problem).toBeUndefined();
  });

  it("does not dismiss an idle replica-stalled problem (only signal of a broken replica)", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "idle",
    }), { type: "dismiss" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "x", reset: "idle",
    });
  });

  it("does not dismiss a running replica-stalled reset", () => {
    const t = transitionSync(withProblem({
      kind: "replica-stalled", error: "x", reset: "running",
    }), { type: "dismiss" });
    expect(t.state.problem).toEqual({
      kind: "replica-stalled", error: "x", reset: "running",
    });
  });
});

describe("transitionSync stall behind a problem that ends", () => {
  const fold = (events: readonly SyncEvent[]): SyncState =>
    events.reduce((s, e) => transitionSync(s, e).state, createSyncState());
  const stall = modeReport({ mode: "stalled", error: "db locked" });
  const stalledBanner: SyncProblem = {
    kind: "replica-stalled", error: "db locked", reset: "idle",
  };
  const event = poison();
  const markFailed: SyncEvent = {
    type: "poison-mark-failed", event, error: "rpc down",
  };

  it("shows the stall when discarded poison intents end the problem", () => {
    const s = fold([stall, markFailed, { type: "poison-intents-discarded" }]);
    expect(s.problem).toEqual(stalledBanner);
  });

  it("shows the stall when discovery clears", () => {
    const s = fold([stall, { type: "poison-discovery-failed", error: "x" },
      { type: "poison-discovery-cleared" }]);
    expect(s.problem).toEqual(stalledBanner);
  });

  it("keeps a repaired notice until dismissed, then shows the stall", () => {
    const repaired = fold([stall, { type: "repair-started", event },
      { type: "repair-succeeded", event }]);
    expect(repaired.problem)
      .toEqual({ kind: "rejected-batch", event, repair: "repaired" });
    const t = transitionSync(repaired, { type: "dismiss" });
    expect(t.state.problem).toEqual(stalledBanner);
  });

  it("shows the stall when a repaired outline notice is dismissed", () => {
    const repaired = fold([stall,
      { type: "outline-repair-succeeded", error: "reject" }]);
    expect(repaired.problem?.kind).toBe("outline-rejected");
    const t = transitionSync(repaired, { type: "dismiss" });
    expect(t.state.problem).toEqual(stalledBanner);
  });

  it("remembers a stall reported while a poison problem shows", () => {
    const s = fold([markFailed, stall, { type: "poison-intents-discarded" }]);
    expect(s.problem).toEqual(stalledBanner);
  });

  it("shows no banner when the stall ended behind the poison problem", () => {
    const s = fold([stall, markFailed,
      modeReport({ mode: "ready" }, "connected", "stalled"),
      { type: "poison-intents-discarded" }]);
    expect(s.problem).toBeUndefined();
  });

  it("never brings the stall back once the replica is gone", () => {
    const s = fold([stall, markFailed,
      modeReport({ mode: "no-replica", error: "worker died" }),
      { type: "poison-intents-discarded" }]);
    expect(s.problem)
      .toEqual({ kind: "replica-unusable", error: "worker died" });
  });

  it("clears the remembered stall when a reset succeeds", () => {
    const s = fold([stall, markFailed, { type: "reset-succeeded" },
      { type: "poison-intents-discarded" }]);
    expect(s.problem).toBeUndefined();
  });

  it("still clears a dismissed failed reset outcome to nothing", () => {
    const s = fold([stall, { type: "reset-failed", error: "no" }]);
    expect(transitionSync(s, { type: "dismiss" }).state.problem)
      .toBeUndefined();
  });
});

describe("transitionSync ops-skipped", () => {
  it("bumps resync without raising a problem", () => {
    const t = transitionSync(createSyncState(), { type: "ops-skipped" });
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
    expect(t.state.problem).toBeUndefined();
  });

  it("bumps resync but leaves an unrelated problem alone", () => {
    const other: SyncProblem = { kind: "poison-discovery", error: "y" };
    const t = transitionSync(withProblem(other), { type: "ops-skipped" });
    expect(t.state.problem).toEqual(other);
    expect(t.effects).toEqual([{ type: "bump-resync" }]);
  });
});

describe("transitionSync exhaustiveness", () => {
  it("throws on an unknown event", () => {
    // An event type the union lacks, which the machine must refuse.
    expect(() => transitionSync(createSyncState(),
      offType<SyncEvent>({ type: "nope" })))
      .toThrow();
  });
});
