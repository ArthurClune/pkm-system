import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sha256Hex } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import type { DeliveryOutcome, WriteTicket } from "../sync/opQueue";
import { block, defer, makeSync, orderIdxOf, uidOf, shaOf, ticketIdOf, canonicalTitleOf } from "../test-helpers";
import { acquireOutlineSession } from "./outlineSessions";
import { historyIdle, performRedo, performUndo,
         recordHistory, registerOutlineHistory, resetHistory,
         setAssetReleaser, setHistoryNavigator,
         setHistoryPageLoader } from "./undoManager";
import { DEPTH_NOTICE, MAX_OUTLINE_DEPTH } from "./depthCap";
import { LINK_NESTING_NOTICE,
         TEXT_LENGTH_NOTICE } from "../grammar/textLimits";
import { TITLE_LENGTH_NOTICE } from "../grammar/titleLength";
import { TITLE_SYNTAX_NOTICE } from "../replica/titles";
import { historyAnchors, invertOps, type HistoryEntry } from "./history";
import { applyOps, locate } from "./tree";

const PAGE = canonicalTitleOf("Undo Page");

const entry = (): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: "after" }],
  inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: "before" }],
  anchors: { ops: [null], inverse: [null] },
  freshAssets: [],
  focusBefore: { uid: uidOf("tuid-a"), cursor: 6 },
  focusAfter: { uid: uidOf("tuid-a"), cursor: 5 },
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
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "tuid-a", text: "before" }]]);
  expect(sync.tickets[0].scope).toEqual(["page", PAGE]);
});

it("undo applies to a mounted session and restores focusBefore", () => {
  const sync = makeSync();
  const handle = acquireOutlineSession(PAGE, [block("tuid-a", "after", { order_idx: orderIdxOf(0) })]);
  const focused: (unknown)[] = [];
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => true,
    applyFocus: (f) => focused.push(f),
    showNotice: () => undefined,
  });
  recordHistory(entry());
  performUndo(sync);
  expect(handle.getSnapshot().blocks[0].text).toBe("before");
  expect(focused).toEqual([{ uid: "tuid-a", cursor: 6 }]);
  unregister();
  handle.release();
});

it("redo replays the forward batch and restores focusAfter", async () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  expect(performRedo(sync)).toBe(true);
  await historyIdle();
  expect(sync.sent[1]).toEqual([{ op: "update_text", uid: "tuid-a", text: "after" }]);
});

it("an outline keeping a draft it may not save stops undo and redo",
   async () => {
  const sync = makeSync();
  recordHistory(entry());
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => false,
    applyFocus: () => undefined,
    showNotice: () => undefined,
  });
  expect(performUndo(sync)).toBe(false);
  expect(performRedo(sync)).toBe(false);
  await historyIdle();
  expect(sync.sent).toEqual([]);
  unregister();
  expect(performUndo(sync)).toBe(true); // the entry is still there
});

it("flushes registered drafts before undoing (pending draft becomes the undone entry)", async () => {
  const sync = makeSync();
  const calls: string[] = [];
  const unregister = registerOutlineHistory(PAGE, {
    flushPending: () => {
      calls.push("flush");
      recordHistory(entry());
      return true;
    },
    applyFocus: () => undefined,
    showNotice: () => undefined,
  });
  expect(performUndo(sync)).toBe(true); // flush recorded the entry it then undoes
  await historyIdle();
  expect(calls).toEqual(["flush"]);
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "tuid-a", text: "before" }]]);
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
  const handle = acquireOutlineSession(PAGE, [block("tuid-a", "after", { order_idx: orderIdxOf(0) })]);
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  recordHistory(entry());
  performUndo(sync);
  // The lingering session IS a tree, so the replayed op is stamped against
  // it; the other undo tests here have no session and go out unstamped.
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "tuid-a", text: "before",
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
  const handle = acquireOutlineSession(PAGE, [block("tuid-a", "one", { order_idx: orderIdxOf(0) })]);
  recordHistory({
    pageTitle: PAGE,
    ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: "one" }],
    inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: "zero" }],
    anchors: { ops: [null], inverse: [null] },
  freshAssets: [],
    focusBefore: null,
    focusAfter: null,
  });
  performUndo(sync);
  // A later edit of the user's own moves the block on before the redo.
  const later: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-a"), text: "two" }];
  handle.applyLocal(sync.enqueue(later, ["page", PAGE]), later);
  expect(handle.getSnapshot().blocks[0].text).toBe("two");

  expect(performRedo(sync)).toBe(true);

  expect(sync.sent[sync.sent.length - 1][0]).toMatchObject({
    op: "update_text", uid: "tuid-a", text: "one",
    base_text_hash: sha256Hex("two"),
  });
  handle.release();
});

it("an undo that deletes is stamped against the tree at replay time", () => {
  // The inverse of a create is a delete, recorded unstamped: its subtree hash
  // must cover the block's text as it is when the undo replays, or undoing a
  // block the user has since typed into would land a spurious conflict copy.
  const sync = makeSync();
  const before = [block("tuid-a", "first", { order_idx: orderIdxOf(0) })];
  const create: BlockOp[] = [{ op: "create", uid: uidOf("tuid-n"), page_title: PAGE,
                               parent_uid: null, order_idx: orderIdxOf(1), text: "" }];
  const inverse = invertOps(before, PAGE, create);
  expect(inverse).toEqual([{ op: "delete", uid: "tuid-n" }]);
  const handle = acquireOutlineSession(PAGE, [
    ...before, block("tuid-n", "", { order_idx: orderIdxOf(1) })]);
  recordHistory({ pageTitle: PAGE, ops: create, inverse: inverse!,
                  anchors: historyAnchors(before, PAGE, create, inverse!),
                  freshAssets: [], focusBefore: null, focusAfter: null });
  const typed: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-n"), text: "typed later" }];
  handle.applyLocal(sync.enqueue(typed, ["page", PAGE]), typed);

  expect(performUndo(sync)).toBe(true);

  expect(sync.sent[sync.sent.length - 1]).toEqual([{
    op: "delete", uid: "tuid-n",
    base_subtree_hash: subtreeHash([["tuid-n", "typed later"]]),
  }]);
  handle.release();
});

it("undo re-keys placements against the mounted tree, not the recorded keys", () => {
  // Two moves up in a row: undoing the second shifts keys up, so the first
  // entry's recorded key no longer names b1's old slot.
  const sync = makeSync();
  const move = (u: string, slot: number): BlockOp[] =>
    [{ op: "move", uid: uidOf(u), parent_uid: null, order_idx: orderIdxOf(slot) }];
  const record = (pre: BlockNode[], ops: BlockOp[]) => {
    const inverse = invertOps(pre, PAGE, ops)!;
    recordHistory({ pageTitle: PAGE, ops, inverse,
                    anchors: historyAnchors(pre, PAGE, ops, inverse),
                    freshAssets: [], focusBefore: null, focusAfter: null });
    return applyOps(pre, ops, PAGE);
  };
  let tree = ["tuid-b0", "tuid-b1", "tuid-b2"].map((u, i) => block(u, u, { order_idx: orderIdxOf(i) }));
  tree = record(tree, move("tuid-b1", 0));
  tree = record(tree, move("tuid-b2", tree[1].order_idx));
  const handle = acquireOutlineSession(PAGE, tree);
  const order = () => handle.getSnapshot().blocks.map((n) => n.uid);
  expect(order()).toEqual(["tuid-b1", "tuid-b2", "tuid-b0"]);

  performUndo(sync);
  expect(order()).toEqual(["tuid-b1", "tuid-b0", "tuid-b2"]);
  performUndo(sync);
  expect(order()).toEqual(["tuid-b0", "tuid-b1", "tuid-b2"]);
  // the server gets the re-keyed op the session applied
  expect(sync.sent[1]).toEqual([{ op: "move", uid: "tuid-b1", parent_uid: null,
                                  order_idx: handle.getSnapshot().blocks[1].order_idx }]);
  performRedo(sync);
  expect(order()).toEqual(["tuid-b1", "tuid-b0", "tuid-b2"]);
  handle.release();
});

it("recording clears redo (integration of AC through the manager)", () => {
  const sync = makeSync();
  recordHistory(entry());
  performUndo(sync);
  recordHistory(entry());
  expect(performRedo(sync)).toBe(false);
});

const moveOp = (u: string, slot: number): BlockOp[] =>
  [{ op: "move", uid: uidOf(u), parent_uid: null, order_idx: orderIdxOf(slot) }];

it("undo with no session re-keys placements against the loaded page", async () => {
  // Move b1 to the top, navigate away, and let another device add x at the
  // top, shifting every key up. The recorded inverse key now names b0's slot,
  // so shipping it unchanged would leave b1 in front of b0.
  const sync = makeSync();
  const pre = ["tuid-b0", "tuid-b1", "tuid-b2"].map((u, i) => block(u, u, { order_idx: orderIdxOf(i) }));
  const ops = moveOp("tuid-b1", 0);
  const inverse = invertOps(pre, PAGE, ops)!;
  recordHistory({ pageTitle: PAGE, ops, inverse,
                  anchors: historyAnchors(pre, PAGE, ops, inverse),
                  freshAssets: [], focusBefore: null, focusAfter: null });
  const loaded = applyOps(applyOps(pre, ops, PAGE), [{
    op: "create", uid: uidOf("tuid-x"), page_title: PAGE, parent_uid: null,
    order_idx: orderIdxOf(0), text: "x" }], PAGE);
  expect(loaded.map((n) => n.uid)).toEqual(["tuid-x", "tuid-b1", "tuid-b0", "tuid-b2"]);
  setHistoryPageLoader(async () => loaded);
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));

  performUndo(sync);
  await historyIdle();

  expect(sync.tickets[0].scope).toEqual(["page", PAGE]);
  expect(applyOps(loaded, sync.sent[0], PAGE).map((n) => n.uid))
    .toEqual(["tuid-x", "tuid-b0", "tuid-b1", "tuid-b2"]);
  expect(paths).toHaveLength(1);
  clear();
});

it("undo with no session stamps base_text_hash against the loaded tree", async () => {
  const sync = makeSync();
  setHistoryPageLoader(async () => [block("tuid-a", "typed elsewhere", { order_idx: orderIdxOf(0) })]);
  recordHistory(entry());
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "tuid-a", text: "before",
                               base_text_hash: sha256Hex("typed elsewhere"),
                               page_title: PAGE }]]);
});

it("a mounted-page undo queued behind an unmounted load waits its turn", async () => {
  const sync = makeSync();
  const OTHER = canonicalTitleOf("Other Page");
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  recordHistory(entry());
  recordHistory({ ...entry(), pageTitle: OTHER });
  const mounted = acquireOutlineSession(PAGE, [block("tuid-a", "after", { order_idx: orderIdxOf(0) })]);
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
    [{ op: "update_text", uid: "tuid-a", text: "before" }],
    [{ op: "update_text", uid: "tuid-a", text: "before" }]]);
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

const S1 = shaOf("1".repeat(64));
const S2 = shaOf("2".repeat(64));

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
        id: ticketIdOf(`gated-${gates.length}`), scope: ["page", PAGE],
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

// --- the outline depth cap ---

// A chain of MAX_OUTLINE_DEPTH - 1 blocks, the deepest of them tuid-d99:
// a block moved under it sits at the cap, and one moved under that past it.
function chain(): BlockNode {
  let node = block(`tuid-d${MAX_OUTLINE_DEPTH - 1}`, "",
                   { order_idx: orderIdxOf(0) });
  for (let i = MAX_OUTLINE_DEPTH - 2; i >= 1; i--) {
    node = block(`tuid-d${i}`, "", { order_idx: orderIdxOf(0), children: [node] });
  }
  return node;
}

const P = uidOf("tuid-p");
const X = uidOf("tuid-x");
const moveP = (parent: string | null): BlockOp[] =>
  [{ op: "move", uid: P, parent_uid: parent === null ? null : uidOf(parent),
     order_idx: orderIdxOf(5) }];

// x under p, recorded on a page whose chain is shallow enough to hold it.
const indented = (): BlockNode[] => [
  chain(),
  block("tuid-p", "p", { order_idx: orderIdxOf(1), children: [
    block("tuid-x", "x", { order_idx: orderIdxOf(0) })] }),
];
const outdented = (): BlockNode[] => [
  chain(),
  block("tuid-p", "p", { order_idx: orderIdxOf(1) }),
  block("tuid-x", "x", { order_idx: orderIdxOf(2) }),
];
const outdentOps = (): BlockOp[] =>
  [{ op: "move", uid: X, parent_uid: null, order_idx: orderIdxOf(2) }];
const indentOps = (): BlockOp[] =>
  [{ op: "move", uid: X, parent_uid: P, order_idx: orderIdxOf(0) }];

function recordMove(pre: BlockNode[], ops: BlockOp[]): HistoryEntry {
  const inverse = invertOps(pre, PAGE, ops)!;
  const e: HistoryEntry = {
    pageTitle: PAGE, ops, inverse,
    anchors: historyAnchors(pre, PAGE, ops, inverse),
    freshAssets: [], focusBefore: { uid: X, cursor: 0 },
    focusAfter: { uid: X, cursor: 1 },
  };
  recordHistory(e);
  return e;
}

// p moved to the bottom of the chain, as another device's edit would put it.
const deepen = (tree: BlockNode[]): BlockNode[] =>
  applyOps(tree, moveP(`tuid-d${MAX_OUTLINE_DEPTH - 1}`), PAGE);

const parentOf = (tree: BlockNode[], raw: string) =>
  locate(tree, uidOf(raw))?.parent?.uid ?? null;

function hooksFor(title = PAGE) {
  const notices: string[] = [];
  const focused: unknown[] = [];
  const unregister = registerOutlineHistory(title, {
    flushPending: () => true,
    applyFocus: (f) => focused.push(f),
    showNotice: (text) => notices.push(text),
  });
  return { notices, focused, unregister };
}

it("an undo that would nest past the cap is refused, noticed and kept", () => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  const handle = acquireOutlineSession(PAGE, deepen(outdented()));
  const h = hooksFor();
  const deep = handle.getSnapshot().blocks;

  expect(performUndo(sync)).toBe(true);
  expect(sync.sent).toEqual([]);
  expect(handle.getSnapshot().blocks).toBe(deep);
  expect(h.notices).toEqual([DEPTH_NOTICE]);

  // made room: p back at the top, then the same undo applies
  const room = moveP(null);
  handle.applyLocal(sync.enqueue(room, ["page", PAGE]), room);
  expect(performUndo(sync)).toBe(true);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toMatchObject([{ op: "move", uid: "tuid-x", parent_uid: "tuid-p" }]);
  expect(parentOf(handle.getSnapshot().blocks, "tuid-x")).toBe("tuid-p");
  expect(h.notices).toEqual([DEPTH_NOTICE]);
  // the retried undo is the one redo now holds
  expect(performRedo(sync)).toBe(true);
  expect(parentOf(handle.getSnapshot().blocks, "tuid-x")).toBeNull();
  h.unregister();
  handle.release();
});

it("a redo that would nest past the cap is refused, noticed and kept", () => {
  const sync = makeSync();
  recordMove(outdented(), indentOps());
  const handle = acquireOutlineSession(PAGE, indented());
  const h = hooksFor();
  performUndo(sync);
  expect(parentOf(handle.getSnapshot().blocks, "tuid-x")).toBeNull();
  const deepOps = moveP(`tuid-d${MAX_OUTLINE_DEPTH - 1}`);
  handle.applyLocal(sync.enqueue(deepOps, ["page", PAGE]), deepOps);
  const sentBefore = sync.sent.length;
  const deep = handle.getSnapshot().blocks;

  expect(performRedo(sync)).toBe(true);
  expect(sync.sent).toHaveLength(sentBefore);
  expect(handle.getSnapshot().blocks).toBe(deep);
  expect(h.notices).toEqual([DEPTH_NOTICE]);

  const room = moveP(null);
  handle.applyLocal(sync.enqueue(room, ["page", PAGE]), room);
  expect(performRedo(sync)).toBe(true);
  expect(sync.sent[sync.sent.length - 1])
    .toMatchObject([{ op: "move", uid: "tuid-x", parent_uid: "tuid-p" }]);
  expect(parentOf(handle.getSnapshot().blocks, "tuid-x")).toBe("tuid-p");
  // the retried redo is the one undo now holds
  expect(performUndo(sync)).toBe(true);
  expect(parentOf(handle.getSnapshot().blocks, "tuid-x")).toBeNull();
  h.unregister();
  handle.release();
});

it("a too-deep undo with no session is refused and noticed on the next mount", async () => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  setHistoryPageLoader(async () => deepen(outdented()));
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  const other = hooksFor(canonicalTitleOf("Other Page"));

  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([]);
  expect(paths).toHaveLength(1);
  expect(other.notices).toEqual([]);

  const first = hooksFor();
  expect(first.notices).toEqual([DEPTH_NOTICE]);
  first.unregister();
  const second = hooksFor(); // one notice, handed over once
  expect(second.notices).toEqual([]);
  second.unregister();

  setHistoryPageLoader(async () => outdented());
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0]).toMatchObject([{ op: "move", uid: "tuid-x", parent_uid: "tuid-p" }]);
  other.unregister();
  clear();
});

it("a too-deep redo with no session is refused and kept", async () => {
  const sync = makeSync();
  recordMove(outdented(), indentOps());
  setHistoryPageLoader(async () => indented());
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(1);

  setHistoryPageLoader(async () => deepen(outdented()));
  performRedo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  const h = hooksFor();
  expect(h.notices).toEqual([DEPTH_NOTICE]);
  h.unregister();

  setHistoryPageLoader(async () => outdented());
  performRedo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toMatchObject([{ op: "move", uid: "tuid-x", parent_uid: "tuid-p" }]);
});

it("a page that cannot be read ships the undo unjudged", async () => {
  const sync = makeSync();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  recordMove(indented(), outdentOps());
  setHistoryPageLoader(async () => { throw new Error("offline"); });
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  const h = hooksFor();
  expect(h.notices).toEqual([]);
  h.unregister();
  warn.mockRestore();
});

it("resetHistory drops a pending depth notice", async () => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  setHistoryPageLoader(async () => deepen(outdented()));
  performUndo(sync);
  await historyIdle();
  resetHistory();
  const h = hooksFor();
  expect(h.notices).toEqual([]);
  h.unregister();
});

it("a refused undo's delivery fails, so its upload is not released", async () => {
  const release = spyReleaser();
  const sync = makeSync();
  const e = recordMove(indented(), outdentOps());
  recordHistory({ ...e, freshAssets: [S1] });
  const handle = acquireOutlineSession(PAGE, deepen(outdented()));
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([]);
  expect(release).toHaveBeenCalledTimes(1);
  await expect(release.mock.calls[0][1][0]).resolves
    .toMatchObject({ status: "failed" });
  handle.release();
});

it("a refused undo deletes none of its upload's files; the retry does", async () => {
  // the real releaser: a failed delivery must keep it from calling fetch
  const doFetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", doFetch);
  try {
    const sync = makeSync();
    const e = recordMove(indented(), outdentOps());
    recordHistory({ ...e, freshAssets: [S1] });
    const handle = acquireOutlineSession(PAGE, deepen(outdented()));
    performUndo(sync);
    await historyIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(doFetch).not.toHaveBeenCalled();

    const room = moveP(null);
    handle.applyLocal(sync.enqueue(room, ["page", PAGE]), room);
    performUndo(sync);
    await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
    handle.release();
  } finally {
    vi.unstubAllGlobals();
  }
});

const OTHER = canonicalTitleOf("Other Page");

it("a refused undo goes back below an edit recorded during its read",
   async () => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  performUndo(sync);
  recordHistory({ ...entry(), pageTitle: OTHER });
  gate.resolve(deepen(outdented()));
  await historyIdle();
  expect(sync.sent).toEqual([]);
  setHistoryPageLoader(async () => outdented());
  performUndo(sync);
  await historyIdle();
  performUndo(sync);
  await historyIdle();
  expect(sync.tickets.map((t) => t.scope))
    .toEqual([["page", OTHER], ["page", PAGE]]);
});

it("a refused redo is dropped when an edit was recorded during its read",
   async () => {
  const sync = makeSync();
  recordMove(outdented(), indentOps());
  setHistoryPageLoader(async () => indented());
  performUndo(sync);
  await historyIdle();
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  performRedo(sync);
  recordHistory({ ...entry(), pageTitle: OTHER });
  gate.resolve(deepen(outdented()));
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  expect(performRedo(sync)).toBe(false);
  setHistoryPageLoader(async () => []);
  expect(performUndo(sync)).toBe(true);
  await historyIdle();
  expect(sync.tickets.at(-1)!.scope).toEqual(["page", OTHER]);
  expect(performUndo(sync)).toBe(false);
});

it.each([
  ["refused", () => deepen(outdented())],
  ["applicable", () => outdented()],
])("a reset during a pending read of a %s undo leaves no trace",
   async (_name, tree) => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  const gate = defer<BlockNode[]>();
  const reading = defer<void>();
  setHistoryPageLoader(() => {
    reading.resolve();
    return gate.promise;
  });
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  performUndo(sync);
  await reading.promise; // the reset lands while the read is pending
  resetHistory();
  gate.resolve(tree());
  await new Promise((r) => setTimeout(r, 0));
  expect(sync.sent).toEqual([]);
  expect(paths).toEqual([]);
  const h = hooksFor();
  expect(h.notices).toEqual([]);
  h.unregister();
  expect(performUndo(sync)).toBe(false);
  clear();
});

it("a reset during a page read that fails ships nothing", async () => {
  const sync = makeSync();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  recordMove(indented(), outdentOps());
  const gate = defer<BlockNode[]>();
  const reading = defer<void>();
  setHistoryPageLoader(() => {
    reading.resolve();
    return gate.promise;
  });
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  performUndo(sync);
  await reading.promise;
  resetHistory();
  gate.reject(new Error("offline"));
  await new Promise((r) => setTimeout(r, 0));
  expect(sync.sent).toEqual([]);
  expect(paths).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
  clear();
});

// A replay judged by the text limits as well as the depth cap: an entry can
// carry a text past a limit (a block stored before the limits existed, then
// edited), and the server would refuse the batch whole.
const nest = (n: number) => "[[a//".repeat(n) + "x" + "]]".repeat(n);
const nestedEntry = (): HistoryEntry => ({
  ...entry(),
  ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: nest(33) }],
});

it("a redo whose text is past a limit is refused, noticed and kept", () => {
  const sync = makeSync();
  recordHistory(nestedEntry());
  const handle = acquireOutlineSession(PAGE, [
    block("tuid-a", nest(33), { order_idx: orderIdxOf(0) })]);
  const h = hooksFor();
  performUndo(sync);
  expect(sync.sent).toHaveLength(1);
  expect(handle.getSnapshot().blocks[0].text).toBe("before");

  expect(performRedo(sync)).toBe(true);
  expect(sync.sent).toHaveLength(1);
  expect(handle.getSnapshot().blocks[0].text).toBe("before");
  expect(h.notices).toEqual([LINK_NESTING_NOTICE]);
  // the entry stays on the redo stack: the next redo meets it again
  expect(performRedo(sync)).toBe(true);
  expect(h.notices).toEqual([LINK_NESTING_NOTICE, LINK_NESTING_NOTICE]);
  expect(sync.sent).toHaveLength(1);
  h.unregister();
  handle.release();
});

it("an undo that would restore a link to a title past the cap is refused",
   () => {
  const sync = makeSync();
  // A block stored before the title cap, which the user then edited.
  const legacy = `[[${"t".repeat(1001)}]]`;
  recordHistory({
    ...entry(),
    ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: "x" }],
    inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: legacy }],
  });
  const handle = acquireOutlineSession(PAGE, [
    block("tuid-a", "x", { order_idx: orderIdxOf(0) })]);
  const h = hooksFor();

  expect(performUndo(sync)).toBe(true);
  expect(sync.sent).toEqual([]);
  expect(handle.getSnapshot().blocks[0].text).toBe("x");
  expect(h.notices).toEqual([TITLE_LENGTH_NOTICE]);
  // the entry stays on the undo stack: the next undo meets it again
  expect(performUndo(sync)).toBe(true);
  expect(h.notices).toEqual([TITLE_LENGTH_NOTICE, TITLE_LENGTH_NOTICE]);
  expect(sync.sent).toEqual([]);
  h.unregister();
  handle.release();
});

it("an undo that would restore a link to a forbidden title is refused",
   () => {
  const sync = makeSync();
  recordHistory({
    ...entry(),
    ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: "x" }],
    inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: "[[C#]]" }],
  });
  const handle = acquireOutlineSession(PAGE, [
    block("tuid-a", "x", { order_idx: orderIdxOf(0) })]);
  const h = hooksFor();

  expect(performUndo(sync)).toBe(true);
  expect(sync.sent).toEqual([]);
  expect(handle.getSnapshot().blocks[0].text).toBe("x");
  expect(h.notices).toEqual([TITLE_SYNTAX_NOTICE]);
  h.unregister();
  handle.release();
});

it("an undo whose text is past a limit is refused on an unmounted page",
   async () => {
  const sync = makeSync();
  const long = "l".repeat(1_000_001);
  recordHistory({
    ...entry(),
    inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: long }],
  });
  setHistoryPageLoader(async () => [
    block("tuid-a", "after", { order_idx: orderIdxOf(0) })]);
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toEqual([]);
  const h = hooksFor();
  expect(h.notices).toEqual([TEXT_LENGTH_NOTICE]);
  h.unregister();
});

it("a page that cannot be read still judges the text limits", async () => {
  const sync = makeSync();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  recordHistory(nestedEntry());
  performUndo(sync);
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  setHistoryPageLoader(async () => { throw new Error("offline"); });

  performRedo(sync);
  await historyIdle();

  expect(sync.sent).toHaveLength(1);
  const h = hooksFor();
  expect(h.notices).toEqual([LINK_NESTING_NOTICE]);
  h.unregister();
  warn.mockRestore();
});
