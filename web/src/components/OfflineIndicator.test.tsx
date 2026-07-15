import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SyncContext, type Sync } from "../sync/SyncProvider";
import { OfflineIndicator } from "./OfflineIndicator";

function syncWith(overrides: Partial<Sync>): Sync {
  return {
    status: "connected",
    resyncSeq: 0,
    replicaMode: "ready",
    canEdit: true,
    pending: 0,
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
