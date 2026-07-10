import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, pagePayload, stubFetch,
         type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

it("dnd.moveTo enqueues one move op with no page_title and reorders optimistically", () => {
  const sync = makeSync();
  const initial = [
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
  ];
  const getOutline = setup(sync, "Page", initial);
  act(() => {
    getOutline().dnd.moveTo("u2",
      { parent_uid: null, order_idx: 0, page_title: "Page" });
  });
  expect(sync.sent).toEqual([
    [{ op: "move", uid: "u2", parent_uid: null, order_idx: 0 }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["u2", "u1"]);
});

it("dnd.removeSubtreeLocal detaches the subtree, sends no ops, and clears focus inside it", () => {
  const sync = makeSync();
  const initial = [
    { ...block("p1", "parent", { order_idx: 0 }),
      children: [block("c1", "child", { order_idx: 0 })] },
  ];
  const getOutline = setup(sync, "Page", initial);
  act(() => { getOutline().handlers.onFocusBlock("c1", 0); });
  expect(getOutline().focus).toEqual({ uid: "c1", cursor: 0 });

  let detached: BlockNode | null = null;
  act(() => { detached = getOutline().dnd.removeSubtreeLocal("p1"); });

  expect(detached).not.toBeNull();
  expect(detached!.uid).toBe("p1");
  expect(detached!.children.map((c) => c.uid)).toEqual(["c1"]);
  expect(getOutline().blocks).toEqual([]);
  expect(sync.sent).toEqual([]);
  expect(getOutline().focus).toBeNull();
});

it("dnd.insertSubtreeLocal inserts at the target and sends no ops", () => {
  const sync = makeSync();
  const initial = [block("u1", "only", { order_idx: 0 })];
  const getOutline = setup(sync, "Page", initial);
  const node: BlockNode = block("new", "inserted", { order_idx: 0 });
  act(() => {
    getOutline().dnd.insertSubtreeLocal(node,
      { parent_uid: null, order_idx: 0, page_title: "Page" });
  });
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["new", "u1"]);
  expect(sync.sent).toEqual([]);
});

it("target-side refetch waits for sync.idle() to resolve before fetching, then adopts and re-validates focus", async () => {
  const base = makeSync();
  const idleGate = deferred<void>();
  const sync: SyncFake = { ...base, idle: () => idleGate.promise };
  const serverBlocks = [block("srv", "from server", { order_idx: 0 })];
  const fetchMock = stubFetch([
    ["/api/page/Page", pagePayload("Page", serverBlocks)],
  ]);
  const getOutline = setup(sync, "Page",
    [block("u1", "first", { order_idx: 0 })]);
  act(() => { getOutline().handlers.onFocusBlock("u1", 0); });

  act(() => {
    sync.emit({
      client_id: "other", ts: 1,
      ops: [{ op: "move", uid: "unknown", parent_uid: null,
               order_idx: 0, page_title: "Page" }],
    });
  });

  // the fetch must not fire while our own queue is still draining
  expect(fetchMock).not.toHaveBeenCalled();

  idleGate.resolve();
  await act(async () => {
    await idleGate.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledWith("/api/page/Page", undefined);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["srv"]);
  // the focused uid ("u1") no longer exists in the adopted tree
  expect(getOutline().focus).toBeNull();
});
