// Undo/redo wiring — run() records invertible batches, the
// handlers dispatch through the global undo manager.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, normTitle, ord, type SyncFake, title, uid } from "../test-helpers";
import { recordHistory, resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string; initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(title(pageTitle), initial);
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

// Never rendered: a type-only probe that useOutline's title is the stored
// (canonical) form, not one only normalized.
export function NormalizedTitleProbe() {
  // @ts-expect-error a NormalizedTitle is not a CanonicalTitle
  useOutline(normTitle("Page"), []);
  return null;
}

afterEach(() => resetHistory());

const PAGE = "Undo Wire";
const ab = () => [
  block("a", "alpha", { order_idx: ord(0) }),
  block("b", "beta", { order_idx: ord(1) }),
];

it("undo reverses a structural edit and redo replays it", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onIndent(uid("b")));
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
    block("a", "alpha", { order_idx: ord(0) }),
    block("b", "beta", { order_idx: ord(1) }),
    block("c", "gamma", { order_idx: ord(2) }),
  ]);
  act(() => outline().handlers.onStartBlockSelection(uid("b"), "down"));
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
      order_idx: ord(0),
      children: [block("a0", "A child", { order_idx: ord(0) })],
    }),
    block("b", "B", {
      order_idx: ord(1),
      children: [
        block("b0", "B first", { order_idx: ord(0) }),
        block("b1", "B second", { order_idx: ord(1) }),
      ],
    }),
    block("c", "C", { order_idx: ord(2) }),
  ]);
  act(() => outline().handlers.onStartBlockSelection(uid("b0"), "down"));
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

it("undoes two moves up in a row and redoes them, though each replay shifted keys", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "A", { order_idx: ord(0) }),
    block("b", "B", { order_idx: ord(1) }),
    block("c", "C", { order_idx: ord(2) }),
  ]);
  const order = () => outline().blocks.map((n) => n.uid);
  act(() => outline().handlers.onMoveSubtreeUp(uid("b")));
  act(() => outline().handlers.onMoveSubtreeUp(uid("c")));
  expect(order()).toEqual(["b", "c", "a"]);

  act(() => outline().handlers.onUndo());
  expect(order()).toEqual(["b", "a", "c"]);
  act(() => outline().handlers.onUndo());
  expect(order()).toEqual(["a", "b", "c"]);
  act(() => outline().handlers.onRedo());
  expect(order()).toEqual(["b", "a", "c"]);
  act(() => outline().handlers.onRedo());
  expect(order()).toEqual(["b", "c", "a"]);
});

it("undo restores a deleted block's text via subtree recreate", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uid("b"), 0));
  act(() => {
    outline().handlers.onDraftChange(uid("b"), "");
    outline().handlers.onBackspaceAtStart(uid("b"));
  });
  expect(outline().blocks).toHaveLength(1);
  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.text)).toEqual(["alpha", "beta"]);
});

it("a flushed draft posts update_text with the pre-edit text's hash", () => {
  // Conflict protection must not depend on the op reaching the replica: an
  // online-only session's ops never pass through replica/queue.ts, so run()
  // stamps here, against the pre-flush tree the batch grew from.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uid("a"), 5));
  act(() => outline().handlers.onDraftChange(uid("a"), "alpha edited"));
  act(() => outline().handlers.onBlurBlock(uid("a")));
  expect(sync.sent[0][0]).toMatchObject({
    op: "update_text", uid: "a", text: "alpha edited",
    base_text_hash: sha256Hex("alpha"),
  });
});

it("run() records UNSTAMPED ops, so a redo hashes the current text", () => {
  // The other half of the trap, and the half only this test covers: what run()
  // hands to recordHistory. If it recorded the stamped `wireOps`, the entry
  // would carry the hash of "alpha" forever, and stampBaseTextHashes in
  // undoManager.dispatch would PRESERVE that stale hash (it only fills in an
  // undefined one) — so this redo would claim to be replacing "alpha" when the
  // block really reads "two", and the server would land a spurious daily-note
  // [[conflict]] header against another tab's edit. Driven through the handlers on purpose:
  // recordHistory's argument is the thing under test, so an entry built by
  // calling recordHistory() directly would prove nothing here.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uid("a"), 5));
  act(() => outline().handlers.onDraftChange(uid("a"), "one"));
  act(() => outline().handlers.onBlurBlock(uid("a"))); // flush: records the entry
  act(() => outline().handlers.onUndo());         // back to "alpha"

  // Another tab edits the same block between the undo and the redo. A local
  // edit would not do: recording one clears the redo stack.
  act(() => sync.emit({ client_id: "other" as ClientId, ts: 1, ops: [
    { op: "update_text", uid: uid("a"), text: "two" },
  ] }));
  expect(outline().blocks[0].text).toBe("two");

  act(() => outline().handlers.onRedo());

  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "a", text: "one",
    base_text_hash: sha256Hex("two"),
  });
});

it("undo stamps page_title on the enqueued op, though the recorded entry carries none", () => {
  // Mirrors the base_text_hash pattern above: history stores
  // unstamped ops, and dispatch (undoManager.ts) stamps page_title fresh at
  // replay time against the mounted session's own tree.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  const inverse: BlockOp[] = [{ op: "update_text", uid: uid("a"), text: "alpha" }];
  expect(inverse[0]).not.toHaveProperty("page_title");
  recordHistory({
    pageTitle: PAGE,
    ops: [{ op: "update_text", uid: uid("a"), text: "one" }],
    inverse,
    anchors: { ops: [null], inverse: [null] },
    freshAssets: [], focusBefore: null,
    focusAfter: null,
  });
  act(() => outline().handlers.onUndo());
  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "a", text: "alpha", page_title: PAGE,
  });
});

it("a pending draft flushes and becomes the first undo step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uid("a"), 5));
  act(() => outline().handlers.onDraftChange(uid("a"), "alpha edited"));
  act(() => outline().handlers.onUndo()); // flush-then-undo
  expect(outline().blocks[0].text).toBe("alpha");
});

it("undo restores focus to where it was before the edit", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uid("a"), 5));
  act(() => outline().handlers.onSplit(uid("a"), 5));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "a", cursor: 5 });
});

it("undo restoring focus to a block hidden by a later collapse focuses the collapsed ancestor", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("p", "parent", { order_idx: ord(0),
                           children: [block("c", "child", { order_idx: ord(0) })] }),
  ]);
  act(() => outline().handlers.onFocusBlock(uid("c"), 5));
  act(() => outline().handlers.onSplit(uid("c"), 5));
  act(() => outline().handlers.onToggleCollapsed(uid("p"), true));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "p", cursor: 6 });
});

it("undo clamps the restored caret to the restored text", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [block("a", "ab", { order_idx: ord(0) })]);
  act(() => outline().handlers.onFocusBlock(uid("a"), 2));
  act(() => outline().handlers.onDraftChange(uid("a"), "x y"));
  act(() => outline().handlers.onFocusBlock(uid("a"), 3));
  act(() => outline().handlers.onSplit(uid("a"), 3));
  act(() => outline().handlers.onUndo());
  expect(outline().blocks[0].text).toBe("ab");
  expect(outline().focus).toEqual({ uid: "a", cursor: 2 });
});

/** A collapsed Roam table: its rows render whatever its collapsed flag says. */
const collapsedTable = () => [
  block("t", "{{[[table]]}}", { order_idx: ord(0), collapsed: true, children: [
    block("r1", "a", { order_idx: ord(0), children: [
      block("r1b", "b", { order_idx: ord(0) }),
    ] }),
  ] }),
  block("x", "other", { order_idx: ord(1) }),
];

it("typing in a cell of a collapsed table keeps focus there through a flush and a remote batch", () => {
  vi.useFakeTimers();
  try {
    const sync = makeSync();
    const outline = setup(sync, PAGE, collapsedTable());
    act(() => outline().handlers.onFocusBlock(uid("r1b"), 1));
    act(() => outline().handlers.onDraftChange(uid("r1b"), "bc"));
    act(() => { vi.advanceTimersByTime(5000); }); // the debounced flush
    expect(sync.sent[0]).toMatchObject([{ op: "update_text", uid: "r1b", text: "bc" }]);
    expect(outline().focus).toEqual({ uid: "r1b", cursor: 1 });
    act(() => sync.emit({ client_id: "other" as ClientId, ts: 1, ops: [
      { op: "update_text", uid: uid("x"), text: "remote" },
    ] }));
    expect(outline().focus).toEqual({ uid: "r1b", cursor: 1 });
  } finally {
    vi.useRealTimers();
  }
});

it("a remote collapse of the typed block's parent moves focus to the parent, and the draft still lands on the block", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("p", "parent", { order_idx: ord(0),
                           children: [block("c", "child", { order_idx: ord(0) })] }),
  ]);
  act(() => outline().handlers.onFocusBlock(uid("c"), 5));
  act(() => outline().handlers.onDraftChange(uid("c"), "child typed"));
  act(() => sync.emit({ client_id: "other" as ClientId, ts: 1, ops: [
    { op: "set_collapsed", uid: uid("p"), collapsed: true },
  ] }));
  expect(outline().focus).toEqual({ uid: "p", cursor: 6 });

  // Typing in the parent's textarea flushes the hidden block's draft first.
  act(() => outline().handlers.onDraftStart(uid("p"), "parent"));
  expect(sync.sent[0]).toMatchObject([{ op: "update_text", uid: "c", text: "child typed" }]);
  expect(outline().blocks[0].children[0].text).toBe("child typed");
  expect(outline().blocks[0].text).toBe("parent");
});

it("undo inside a cell of a collapsed table keeps focus in the cell", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, collapsedTable());
  act(() => outline().handlers.onFocusBlock(uid("r1b"), 1));
  act(() => outline().handlers.onSetHeading(uid("r1b"), 2));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "r1b", cursor: 1 });
});

it("collapse toggles are not undo steps", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE,
    [block("a", "alpha", { order_idx: ord(0), children: [block("a1", "kid", { order_idx: ord(0) })] }),
     block("b", "beta", { order_idx: ord(1) })]);
  // onToggleTodo on plain text returns null from toggleTodo (grammar/todo.ts)
  // and records nothing; onSetHeading to a new level produces an op.
  act(() => outline().handlers.onSetHeading(uid("b"), 2)); // recorded entry
  act(() => outline().handlers.onToggleCollapsed(uid("a"), true)); // not recorded
  act(() => outline().handlers.onUndo());
  // undo skipped the collapse and reverted the heading; collapse persists
  expect(outline().blocks[1].heading).toBeNull();
  expect(outline().blocks[0].collapsed).toBe(true);
});

it("a field setter that changes nothing sends no op and records no undo step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onSetHeading(uid("a"), 2)); // recorded entry
  const sent = sync.sent.length;
  act(() => outline().handlers.onSetHeading(uid("a"), 2));
  act(() => outline().handlers.onSetViewType(uid("b"), "document"));
  act(() => outline().handlers.onToggleCollapsed(uid("b"), false));
  expect(sync.sent).toHaveLength(sent);
  act(() => outline().handlers.onUndo()); // reaches the first heading change
  expect(outline().blocks[0].heading).toBeNull();
});

it("a fresh edit after undo clears redo", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onSetHeading(uid("a"), 2));
  act(() => outline().handlers.onUndo());
  act(() => outline().handlers.onSetHeading(uid("b"), 2));
  const sent = sync.sent.length;
  act(() => outline().handlers.onRedo()); // nothing to redo
  expect(sync.sent).toHaveLength(sent);
});

it("a batch carrying a draft for a remotely deleted block stays undoable", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "alpha", { order_idx: ord(0) }),
    block("b", "beta", { order_idx: ord(1) }),
    block("c", "gamma", { order_idx: ord(2) }),
  ]);
  act(() => outline().handlers.onDraftChange(uid("a"), "see [[Held", true));
  act(() => sync.emit({ client_id: "other" as ClientId, ts: 1, ops: [
    { op: "delete", uid: uid("a") },
  ] }));
  // The indent's batch flushes the held draft first: its text op targets a
  // block this tree no longer has, and the indent must still be undoable.
  act(() => outline().handlers.onIndent(uid("c")));
  expect(sync.sent[0].map((op) => op.op)).toEqual(["update_text", "move"]);
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["c"]);

  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.uid)).toEqual(["b", "c"]);
  // The undo reverses only the indent: nothing re-sends the orphaned text.
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "c", parent_uid: null, order_idx: 2 },
  ]);
});
