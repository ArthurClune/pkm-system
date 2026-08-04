// pkm-7q14: undo/redo wiring — run() records invertible batches, the
// handlers dispatch through the global undo manager.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string; initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

afterEach(() => resetHistory());

const PAGE = "Undo Wire";
const ab = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", { order_idx: 1 }),
];

it("undo reverses a structural edit and redo replays it", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onIndent("b"));
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["b"]);

  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.uid)).toEqual(["a", "b"]);
  expect(sync.sent).toHaveLength(2); // forward move + inverse move

  act(() => outline().handlers.onRedo());
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["b"]);
});

it("undo reverses a whole selection indent in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "alpha", { order_idx: 0 }),
    block("b", "beta", { order_idx: 1 }),
    block("c", "gamma", { order_idx: 2 }),
  ]);
  act(() => outline().handlers.onStartBlockSelection("b", "down"));
  act(() => outline().handlers.onIndentSelection());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["b", "c"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "c", parent_uid: null, order_idx: 2 },
    { op: "move", uid: "b", parent_uid: null, order_idx: 1 },
  ]);
});

it("undo reverses a whole cross-parent selection move in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "A", {
      order_idx: 0,
      children: [block("a0", "A child", { order_idx: 0 })],
    }),
    block("b", "B", {
      order_idx: 1,
      children: [
        block("b0", "B first", { order_idx: 0 }),
        block("b1", "B second", { order_idx: 1 }),
      ],
    }),
    block("c", "C", { order_idx: 2 }),
  ]);
  act(() => outline().handlers.onStartBlockSelection("b0", "down"));
  act(() => outline().handlers.onMoveSelectionUp());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["a0", "b0", "b1"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["a0"]);
  expect(outline().blocks[1].children.map((n) => n.uid))
    .toEqual(["b0", "b1"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "b1", parent_uid: "b", order_idx: 1 },
    { op: "move", uid: "b0", parent_uid: "b", order_idx: 0 },
  ]);
});

it("undo restores a deleted block's text via subtree recreate", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock("b", 0));
  act(() => {
    outline().handlers.onDraftChange("b", "");
    outline().handlers.onBackspaceAtStart("b");
  });
  expect(outline().blocks).toHaveLength(1);
  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.text)).toEqual(["alpha", "beta"]);
});

it("a flushed draft posts update_text with the pre-edit text's hash (pkm-4ubd)", () => {
  // Conflict protection must not depend on the op reaching the replica: an
  // online-only session's ops never pass through replica/queue.ts, so run()
  // stamps here, against the pre-flush tree the batch grew from.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock("a", 5));
  act(() => outline().handlers.onDraftChange("a", "alpha edited"));
  act(() => outline().handlers.onBlurBlock("a"));
  expect(sync.sent[0][0]).toMatchObject({
    op: "update_text", uid: "a", text: "alpha edited",
    base_text_hash: sha256Hex("alpha"),
  });
});

it("run() records UNSTAMPED ops, so a redo hashes the current text (pkm-4ubd)", () => {
  // The other half of the trap, and the half only this test covers: what run()
  // hands to recordHistory. If it recorded the stamped `wireOps`, the entry
  // would carry the hash of "alpha" forever, and stampBaseTextHashes in
  // undoManager.dispatch would PRESERVE that stale hash (it only fills in an
  // undefined one) — so this redo would claim to be replacing "alpha" when the
  // block really reads "two", and the server would fork a spurious [[conflict]]
  // sibling against another tab's edit. Driven through the handlers on purpose:
  // recordHistory's argument is the thing under test, so an entry built by
  // calling recordHistory() directly would prove nothing here.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock("a", 5));
  act(() => outline().handlers.onDraftChange("a", "one"));
  act(() => outline().handlers.onBlurBlock("a")); // flush: records the entry
  act(() => outline().handlers.onUndo());         // back to "alpha"

  // Another tab edits the same block between the undo and the redo. A local
  // edit would not do: recording one clears the redo stack.
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "a", text: "two" },
  ] }));
  expect(outline().blocks[0].text).toBe("two");

  act(() => outline().handlers.onRedo());

  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "a", text: "one",
    base_text_hash: sha256Hex("two"),
  });
});

it("a pending draft flushes and becomes the first undo step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock("a", 5));
  act(() => outline().handlers.onDraftChange("a", "alpha edited"));
  act(() => outline().handlers.onUndo()); // flush-then-undo
  expect(outline().blocks[0].text).toBe("alpha");
});

it("undo restores focus to where it was before the edit", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock("a", 5));
  act(() => outline().handlers.onSplit("a", 5));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "a", cursor: 5 });
});

it("collapse toggles are not undo steps", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE,
    [block("a", "alpha", { order_idx: 0, children: [block("a1", "kid", { order_idx: 0 })] }),
     block("b", "beta", { order_idx: 1 })]);
  // onToggleTodo on plain text returns null from toggleTodo (grammar/todo.ts)
  // and records nothing; onSetHeading always produces an op.
  act(() => outline().handlers.onSetHeading("b", 2)); // recorded entry
  act(() => outline().handlers.onToggleCollapsed("a", true)); // not recorded
  act(() => outline().handlers.onUndo());
  // undo skipped the collapse and reverted the heading; collapse persists
  expect(outline().blocks[1].heading).toBeNull();
  expect(outline().blocks[0].collapsed).toBe(true);
});

it("a fresh edit after undo clears redo", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onSetHeading("a", 2));
  act(() => outline().handlers.onUndo());
  act(() => outline().handlers.onSetHeading("b", 2));
  const sent = sync.sent.length;
  act(() => outline().handlers.onRedo()); // nothing to redo
  expect(sync.sent).toHaveLength(sent);
});
