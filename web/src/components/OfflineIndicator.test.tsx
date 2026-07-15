import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SyncContext, type Sync } from "../sync/SyncProvider";
import { OfflineIndicator } from "./OfflineIndicator";

function syncWith(overrides: Partial<Sync>): Sync {
  return {
    status: "connected",
    resyncSeq: 0,
    replicaMode: "ready",
    canEdit: true,
    pending: 0,
    retryProblem: () => Promise.resolve(),
    dismissProblem: () => undefined,
    enqueue: () => ({
      id: "test-write", scope: [],
      settled: Promise.resolve({ status: "persisted", pending: 0 }),
    }),
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
    "Server rejected a change (HTTP 400). Repairing local state…");
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
