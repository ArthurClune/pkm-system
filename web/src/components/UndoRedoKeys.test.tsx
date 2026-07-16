// pkm-7q14: window-level undo keys — fire only when no editable element owns
// the keystroke, so the search bar keeps native input undo.
import { fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { SyncContext } from "../sync/SyncProvider";
import { makeSync } from "../test-helpers";
import { recordHistory, resetHistory } from "../outline/undoManager";
import { UndoRedoKeys } from "./UndoRedoKeys";

afterEach(() => resetHistory());

const entry = () => ({
  pageTitle: "Keys Page",
  ops: [{ op: "update_text" as const, uid: "a", text: "after" }],
  inverse: [{ op: "update_text" as const, uid: "a", text: "before" }],
  focusBefore: null,
  focusAfter: null,
});

function setup(sync = makeSync()) {
  render(
    <MemoryRouter>
      <SyncContext.Provider value={sync}>
        <UndoRedoKeys />
        <input aria-label="other-input" />
      </SyncContext.Provider>
    </MemoryRouter>);
  return sync;
}

it("Cmd-Z on the window dispatches undo", () => {
  const sync = setup();
  recordHistory(entry());
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before" }]]);
});

it("Shift-Cmd-Z dispatches redo", () => {
  const sync = setup();
  recordHistory(entry());
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([{ op: "update_text", uid: "a", text: "after" }]);
});

it("ignores keystrokes from editable elements (native undo wins there)", () => {
  const sync = setup();
  recordHistory(entry());
  const input = document.querySelector("input")!;
  input.focus();
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  expect(sync.sent).toEqual([]);
});

it("does nothing when editing is read-only", () => {
  const sync = setup(makeSync("connecting"));
  recordHistory(entry());
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(sync.sent).toEqual([]);
});
