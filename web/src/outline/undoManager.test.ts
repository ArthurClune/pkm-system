import { afterEach, expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { block, makeSync, ord, uid } from "../test-helpers";
import { acquireOutlineSession } from "./outlineSessions";
import { performRedo, performUndo, recordHistory, registerOutlineHistory,
         resetHistory, setHistoryNavigator } from "./undoManager";
import { historyAnchors, invertOps, type HistoryEntry } from "./history";
import { applyOps } from "./tree";

const PAGE = "Undo Page";

const entry = (): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: uid("a"), text: "after" }],
  inverse: [{ op: "update_text", uid: uid("a"), text: "before" }],
  anchors: { ops: [null], inverse: [null] },
  focusBefore: { uid: uid("a"), cursor: 6 },
  focusAfter: { uid: uid("a"), cursor: 5 },
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
  const handle = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: ord(0) })]);
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

it("navigates on undo when the page's session lingers with no mounted hooks (offline undelivered write)", () => {
  // A session can outlive its component: maybeDeleteSession keeps it alive
  // while it has tracked (undelivered) writes, e.g. an offline edit made
  // before navigating away. No hooks are registered (component unmounted),
  // so the fix must still navigate — while also applying to the session so
  // its data stays fresh for when it's next mounted.
  const sync = makeSync();
  const handle = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: ord(0) })]);
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  recordHistory(entry());
  performUndo(sync);
  // The lingering session IS a tree, so the replayed op is stamped against
  // it; the other undo tests here have no session and go out unstamped.
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before",
                               base_text_hash: sha256Hex("after"),
                               page_title: PAGE }]]);
  expect(handle.getSnapshot().blocks[0].text).toBe("before");
  expect(paths).toHaveLength(1);
  expect(paths[0]).toContain("Undo");
  clear();
  handle.release();
});

it("performUndo returns false on an empty stack without enqueueing", () => {
  const sync = makeSync();
  expect(performUndo(sync)).toBe(false);
  expect(sync.sent).toEqual([]);
});

it("redo stamps against the current tree, not the recorded one", () => {
  // History deliberately records UNSTAMPED ops: a hash taken when the entry was
  // recorded is stale by the time it is replayed, and a stale hash would land a
  // spurious daily-note [[conflict]] header against the user's own later edit.
  // So the hash must be of "two" — the text the server will actually be
  // replacing —
  // not of "one", the text the entry was recorded against.
  const sync = makeSync();
  const handle = acquireOutlineSession(PAGE, [block("a", "one", { order_idx: ord(0) })]);
  recordHistory({
    pageTitle: PAGE,
    ops: [{ op: "update_text", uid: uid("a"), text: "one" }],
    inverse: [{ op: "update_text", uid: uid("a"), text: "zero" }],
    anchors: { ops: [null], inverse: [null] },
    focusBefore: null,
    focusAfter: null,
  });
  performUndo(sync);
  // A later edit of the user's own moves the block on before the redo.
  const later: BlockOp[] = [{ op: "update_text", uid: uid("a"), text: "two" }];
  handle.applyLocal(sync.enqueue(later, ["page", PAGE]), later);
  expect(handle.getSnapshot().blocks[0].text).toBe("two");

  expect(performRedo(sync)).toBe(true);

  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "a", text: "one",
    base_text_hash: sha256Hex("two"),
  });
  handle.release();
});

it("an undo that deletes is stamped against the tree at replay time", () => {
  // The inverse of a create is a delete, recorded unstamped: its subtree hash
  // must cover the block's text as it is when the undo replays, or undoing a
  // block the user has since typed into would land a spurious conflict copy.
  const sync = makeSync();
  const before = [block("a", "first", { order_idx: ord(0) })];
  const create: BlockOp[] = [{ op: "create", uid: uid("n"), page_title: PAGE,
                               parent_uid: null, order_idx: ord(1), text: "" }];
  const inverse = invertOps(before, PAGE, create);
  expect(inverse).toEqual([{ op: "delete", uid: "n" }]);
  const handle = acquireOutlineSession(PAGE, [
    ...before, block("n", "", { order_idx: ord(1) })]);
  recordHistory({ pageTitle: PAGE, ops: create, inverse: inverse!,
                  anchors: historyAnchors(before, PAGE, create, inverse!),
                  focusBefore: null, focusAfter: null });
  const typed: BlockOp[] = [{ op: "update_text", uid: uid("n"), text: "typed later" }];
  handle.applyLocal(sync.enqueue(typed, ["page", PAGE]), typed);

  expect(performUndo(sync)).toBe(true);

  expect(sync.sent[sync.sent.length - 1]).toEqual([{
    op: "delete", uid: "n",
    base_subtree_hash: subtreeHash([["n", "typed later"]]),
  }]);
  handle.release();
});

it("undo re-keys placements against the mounted tree, not the recorded keys", () => {
  // Two moves up in a row: undoing the second shifts keys up, so the first
  // entry's recorded key no longer names b1's old slot.
  const sync = makeSync();
  const move = (u: string, orderIdx: number): BlockOp[] =>
    [{ op: "move", uid: uid(u), parent_uid: null, order_idx: ord(orderIdx) }];
  const record = (pre: BlockNode[], ops: BlockOp[]) => {
    const inverse = invertOps(pre, PAGE, ops)!;
    recordHistory({ pageTitle: PAGE, ops, inverse,
                    anchors: historyAnchors(pre, PAGE, ops, inverse),
                    focusBefore: null, focusAfter: null });
    return applyOps(pre, ops, PAGE);
  };
  let tree = ["b0", "b1", "b2"].map((u, i) => block(u, u, { order_idx: ord(i) }));
  tree = record(tree, move("b1", 0));
  tree = record(tree, move("b2", tree[1].order_idx));
  const handle = acquireOutlineSession(PAGE, tree);
  const order = () => handle.getSnapshot().blocks.map((n) => n.uid);
  expect(order()).toEqual(["b1", "b2", "b0"]);

  performUndo(sync);
  expect(order()).toEqual(["b1", "b0", "b2"]);
  performUndo(sync);
  expect(order()).toEqual(["b0", "b1", "b2"]);
  // the server gets the re-keyed op the session applied
  expect(sync.sent[1]).toEqual([{ op: "move", uid: "b1", parent_uid: null,
                                  order_idx: handle.getSnapshot().blocks[1].order_idx }]);
  performRedo(sync);
  expect(order()).toEqual(["b1", "b0", "b2"]);
  handle.release();
});

it("recording clears redo (integration of AC through the manager)", () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  recordHistory(entry());
  expect(performRedo(sync)).toBe(false);
});
