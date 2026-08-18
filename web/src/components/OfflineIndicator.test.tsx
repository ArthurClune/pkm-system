import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SyncContext, type Sync, type SyncProblem } from "../sync/SyncProvider";
import { OfflineIndicator } from "./OfflineIndicator";

function syncWith(overrides: Partial<Sync>): Sync {
  return {
    status: "connected",
    resyncSeq: 0,
    replicaMode: "ready",
    canEdit: true,
    pending: 0,
    unsentInMemory: 0,
    retryProblem: () => Promise.resolve(),
    dismissProblem: () => undefined,
    discardProblem: () => Promise.resolve(),
    resetReplica: () => Promise.resolve(),
    enqueue: () => ({
      id: "test-write", scope: [],
      settled: Promise.resolve({ status: "persisted", pending: 0 }),
      delivered: Promise.resolve({ status: "delivered" }),
    }),
    attachOutlineReplay: () => undefined,
    subscribe: () => () => undefined,
    settled: () => Promise.resolve(),
    ...overrides,
  };
}

function indicator(sync: Sync) {
  return (
    <SyncContext.Provider value={sync}>
      <OfflineIndicator />
    </SyncContext.Provider>
  );
}

function renderWith(overrides: Partial<Sync>) {
  return render(indicator(syncWith(overrides)));
}

it("renders nothing when connected with an empty queue", () => {
  const { container } = renderWith({ status: "connected", pending: 0 });
  expect(container).toBeEmptyDOMElement();
});

it("stays hidden for routine writes while connected", () => {
  const { container } = renderWith({ status: "connected", pending: 1 });
  expect(container).toBeEmptyDOMElement();
});

it("shows a syncing note while the queue drains after reconnect", () => {
  const { rerender } = renderWith({ status: "reconnecting", pending: 3 });

  rerender(indicator(syncWith({ status: "connected", pending: 3 })));

  expect(screen.getByRole("status"))
    .toHaveTextContent("Syncing — 3 changes pending…");
});

it("uses the singular for one pending change after reconnect", () => {
  const { rerender } = renderWith({ status: "reconnecting", pending: 1 });

  rerender(indicator(syncWith({ status: "connected", pending: 1 })));

  expect(screen.getByRole("status"))
    .toHaveTextContent("Syncing — 1 change pending…");
});

it("offline with pending edits reports the count", () => {
  renderWith({ status: "reconnecting", canEdit: true, pending: 2 });
  expect(screen.getByRole("status"))
    .toHaveTextContent("Offline — 2 changes pending");
});

it("offline with a clean queue promises sync on reconnect", () => {
  renderWith({ status: "reconnecting", canEdit: true, pending: 0 });
  expect(screen.getByRole("status"))
    .toHaveTextContent("Offline — changes will sync on reconnect");
});

it("offline without editing shows the read-only reason", () => {
  renderWith({
    status: "reconnecting",
    canEdit: false,
    readOnlyReason: "offline — this graph is not yet available locally",
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Offline — editing paused: offline — this graph is not yet available locally");
});

const rejected = {
  kind: "rejected-batch" as const,
  event: {
    rowId: 7, batchId: "batch-rejected",
    ops: [{ op: "delete" as const, uid: "uid_bad" }],
    status: 400, message: "request failed: 400 /api/ops",
  },
};

it("shows connected rejected-delivery details while repair is running", () => {
  renderWith({ problem: { ...rejected, repair: "running" } });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Server rejected a change (HTTP 400). Repairing local state…" +
    " Keep the app open until this finishes.");
  expect(screen.getByText("Details")).toBeInTheDocument();
  expect(screen.getByText(/batch-rejected/)).toBeInTheDocument();
});

it("failed repair offers Retry but cannot be dismissed", () => {
  const retryProblem = vi.fn(async () => undefined);
  const dismissProblem = vi.fn();
  renderWith({
    problem: { ...rejected, repair: "failed", error: "snapshot unavailable" },
    ...({ retryProblem, dismissProblem } as unknown as Partial<Sync>),
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Local repair failed: snapshot unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retryProblem).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(dismissProblem).not.toHaveBeenCalled();
});

it("failed durable poison marking is visible and offers Retry", () => {
  const retryProblem = vi.fn(async () => undefined);
  renderWith({
    problem: {
      ...rejected, repair: "mark-failed", error: "local worker unavailable",
    } as unknown as Sync["problem"],
    retryProblem,
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Saving rejected-change recovery failed: local worker unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retryProblem).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});

it("failed durable poison marking offers a discard escape (pkm-tu5k)", () => {
  // Retry can never succeed while the replica stays unopenable, and the
  // intent it retries is what wedges every future session. Discard is the
  // way out; its label owns the consequence.
  const discardProblem = vi.fn(async () => undefined);
  const { rerender } = renderWith({
    problem: {
      ...rejected, repair: "mark-failed", error: "local worker unavailable",
    } as unknown as Sync["problem"],
    discardProblem,
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard rejected change" }));
  expect(discardProblem).toHaveBeenCalledTimes(1);

  // The escape belongs to the unmarkable-intent state alone: a failed local
  // repair has a working Retry and must not offer to give up instead.
  rerender(indicator(syncWith({
    problem: { ...rejected, repair: "failed", error: "snapshot unavailable" },
  })));
  expect(screen.queryByRole("button", { name: "Discard rejected change" }))
    .toBeNull();
});

it("an online-only session says so and offers a Reload, not a Retry", async () => {
  // pkm-bjae: this state was silent, so the user lost offline editing with no
  // notice. Reload rather than Retry because the failed open is latched for
  // the session and the queue has already delivered online.
  const reload = vi.fn();
  const original = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: { ...original, reload },
  });
  try {
    renderWith({
      problem: {
        kind: "replica-unavailable", error: "Access Handles cannot be created",
      } as unknown as Sync["problem"],
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Working online only — offline editing is unavailable for now.");
    // Connected, so the reassurance is true and is given: opQueue retains every
    // replica failure that raises this problem, and the socket is delivering
    // (pkm-s1m8 — this used to assert the sentence was absent).
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your changes are still being saved to the server.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Nothing pending here, so Reload goes straight through.
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledTimes(1); });
  } finally {
    Object.defineProperty(globalThis, "location", {
      configurable: true, value: original,
    });
  }
});

it("warns instead of reassuring when an online-only session goes offline", () => {
  // pkm-s1m8: the reassurance is true only while the socket is up. Offline,
  // retained ops live in the in-memory fallback lane, and useUnloadGuard does
  // not hold on iPad (pkm-0htf), so a refresh or a closed tab can still take
  // them — the one case where the user can act on the warning.
  renderWith({
    status: "reconnecting",
    canEdit: false,
    problem: {
      kind: "replica-unavailable", error: "Access Handles cannot be created",
    } as unknown as Sync["problem"],
    pending: 2,
  });
  // The problem banner renders before the connectivity banner.
  const banner = screen.getAllByRole("status")[0];
  expect(banner).toHaveTextContent(
    "Working online only — offline editing is unavailable for now.");
  expect(banner).toHaveTextContent(
    "You are offline: 2 unsent changes exist only in memory here. "
    + "Reloading or closing this tab discards them.");
  expect(banner).not.toHaveTextContent("still being saved");
});

it("uses the singular for one unsent change in an offline online-only session", () => {
  renderWith({
    status: "reconnecting",
    canEdit: false,
    problem: {
      kind: "replica-unavailable", error: "Access Handles cannot be created",
    } as unknown as Sync["problem"],
    pending: 1,
  });
  expect(screen.getAllByRole("status")[0]).toHaveTextContent(
    "1 unsent change exists only in memory here. "
    + "Reloading or closing this tab discards it.");
});

it("says nothing about safety when an offline online-only session is clean", () => {
  // Nothing to lose and nothing to promise: a reassurance would be about
  // future edits, which this session cannot make (the editor is frozen).
  renderWith({
    status: "reconnecting",
    canEdit: false,
    problem: {
      kind: "replica-unavailable", error: "Access Handles cannot be created",
    } as unknown as Sync["problem"],
    pending: 0,
  });
  const banner = screen.getAllByRole("status")[0];
  expect(banner).toHaveTextContent(
    "Working online only — offline editing is unavailable for now.");
  expect(banner).not.toHaveTextContent("still being saved");
  expect(banner).not.toHaveTextContent("unsent change");
  expect(banner).not.toHaveTextContent("discards");
});

it("Reload confirms before discarding undelivered work", async () => {
  // pkm-bjae review: location.reload() destroys the in-memory fallback lane,
  // which in an online-only session is the ONLY place undelivered ops live.
  // The banner's own wording invites the click, so it must ask first —
  // mirroring resetReplica's "N unsent changes" refusal. This confirm outlives
  // useUnloadGuard because beforeunload is unreliable on iPad (pkm-0htf).
  const reload = vi.fn();
  const original = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: { ...original, reload },
  });
  try {
    renderWith({
      problem: {
        kind: "replica-unavailable", error: "Access Handles cannot be created",
      } as unknown as Sync["problem"],
      pending: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    // A confirmation naming the cost, and nothing destroyed until answered.
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      /2 unsent changes have not reached the server yet/);
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard and reload" }));
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledTimes(1); });
  } finally {
    Object.defineProperty(globalThis, "location", {
      configurable: true, value: original,
    });
  }
});

it("failed startup poison discovery is visible and offers Retry", () => {
  const retryProblem = vi.fn(async () => undefined);
  renderWith({
    problem: {
      kind: "poison-discovery", error: "worker read failed",
    } as unknown as Sync["problem"],
    retryProblem,
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Checking rejected changes failed: worker read failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retryProblem).toHaveBeenCalledTimes(1);
});

it("failed legacy authoritative repair is visible and offers Retry", () => {
  const retryProblem = vi.fn(async () => undefined);
  renderWith({
    problem: {
      kind: "legacy-rejected", repair: "failed",
      error: "request failed: 400 /api/ops", repairError: "page read failed",
    } as unknown as Sync["problem"],
    retryProblem,
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Authoritative repair failed: page read failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retryProblem).toHaveBeenCalledTimes(1);
});

it("repaired rejection keeps details until Dismiss", () => {
  const retryProblem = vi.fn(async () => undefined);
  const dismissProblem = vi.fn();
  renderWith({
    problem: { ...rejected, repair: "repaired" },
    ...({ retryProblem, dismissProblem } as unknown as Partial<Sync>),
  });
  expect(screen.getByRole("status")).toHaveTextContent("Local state repaired");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(dismissProblem).toHaveBeenCalledTimes(1);
  expect(retryProblem).not.toHaveBeenCalled();
});

it("shows a stalled replica banner with a reset button", () => {
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "idle",
    } as unknown as Sync["problem"],
  });
  expect(screen.getByRole("alert"))
    .toHaveTextContent("Local sync is stuck: replica db locked");
  expect(screen.getByRole("button", { name: "Reset local data" })).toBeEnabled();
});

it("clicking Reset local data calls resetReplica(false)", () => {
  const resetReplica = vi.fn(async () => undefined);
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "idle",
    } as unknown as Sync["problem"],
    resetReplica,
  });
  fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
  expect(resetReplica).toHaveBeenCalledTimes(1);
  expect(resetReplica).toHaveBeenCalledWith(false);
});

it("disables the reset button while a reset is running", () => {
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "running",
    } as unknown as Sync["problem"],
  });
  expect(screen.getByRole("button", { name: "Reset local data" })).toBeDisabled();
});

it("shows the reset failure message alongside the retry button", () => {
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "failed",
      resetError: "disk full",
    } as unknown as Sync["problem"],
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Local sync is stuck: replica db locked Reset failed: disk full.");
  expect(screen.getByRole("button", { name: "Reset local data" })).toBeEnabled();
});

it("shows the blocked-reset banner with discard and keep-waiting actions", () => {
  const resetReplica = vi.fn(async () => undefined);
  const dismissProblem = vi.fn();
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "blocked", pending: 3,
    } as unknown as Sync["problem"],
    resetReplica,
    dismissProblem,
  });
  expect(screen.getByRole("alert"))
    .toHaveTextContent("3 unsent changes could not be delivered.");

  fireEvent.click(screen.getByRole("button", { name: "Discard and reset" }));
  expect(resetReplica).toHaveBeenCalledTimes(1);
  expect(resetReplica).toHaveBeenCalledWith(true);

  fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
  expect(dismissProblem).toHaveBeenCalledTimes(1);
});

it("uses the singular for one unsent blocked change", () => {
  renderWith({
    problem: {
      kind: "replica-stalled", error: "replica db locked", reset: "blocked", pending: 1,
    } as unknown as Sync["problem"],
  });
  expect(screen.getByRole("alert"))
    .toHaveTextContent("1 unsent change could not be delivered.");
});

it("reports a running legacy repair as a status, with no action offered", () => {
  renderWith({
    problem: {
      kind: "legacy-rejected", repair: "running",
      error: "request failed: 400 /api/ops",
    },
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Server rejected a change. Repairing active outlines…");
  expect(screen.queryByRole("button")).toBeNull();
});

it("a repaired legacy rejection keeps its note until Dismiss", () => {
  const dismissProblem = vi.fn();
  renderWith({
    problem: {
      kind: "legacy-rejected", repair: "repaired",
      error: "request failed: 400 /api/ops",
    },
    dismissProblem,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Server rejected a change. Active outlines repaired.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(dismissProblem).toHaveBeenCalledTimes(1);
});

// The banner matrix, pinned in one place: every problem kind in every state it
// can be rendered in, with the role that decides whether a screen reader
// interrupts the user, and the actions that state may offer. role="alert" is
// for states the user must act on; everything else is role="status".
const matrix: Array<[string, SyncProblem, "alert" | "status", string[], string]> = [
  ["poison-discovery", { kind: "poison-discovery", error: "worker read failed" },
   "alert", ["Retry"], "Checking rejected changes failed: worker read failed"],
  ["replica-unavailable",
   { kind: "replica-unavailable", error: "no access handles" },
   "status", ["Reload"],
   "Working online only — offline editing is unavailable for now."],
  ["legacy-rejected/running",
   { kind: "legacy-rejected", repair: "running", error: "400" },
   "status", [], "Repairing active outlines…"],
  ["legacy-rejected/failed",
   { kind: "legacy-rejected", repair: "failed", error: "400",
     repairError: "page read failed" },
   "alert", ["Retry"], "Authoritative repair failed: page read failed"],
  ["legacy-rejected/repaired",
   { kind: "legacy-rejected", repair: "repaired", error: "400" },
   "status", ["Dismiss"], "Active outlines repaired."],
  ["rejected-batch/running",
   { kind: "rejected-batch", event: rejected.event, repair: "running" },
   "status", [],
   "Repairing local state… Keep the app open until this finishes."],
  ["rejected-batch/mark-failed",
   { kind: "rejected-batch", event: rejected.event, repair: "mark-failed",
     error: "no worker" },
   "alert", ["Retry", "Discard rejected change"],
   "Saving rejected-change recovery failed: no worker"],
  ["rejected-batch/failed",
   { kind: "rejected-batch", event: rejected.event, repair: "failed",
     error: "snapshot 503" },
   "alert", ["Retry"], "Local repair failed: snapshot 503"],
  ["rejected-batch/repaired",
   { kind: "rejected-batch", event: rejected.event, repair: "repaired" },
   "status", ["Dismiss"], "Local state repaired."],
  ["replica-stalled/idle",
   { kind: "replica-stalled", error: "db locked", reset: "idle" },
   "alert", ["Reset local data"], "Local sync is stuck: db locked"],
  ["replica-stalled/running",
   { kind: "replica-stalled", error: "db locked", reset: "running" },
   "alert", ["Reset local data"], "Local sync is stuck: db locked"],
  ["replica-stalled/failed",
   { kind: "replica-stalled", error: "db locked", reset: "failed",
     resetError: "disk full" },
   "alert", ["Reset local data"], "Reset failed: disk full."],
  ["replica-stalled/blocked",
   { kind: "replica-stalled", error: "db locked", reset: "blocked", pending: 3 },
   "alert", ["Discard and reset", "Keep waiting"],
   "3 unsent changes could not be delivered."],
];

it.each(matrix)("%s renders one %s banner with its own actions",
(_name, problem, role, buttons, copy) => {
  // status "connected" with a clean queue keeps the connectivity banner off
  // the screen, so the only banner rendered is the one under test.
  renderWith({ problem, status: "connected", pending: 0 });
  const banner = screen.getByRole(role);
  expect(banner).toHaveTextContent(copy);
  expect(within(banner).queryAllByRole("button")
    .map((button) => button.textContent?.trim())).toEqual(buttons);
});

it("a problem banner renders above the connectivity banner", () => {
  // Order is the contract the offline online-only assertions above rely on
  // when they read getAllByRole("status")[0].
  renderWith({
    status: "reconnecting", canEdit: true, pending: 2,
    problem: { kind: "replica-unavailable", error: "no access handles" },
  });
  const [problemBanner, connectivity] = screen.getAllByRole("status");
  expect(problemBanner).toHaveTextContent("Working online only");
  expect(connectivity).toHaveTextContent("Offline — 2 changes pending");
});
