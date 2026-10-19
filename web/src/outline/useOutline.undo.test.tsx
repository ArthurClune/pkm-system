// Undo/redo wiring — run() records invertible batches, the
// handlers dispatch through the global undo manager.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import {
  block,
  makeSync,
  normalizedTitleOf,
  orderIdxOf,
  type SyncFake,
  canonicalTitleOf,
  typeProbe,
  uidOf,
  clientIdOf, rawTitleOf,
} from "../test-helpers";
import { recordHistory, resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string; initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(pageTitle), initial);
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

// useOutline's title is the stored (canonical) form, not one only normalized.
// The hook is not called: a hook call has no place in a probe.
typeProbe(() => {
  // @ts-expect-error a NormalizedTitle is not a CanonicalTitle
  const title: Parameters<typeof useOutline>[0] = normalizedTitleOf("Page");
  void title;
});

afterEach(() => resetHistory());

const PAGE = rawTitleOf("Undo Wire");
const ab = () => [
  block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "beta", { order_idx: orderIdxOf(1) }),
];

it("undo reverses a structural edit and redo replays it", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onIndent(uidOf("tuid-b")));
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["tuid-b"]);

  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b"]);
  expect(sync.sent).toHaveLength(2); // forward move + inverse move

  act(() => outline().handlers.onRedo());
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["tuid-b"]);
});

it("undo reverses a whole selection indent in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "beta", { order_idx: orderIdxOf(1) }),
    block("tuid-c", "gamma", { order_idx: orderIdxOf(2) }),
  ]);
  act(() => outline().handlers.onStartBlockSelection(uidOf("tuid-b"), "down"));
  act(() => outline().handlers.onIndentSelection());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["tuid-b", "tuid-c"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 2 },
    { op: "move", uid: "tuid-b", parent_uid: null, order_idx: 1 },
  ]);
});

it("undo reverses a whole cross-parent selection move in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-a", "A", {
      order_idx: orderIdxOf(0),
      children: [block("tuid-a0", "A child", { order_idx: orderIdxOf(0) })],
    }),
    block("tuid-b", "B", {
      order_idx: orderIdxOf(1),
      children: [
        block("tuid-b0", "B first", { order_idx: orderIdxOf(0) }),
        block("tuid-b1", "B second", { order_idx: orderIdxOf(1) }),
      ],
    }),
    block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
  ]);
  act(() => outline().handlers.onStartBlockSelection(uidOf("tuid-b0"), "down"));
  act(() => outline().handlers.onMoveSelectionUp());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["tuid-a0", "tuid-b0", "tuid-b1"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["tuid-a0"]);
  expect(outline().blocks[1].children.map((n) => n.uid))
    .toEqual(["tuid-b0", "tuid-b1"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "tuid-b1", parent_uid: "tuid-b", order_idx: 1 },
    { op: "move", uid: "tuid-b0", parent_uid: "tuid-b", order_idx: 0 },
  ]);
});

it("undoes two moves up in a row and redoes them, though each replay shifted keys", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "B", { order_idx: orderIdxOf(1) }),
    block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
  ]);
  const order = () => outline().blocks.map((n) => n.uid);
  act(() => outline().handlers.onMoveSubtreeUp(uidOf("tuid-b")));
  act(() => outline().handlers.onMoveSubtreeUp(uidOf("tuid-c")));
  expect(order()).toEqual(["tuid-b", "tuid-c", "tuid-a"]);

  act(() => outline().handlers.onUndo());
  expect(order()).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
  act(() => outline().handlers.onUndo());
  expect(order()).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  act(() => outline().handlers.onRedo());
  expect(order()).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
  act(() => outline().handlers.onRedo());
  expect(order()).toEqual(["tuid-b", "tuid-c", "tuid-a"]);
});

it("undo restores a deleted block's text via subtree recreate", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-b"), 0));
  act(() => {
    outline().handlers.onDraftChange(uidOf("tuid-b"), "");
    outline().handlers.onBackspaceAtStart(uidOf("tuid-b"));
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
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 5));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "alpha edited"));
  act(() => outline().handlers.onBlurBlock(uidOf("tuid-a")));
  expect(sync.sent[0][0]).toMatchObject({
    op: "update_text", uid: "tuid-a", text: "alpha edited",
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
  // [[conflict]] header against another tab's edit. Driven through the handlers
  // on purpose: recordHistory's argument is the thing under test, so an entry
  // built by calling recordHistory() directly would prove nothing here.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 5));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "one"));
  act(() => outline().handlers.onBlurBlock(uidOf("tuid-a"))); // flush: records the entry
  act(() => outline().handlers.onUndo());         // back to "alpha"

  // Another tab edits the same block between the undo and the redo. A local
  // edit would not do: recording one clears the redo stack.
  act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
    { op: "update_text", uid: uidOf("tuid-a"), text: "two" },
  ] }));
  expect(outline().blocks[0].text).toBe("two");

  act(() => outline().handlers.onRedo());

  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "tuid-a", text: "one",
    base_text_hash: sha256Hex("two"),
  });
});

it("undo stamps page_title on the enqueued op, though the recorded entry carries none", () => {
  // Mirrors the base_text_hash pattern above: history stores
  // unstamped ops, and dispatch (undoManager.ts) stamps page_title fresh at
  // replay time against the mounted session's own tree.
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  const inverse: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-a"), text: "alpha" }];
  expect(inverse[0]).not.toHaveProperty("page_title");
  recordHistory({
    pageTitle: PAGE,
    ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: "one" }],
    inverse,
    anchors: { ops: [null], inverse: [null] },
    freshAssets: [], focusBefore: null,
    focusAfter: null,
  });
  act(() => outline().handlers.onUndo());
  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "tuid-a", text: "alpha", page_title: PAGE,
  });
});

it("a pending draft flushes and becomes the first undo step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 5));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "alpha edited"));
  act(() => outline().handlers.onUndo()); // flush-then-undo
  expect(outline().blocks[0].text).toBe("alpha");
});

it("undo restores focus to where it was before the edit", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 5));
  act(() => outline().handlers.onSplit(uidOf("tuid-a"), 5));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "tuid-a", cursor: 5 });
});

it("undo restoring focus to a block hidden by a later collapse focuses the collapsed ancestor", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-p", "parent", { order_idx: orderIdxOf(0),
                           children: [block("tuid-c", "child", { order_idx: orderIdxOf(0) })] }),
  ]);
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-c"), 5));
  act(() => outline().handlers.onSplit(uidOf("tuid-c"), 5));
  act(() => outline().handlers.onToggleCollapsed(uidOf("tuid-p"), true));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "tuid-p", cursor: 6 });
});

it("undo clamps the restored caret to the restored text", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [block("tuid-a", "ab", { order_idx: orderIdxOf(0) })]);
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 2));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "x y"));
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 3));
  act(() => outline().handlers.onSplit(uidOf("tuid-a"), 3));
  act(() => outline().handlers.onUndo());
  expect(outline().blocks[0].text).toBe("ab");
  expect(outline().focus).toEqual({ uid: "tuid-a", cursor: 2 });
});

/** A collapsed Roam table: its rows render whatever its collapsed flag says. */
const collapsedTable = () => [
  block("tuid-t", "{{[[table]]}}", { order_idx: orderIdxOf(0), collapsed: true, children: [
    block("tuid-r1", "a", { order_idx: orderIdxOf(0), children: [
      block("tuid-r1b", "b", { order_idx: orderIdxOf(0) }),
    ] }),
  ] }),
  block("tuid-x", "other", { order_idx: orderIdxOf(1) }),
];

it("typing in a cell of a collapsed table keeps focus there through a flush and a remote batch", () => {
  vi.useFakeTimers();
  try {
    const sync = makeSync();
    const outline = setup(sync, PAGE, collapsedTable());
    act(() => outline().handlers.onFocusBlock(uidOf("tuid-r1b"), 1));
    act(() => outline().handlers.onDraftChange(uidOf("tuid-r1b"), "bc"));
    act(() => { vi.advanceTimersByTime(5000); }); // the debounced flush
    expect(sync.sent[0]).toMatchObject([{ op: "update_text", uid: "tuid-r1b", text: "bc" }]);
    expect(outline().focus).toEqual({ uid: "tuid-r1b", cursor: 1 });
    act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
      { op: "update_text", uid: uidOf("tuid-x"), text: "remote" },
    ] }));
    expect(outline().focus).toEqual({ uid: "tuid-r1b", cursor: 1 });
  } finally {
    vi.useRealTimers();
  }
});

it("a remote collapse of the typed block's parent moves focus "
  + "to the parent, and the draft still lands on the block", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-p", "parent", { order_idx: orderIdxOf(0),
                           children: [block("tuid-c", "child", { order_idx: orderIdxOf(0) })] }),
  ]);
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-c"), 5));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-c"), "child typed"));
  act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
    { op: "set_collapsed", uid: uidOf("tuid-p"), collapsed: true },
  ] }));
  expect(outline().focus).toEqual({ uid: "tuid-p", cursor: 6 });

  // Typing in the parent's textarea flushes the hidden block's draft first.
  act(() => outline().handlers.onDraftStart(uidOf("tuid-p"), "parent"));
  expect(sync.sent[0]).toMatchObject([{ op: "update_text", uid: "tuid-c", text: "child typed" }]);
  expect(outline().blocks[0].children[0].text).toBe("child typed");
  expect(outline().blocks[0].text).toBe("parent");
});

it("undo inside a cell of a collapsed table keeps focus in the cell", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, collapsedTable());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-r1b"), 1));
  act(() => outline().handlers.onSetHeading(uidOf("tuid-r1b"), 2));
  act(() => outline().handlers.onUndo());
  expect(outline().focus).toEqual({ uid: "tuid-r1b", cursor: 1 });
});

it("collapse toggles are not undo steps", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE,
    [block("tuid-a", "alpha", { order_idx: orderIdxOf(0), children: [block("tuid-a1", "kid",
      { order_idx: orderIdxOf(0) })] }),
     block("tuid-b", "beta", { order_idx: orderIdxOf(1) })]);
  // onToggleTodo on plain text returns null from toggleTodo (grammar/todo.ts)
  // and records nothing; onSetHeading to a new level produces an op.
  act(() => outline().handlers.onSetHeading(uidOf("tuid-b"), 2)); // recorded entry
  act(() => outline().handlers.onToggleCollapsed(uidOf("tuid-a"), true)); // not recorded
  act(() => outline().handlers.onUndo());
  // undo skipped the collapse and reverted the heading; collapse persists
  expect(outline().blocks[1].heading).toBeNull();
  expect(outline().blocks[0].collapsed).toBe(true);
});

it("a field setter that changes nothing sends no op and records no undo step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onSetHeading(uidOf("tuid-a"), 2)); // recorded entry
  const sent = sync.sent.length;
  act(() => outline().handlers.onSetHeading(uidOf("tuid-a"), 2));
  act(() => outline().handlers.onSetViewType(uidOf("tuid-b"), "document"));
  act(() => outline().handlers.onToggleCollapsed(uidOf("tuid-b"), false));
  expect(sync.sent).toHaveLength(sent);
  act(() => outline().handlers.onUndo()); // reaches the first heading change
  expect(outline().blocks[0].heading).toBeNull();
});

it("a fresh edit after undo clears redo", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, ab());
  act(() => outline().handlers.onSetHeading(uidOf("tuid-a"), 2));
  act(() => outline().handlers.onUndo());
  act(() => outline().handlers.onSetHeading(uidOf("tuid-b"), 2));
  const sent = sync.sent.length;
  act(() => outline().handlers.onRedo()); // nothing to redo
  expect(sync.sent).toHaveLength(sent);
});

it("a batch carrying a draft for a remotely deleted block stays undoable", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "beta", { order_idx: orderIdxOf(1) }),
    block("tuid-c", "gamma", { order_idx: orderIdxOf(2) }),
  ]);
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "see [[Held", true));
  act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
    { op: "delete", uid: uidOf("tuid-a") },
  ] }));
  // The indent's batch flushes the held draft first: its text op targets a
  // block this tree no longer has, and the indent must still be undoable.
  act(() => outline().handlers.onIndent(uidOf("tuid-c")));
  expect(sync.sent[0].map((op) => op.op)).toEqual(["update_text", "move"]);
  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["tuid-c"]);

  act(() => outline().handlers.onUndo());
  expect(outline().blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-c"]);
  // The undo reverses only the indent: nothing re-sends the orphaned text.
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 2 },
  ]);
});
