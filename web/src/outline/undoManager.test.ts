import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sha256Hex } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { releaseAssets, releaseUrl } from "../sync/assetRelease";
import type { DeliveryOutcome, TicketId, WriteTicket } from "../sync/opQueue";
import { block, defer, makeSync, ord, uid } from "../test-helpers";
import { acquireOutlineSession } from "./outlineSessions";
import { historyIdle, installUnloadRelease, performRedo, performUndo,
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
afterEach(() => resetHistory());

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
    flushPending: () => { calls.push("flush"); recordHistory(entry()); },
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

// --- releasing the fresh assets of discarded redo entries ---

const S1 = "1".repeat(64) as Sha256Hex;
const S2 = "2".repeat(64) as Sha256Hex;
const DELIVERED: DeliveryOutcome = { status: "delivered" };

const upload = (sha: Sha256Hex): HistoryEntry => ({ ...entry(), freshAssets: [sha] });

function gatedTicket() {
  const gate = defer<DeliveryOutcome>();
  const ticket = {
    id: `gated-${Math.random()}` as TicketId, scope: ["page", PAGE],
    settled: Promise.resolve({ status: "persisted", pending: 0 }),
    delivered: gate.promise,
  } satisfies WriteTicket;
  return { ticket, gate };
}

// A HistoryDispatch whose tickets deliver only when the test says so.
function gatedSync() {
  const tickets: WriteTicket[] = [];
  const gates: ReturnType<typeof defer<DeliveryOutcome>>[] = [];
  return {
    tickets, gates,
    enqueue(_ops: BlockOp[], _scope?: readonly string[]): WriteTicket {
      const { ticket, gate } = gatedTicket();
      tickets.push(ticket);
      gates.push(gate);
      return ticket;
    },
  };
}

function spyReleaser() {
  const release = vi.fn(
    async (_shas: readonly Sha256Hex[],
           _waitFor: readonly Promise<DeliveryOutcome>[]) => undefined);
  const releaseOnUnload = vi.fn((_shas: readonly Sha256Hex[]) => undefined);
  setAssetReleaser({ release, releaseOnUnload });
  return { release, releaseOnUnload };
}

const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });

// An undelivered write keeps a page's session alive past release(), which
// would leave later tests dispatching to a mounted page.
async function closeSession(sync: ReturnType<typeof gatedSync>,
                            handle: { release(): void }): Promise<void> {
  sync.gates.forEach((g) => g.resolve(DELIVERED));
  handle.release();
  await flush();
}

function settledValue<T>(p: Promise<T>): () => T | undefined {
  let value: T | undefined;
  void p.then((v) => { value = v; });
  return () => value;
}

it("undo then a new edit releases the entry's fresh assets after both deliveries", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  const handle = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: ord(0) })]);
  recordHistory(upload(S1));
  performUndo(sync);
  expect(release).not.toHaveBeenCalled();
  const edit = gatedTicket();
  recordHistory(entry(), edit.ticket);
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith(
    [S1], [sync.tickets[0].delivered, edit.ticket.delivered]);
  await closeSession(sync, handle);
});

it("undo then redo then an edit releases nothing", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  recordHistory(upload(S1));
  performUndo(sync);
  performRedo(sync);
  await historyIdle();
  recordHistory(entry(), gatedTicket().ticket);
  expect(release).not.toHaveBeenCalled();
});

it("entries without freshAssets are never released", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  recordHistory(entry());
  performUndo(sync);
  await historyIdle();
  recordHistory(entry(), gatedTicket().ticket);
  expect(release).not.toHaveBeenCalled();
});

it("two undone uploads are both released by one edit", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  recordHistory(upload(S1));
  recordHistory(upload(S2));
  performUndo(sync);
  performUndo(sync);
  await historyIdle();
  const edit = gatedTicket();
  recordHistory(entry(), edit.ticket);
  expect(release.mock.calls.map(([shas]) => shas).sort())
    .toEqual([[S1], [S2]]);
  for (const [, waitFor] of release.mock.calls) {
    expect(waitFor).toHaveLength(2);
    expect(waitFor[1]).toBe(edit.ticket.delivered);
  }
});

it("an edit with no ticket waits only on the undo", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  const handle = acquireOutlineSession(PAGE, [block("a", "after", { order_idx: ord(0) })]);
  recordHistory(upload(S1));
  performUndo(sync);
  recordHistory(entry());
  expect(release).toHaveBeenCalledWith([S1], [sync.tickets[0].delivered]);
  await closeSession(sync, handle);
});

it("an undo dispatched to an unmounted page releases only after that dispatch's delivery", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  const read = defer<BlockNode[]>();
  setHistoryPageLoader(() => read.promise);
  recordHistory(upload(S1));
  performUndo(sync);
  recordHistory(entry(), gatedTicket().ticket);
  expect(release).toHaveBeenCalledTimes(1);
  const undoOutcome = settledValue(release.mock.calls[0][1][0]);

  await flush();
  expect(sync.tickets).toHaveLength(0);
  expect(undoOutcome()).toBeUndefined();

  read.resolve([]);
  await historyIdle();
  await flush();
  expect(sync.tickets).toHaveLength(1);
  expect(undoOutcome()).toBeUndefined();

  sync.gates[0].resolve(DELIVERED);
  await flush();
  expect(undoOutcome()).toEqual(DELIVERED);
});

it("an unmounted undo whose enqueue throws gives the release a failed receipt", async () => {
  const { release } = spyReleaser();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sync = gatedSync();
  sync.enqueue = () => { throw new Error("disposed"); };
  recordHistory(upload(S1));
  performUndo(sync);
  await historyIdle();
  recordHistory(entry(), gatedTicket().ticket);
  const undoOutcome = settledValue(release.mock.calls[0][1][0]);
  await flush();
  expect(undoOutcome()).toMatchObject({ status: "failed" });
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it("an unmounted undo dropped by a history reset gives the release a failed receipt", async () => {
  const { release } = spyReleaser();
  const sync = gatedSync();
  const read = defer<BlockNode[]>();
  setHistoryPageLoader(() => read.promise);
  recordHistory(upload(S1));
  recordHistory(upload(S2));
  performUndo(sync); // S2: waits on the read
  performUndo(sync); // S1: queued behind it
  recordHistory(entry(), gatedTicket().ticket);
  const outcomes = release.mock.calls.map(([, waitFor]) => settledValue(waitFor[0]));
  resetHistory();
  read.resolve([]);
  await flush();
  expect(sync.tickets).toHaveLength(0);
  expect(outcomes.map((o) => o()?.status).sort()).toEqual(["failed", "failed"]);
});

it("undo then re-upload of the same file waits for the clearing edit", async () => {
  const doFetch = vi.fn(async () => ({ status: 409 }) as Response);
  setAssetReleaser({
    release: (shas, waitFor) => releaseAssets(shas, waitFor, doFetch),
    releaseOnUnload: () => undefined,
  });
  const sync = gatedSync();
  recordHistory(upload(S1));
  performUndo(sync);
  await historyIdle();
  sync.gates[0].resolve(DELIVERED);
  // The re-upload is a dedup hit, so its entry carries no fresh assets; its
  // text references the file, so the delete must not run before it lands.
  const redrop = gatedTicket();
  recordHistory(entry(), redrop.ticket);
  await flush();
  expect(doFetch).not.toHaveBeenCalled();
  redrop.gate.resolve(DELIVERED);
  await flush();
  expect(doFetch).toHaveBeenCalledTimes(1);
  expect(doFetch).toHaveBeenCalledWith(releaseUrl(S1), expect.objectContaining({ method: "DELETE" }));
});

it("pagehide releases only undos already delivered", async () => {
  const { releaseOnUnload } = spyReleaser();
  const sync = gatedSync();
  recordHistory(upload(S1));
  recordHistory(upload(S2));
  performUndo(sync); // S2's entry: tickets[0]
  performUndo(sync); // S1's entry: tickets[1]
  await historyIdle();
  sync.gates[0].resolve(DELIVERED);
  await flush();
  const remove = installUnloadRelease(window);
  window.dispatchEvent(new Event("pagehide"));
  expect(releaseOnUnload).toHaveBeenCalledTimes(1);
  expect(releaseOnUnload).toHaveBeenCalledWith([S2]);
  remove();
  window.dispatchEvent(new Event("pagehide"));
  expect(releaseOnUnload).toHaveBeenCalledTimes(1);
});

it("pagehide skips an undone upload that was redone", async () => {
  const { releaseOnUnload } = spyReleaser();
  const sync = gatedSync();
  recordHistory(upload(S1));
  performUndo(sync);
  await historyIdle();
  sync.gates[0].resolve(DELIVERED);
  await flush();
  performRedo(sync);
  await historyIdle();
  const remove = installUnloadRelease(window);
  window.dispatchEvent(new Event("pagehide"));
  expect(releaseOnUnload).not.toHaveBeenCalled();
  remove();
});

it("resetHistory restores the default releaser", async () => {
  const { release } = spyReleaser();
  resetHistory();
  setHistoryPageLoader(async () => []);
  const fetchSpy = vi.spyOn(globalThis, "fetch")
    .mockResolvedValue({ status: 200 } as Response);
  const sync = gatedSync();
  recordHistory(upload(S1));
  performUndo(sync);
  await historyIdle();
  recordHistory(entry());
  sync.gates[0].resolve(DELIVERED);
  await flush();
  expect(release).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledWith(releaseUrl(S1),
    expect.objectContaining({ method: "DELETE" }));
  fetchSpy.mockRestore();
});
