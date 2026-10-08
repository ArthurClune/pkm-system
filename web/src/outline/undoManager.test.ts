import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sha256Hex } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import type { DeliveryOutcome, TicketId, WriteTicket } from "../sync/opQueue";
import { block, defer, makeSync, ord,
         uid } from "../test-helpers";
import { acquireOutlineSession } from "./outlineSessions";
import { historyIdle, performRedo, performUndo,
         recordHistory, registerOutlineHistory, resetHistory,
         setAssetReleaser, setHistoryNavigator,
         setHistoryPageLoader } from "./undoManager";
import { historyAnchors, invertOps, type HistoryEntry } from "./history";
import { applyOps } from "./tree";

const PAGE = "Undo Page";

const entry = (): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: uid("a"), text: "after" }],
  inverse: [{ op: "update_text", uid: uid("a"), text: "before" }],
  anchors: { ops: [null], inverse: [null] },
  freshAssets: [],
  focusBefore: { uid: uid("a"), cursor: 6 },
  focusAfter: { uid: uid("a"), cursor: 5 },
});

// Unmounted pages are read through the page loader; an empty tree keeps the
// ops unstamped, as a block the tree does not know is.
beforeEach(() => { setHistoryPageLoader(async () => []); });
afterEach(() => { resetHistory(); });

it("undo enqueues the inverse batch scoped to the entry's page", async () => {
  const sync = makeSync();
  recordHistory(entry());
  expect(performUndo(sync)).toBe(true);
  await historyIdle();
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

it("redo replays the forward batch and restores focusAfter", async () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  expect(performRedo(sync)).toBe(true);
  await historyIdle();
  expect(sync.sent[1]).toEqual([{ op: "update_text", uid: "a", text: "after" }]);
});

it("flushes registered drafts before undoing (pending draft becomes the undone entry)", async () => {
  const sync = makeSync();
  const calls: string[] = [];
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => {
      calls.push("flush");
      recordHistory(entry());
    },
    applyFocus: () => undefined,
  });
  expect(performUndo(sync)).toBe(true); // flush recorded the entry it then undoes
  await historyIdle();
  expect(calls).toEqual(["flush"]);
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before" }]]);
  unregister();
});

it("navigates to the entry's page when no session is mounted", async () => {
  const sync = makeSync();
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  recordHistory(entry());
  performUndo(sync);
  await historyIdle();
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
  freshAssets: [],
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
                  freshAssets: [], focusBefore: null, focusAfter: null });
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
                    freshAssets: [], focusBefore: null, focusAfter: null });
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

const moveOp = (u: string, orderIdx: number): BlockOp[] =>
  [{ op: "move", uid: uid(u), parent_uid: null, order_idx: ord(orderIdx) }];

it("undo with no session re-keys placements against the loaded page", async () => {
  // Move b1 to the top, navigate away, and let another device add x at the
  // top, shifting every key up. The recorded inverse key now names b0's slot,
  // so shipping it unchanged would leave b1 in front of b0.
  const sync = makeSync();
  const pre = ["b0", "b1", "b2"].map((u, i) => block(u, u, { order_idx: ord(i) }));
  const ops = moveOp("b1", 0);
  const inverse = invertOps(pre, PAGE, ops)!;
  recordHistory({ pageTitle: PAGE, ops, inverse,
                  anchors: historyAnchors(pre, PAGE, ops, inverse),
                  freshAssets: [], focusBefore: null, focusAfter: null });
  const loaded = applyOps(applyOps(pre, ops, PAGE), [{
    op: "create", uid: uid("x"), page_title: PAGE, parent_uid: null,
    order_idx: ord(0), text: "x" }], PAGE);
  expect(loaded.map((n) => n.uid)).toEqual(["x", "b1", "b0", "b2"]);
  setHistoryPageLoader(async () => loaded);
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));

  performUndo(sync);
  await historyIdle();

  expect(sync.tickets[0].scope).toEqual(["page", PAGE]);
  expect(applyOps(loaded, sync.sent[0], PAGE).map((n) => n.uid))
    .toEqual(["x", "b0", "b1", "b2"]);
  expect(paths).toHaveLength(1);
  clear();
});

it("undo with no session stamps base_text_hash against the loaded tree", async () => {
  const sync = makeSync();
  setHistoryPageLoader(async () => [block("a", "typed elsewhere", { order_idx: ord(0) })]);
  recordHistory(entry());
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "before",
                               base_text_hash: sha256Hex("typed elsewhere"),
                               page_title: PAGE }]]);
});

it("a mounted-page undo queued behind an unmounted load waits its turn", async () => {
  const sync = makeSync();
  const OTHER = "Other Page";
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  recordHistory(entry());
  recordHistory({ ...entry(), pageTitle: OTHER });
  const mounted = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: ord(0) })]);
  performUndo(sync); // OTHER: no session, load pending
  performUndo(sync); // PAGE: mounted, but must wait behind the load
  expect(sync.sent).toEqual([]);
  expect(mounted.getSnapshot().blocks[0].text).toBe("after");
  gate.resolve([]);
  await historyIdle();
  expect(sync.tickets.map((t) => t.scope)).toEqual([
    ["page", OTHER], ["page", PAGE]]);
  expect(mounted.getSnapshot().blocks[0].text).toBe("before");
  mounted.release();
});

it("a failed load ships the recorded batch unstamped, navigates, and later dispatches still run", async () => {
  const sync = makeSync();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setHistoryPageLoader(async () => { throw new Error("offline"); });
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  recordHistory(entry());
  recordHistory(entry());
  performUndo(sync);
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "a", text: "before" }],
    [{ op: "update_text", uid: "a", text: "before" }]]);
  expect(paths).toHaveLength(2);
  expect(warn).toHaveBeenCalled();
  clear();
  warn.mockRestore();
});

it("a throwing enqueue is logged and does not break later dispatches or leak the session", async () => {
  const sync = makeSync();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const boom = vi.spyOn(sync, "enqueue").mockImplementationOnce(() => {
    throw new Error("disposed");
  });
  recordHistory(entry());
  recordHistory(entry());
  performUndo(sync);
  performUndo(sync);
  await historyIdle();
  expect(boom).toHaveBeenCalledTimes(2);
  expect(sync.sent).toHaveLength(1);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

// --- releasing the fresh assets of an undone upload ---

const S1 = "1".repeat(64) as Sha256Hex;
const S2 = "2".repeat(64) as Sha256Hex;

const upload = (...shas: Sha256Hex[]): HistoryEntry =>
  ({ ...entry(), freshAssets: shas });

// A HistoryDispatch whose tickets deliver only when the test says so.
function gatedSync() {
  const gates: ReturnType<typeof defer<DeliveryOutcome>>[] = [];
  return {
    gates,
    enqueue(_ops: BlockOp[], _scope?: readonly string[]): WriteTicket {
      const gate = defer<DeliveryOutcome>();
      gates.push(gate);
      return {
        id: `gated-${gates.length}` as TicketId, scope: ["page", PAGE],
        settled: Promise.resolve({ status: "persisted", pending: 0 }),
        delivered: gate.promise,
      } satisfies WriteTicket;
    },
  };
}

function spyReleaser() {
  const release = vi.fn(
    async (_shas: readonly Sha256Hex[],
           _waitFor: readonly Promise<DeliveryOutcome>[]) => undefined);
  setAssetReleaser({ release });
  return release;
}

it("undoing an upload releases its fresh assets, waiting on the undo's delivery", async () => {
  const release = spyReleaser();
  const sync = makeSync();
  recordHistory(upload(S1, S2));
  performUndo(sync);
  await historyIdle();
  expect(release).toHaveBeenCalledTimes(1);
  const [shas, waitFor] = release.mock.calls[0];
  expect(shas).toEqual([S1, S2]);
  expect(waitFor).toHaveLength(1);
  await expect(waitFor[0]).resolves.toEqual({ status: "delivered" });
  expect(sync.sent).toHaveLength(1);
});

it("the release waits on the undo's own write, which here fails", async () => {
  const release = spyReleaser();
  const sync = gatedSync();
  recordHistory(upload(S1));
  performUndo(sync);
  await historyIdle();
  const failure: DeliveryOutcome = { status: "failed", error: new Error("x") };
  sync.gates[0].resolve(failure);
  await expect(release.mock.calls[0][1][0]).resolves.toEqual(failure);
});

it("redo after undoing an upload does nothing", async () => {
  spyReleaser();
  const sync = makeSync();
  recordHistory(entry());
  recordHistory(upload(S1));
  performUndo(sync); // the upload
  await historyIdle();
  expect(performRedo(sync)).toBe(false);
  expect(sync.sent).toHaveLength(1);
});

it("undoing an entry without fresh assets releases nothing and stays redoable", async () => {
  const release = spyReleaser();
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  await historyIdle();
  expect(release).not.toHaveBeenCalled();
  expect(performRedo(sync)).toBe(true);
});

it("redoing an ordinary entry releases nothing", async () => {
  const release = spyReleaser();
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  performRedo(sync);
  await historyIdle();
  expect(release).not.toHaveBeenCalled();
});
