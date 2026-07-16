import { afterEach, expect, it } from "vitest";
import { block, makeSync } from "../test-helpers";
import { acquireOutlineSession } from "./outlineSessions";
import { performRedo, performUndo, recordHistory, registerOutlineHistory,
         resetHistory, setHistoryNavigator } from "./undoManager";
import type { HistoryEntry } from "./history";

const PAGE = "Undo Page";

const entry = (): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: "a", text: "after" }],
  inverse: [{ op: "update_text", uid: "a", text: "before" }],
  focusBefore: { uid: "a", cursor: 6 },
  focusAfter: { uid: "a", cursor: 5 },
});

afterEach(() => resetHistory());

it("undo enqueues the inverse batch scoped to the entry's page", () => {
  const sync = makeSync();
  recordHistory(entry());
  expect(performUndo(sync)).toBe(true);
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before" }]]);
  expect(sync.tickets[0].scope).toEqual(["page", PAGE]);
});

it("undo applies to a mounted session and restores focusBefore", () => {
  const sync = makeSync();
  const handle = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: 0 })]);
  const focused: (unknown)[] = [];
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => undefined,
    applyFocus: (f) => focused.push(f),
  });
  recordHistory(entry());
  performUndo(sync);
  expect(handle.getSnapshot().blocks[0].text).toBe("before");
  expect(focused).toEqual([{ uid: "a", cursor: 6 }]);
  unregister();
  handle.release();
});

it("redo replays the forward batch and restores focusAfter", () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  expect(performRedo(sync)).toBe(true);
  expect(sync.sent[1]).toEqual([{ op: "update_text", uid: "a", text: "after" }]);
});

it("flushes registered drafts before undoing (pending draft becomes the undone entry)", () => {
  const sync = makeSync();
  const calls: string[] = [];
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => { calls.push("flush"); recordHistory(entry()); },
    applyFocus: () => undefined,
  });
  expect(performUndo(sync)).toBe(true); // flush recorded the entry it then undoes
  expect(calls).toEqual(["flush"]);
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before" }]]);
  unregister();
});

it("navigates to the entry's page when no session is mounted", () => {
  const sync = makeSync();
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  recordHistory(entry());
  performUndo(sync);
  expect(paths).toHaveLength(1);
  expect(paths[0]).toContain("Undo");
  clear();
});

it("performUndo returns false on an empty stack without enqueueing", () => {
  const sync = makeSync();
  expect(performUndo(sync)).toBe(false);
  expect(sync.sent).toEqual([]);
});

it("recording clears redo (integration of AC through the manager)", () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  recordHistory(entry());
  expect(performRedo(sync)).toBe(false);
});
