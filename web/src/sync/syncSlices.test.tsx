// The Sync context used to hand every consumer one value, so an op-queue tick
// or a socket flap re-rendered all of them — in the app, one mounted outline
// per loaded Journal day (pkm-qfee). These tests pin which consumer wakes for
// which change; they are render-count tests, so they assert on counters
// rather than on the DOM.
import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { FakeWebSocket, stubFetch } from "../test-helpers";
import { SyncProvider, useSyncActions, useSyncEditability, useSyncHealth,
         type SyncActions } from "./SyncProvider";

beforeEach(() => {
  localStorage.clear();
  stubFetch([["/api/ops", { ok: true }]]);
  counts.editor = 0;
  counts.health = 0;
  counts.actionsOnly = 0;
});

const lastWs = (): FakeWebSocket =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

const counts = { editor: 0, health: 0, actionsOnly: 0 };
let actions!: SyncActions;

/** Stands in for useOutline: it writes, and it needs to know whether it may. */
function EditorProbe() {
  actions = useSyncActions();
  const { canEdit } = useSyncEditability();
  counts.editor += 1;
  return <div>{canEdit ? "rw" : "ro"}</div>;
}

/** Stands in for OfflineIndicator: the banner that shows the counts. */
function HealthProbe() {
  const { status, pending } = useSyncHealth();
  counts.health += 1;
  return <div>{status}:{pending}</div>;
}

/** Stands in for UndoRedoKeys and DndProvider: writes only. */
function ActionsOnlyProbe() {
  useSyncActions();
  counts.actionsOnly += 1;
  return null;
}

function mount() {
  render(
    <SyncProvider replica={null}>
      <EditorProbe />
      <HealthProbe />
      <ActionsOnlyProbe />
    </SyncProvider>);
  act(() => lastWs().open());
}

test("an op-queue tick re-renders the banner, not the editor", async () => {
  // A POST that never answers, so the op stays pending and the count settles
  // at 1 instead of returning to 0 within the same batch.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  mount();
  const editor = counts.editor;
  const health = counts.health;

  await act(async () => { actions.enqueue([{ op: "delete", uid: "u1" }]); });

  expect(screen.getByText("connected:1")).toBeTruthy();
  expect(counts.health).toBeGreaterThan(health); // it shows `pending`
  expect(counts.editor).toBe(editor);
  expect(counts.actionsOnly).toBe(1);
});

test("a socket flap does not re-render a consumer that only writes", () => {
  mount();
  const health = counts.health;

  act(() => lastWs().drop());
  act(() => lastWs().open());

  expect(counts.health).toBeGreaterThan(health);
  expect(counts.actionsOnly).toBe(1); // the actions value outlives the socket
});

test("the actions value is one object for the provider's lifetime", async () => {
  mount();
  const first = actions;

  act(() => lastWs().drop());
  await act(async () => { actions.enqueue([{ op: "delete", uid: "u2" }]); });

  expect(actions).toBe(first);
});
