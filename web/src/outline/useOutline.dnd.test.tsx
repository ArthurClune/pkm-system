import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, pagePayload, stubFetch,
         type SyncFake } from "../test-helpers";
import { findNode } from "./tree";
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

it("onSetViewType enqueues one op and updates the tree optimistically", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [block("u1", "first")]);
  act(() => getOutline().handlers.onSetViewType("u1", "numbered"));
  expect(sync.sent).toEqual([[
    { op: "set_view_type", uid: "u1", view_type: "numbered" },
  ]]);
  expect(findNode(getOutline().blocks, "u1")!.view_type).toBe("numbered");
});

it("remote set_view_type batches update the same tree path", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [block("u1", "first")]);
  act(() => sync.emit({
    client_id: "other", ts: 1,
    ops: [{ op: "set_view_type", uid: "u1", view_type: "numbered" }],
  }));
  expect(findNode(getOutline().blocks, "u1")!.view_type).toBe("numbered");
  expect(sync.sent).toEqual([]);
});

it("applies one remote move exactly once across two same-title views", () => {
  const sync = makeSync();
  const initial = [
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
    block("u3", "third", { order_idx: 2 }),
  ];
  const outlines: Outline[] = [];
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle="Page" initial={initial}
        onReady={(outline) => { outlines[0] = outline; }} />
      <Harness pageTitle="Page" initial={initial}
        onReady={(outline) => { outlines[1] = outline; }} />
    </SyncContext.Provider>);

  act(() => sync.emit({
    client_id: "other",
    ts: 1,
    ops: [{ op: "move", uid: "u3", parent_uid: null, order_idx: 0 }],
  }));

  for (const outline of outlines) {
    expect(outline.blocks.map(({ uid, order_idx }) => [uid, order_idx]))
      .toEqual([["u3", 0], ["u1", 1], ["u2", 2]]);
  }
});

it("starts one target refetch for one remote batch across same-title views", async () => {
  const sync = makeSync();
  const fetchMock = stubFetch([
    ["/api/page/Page", pagePayload("Page", [
      block("known", "known", { order_idx: 0 }),
      block("moved", "moved", { order_idx: 1 }),
    ])],
  ]);
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle="Page"
        initial={[block("known", "known", { order_idx: 0 })]}
        onReady={() => undefined} />
      <Harness pageTitle="Page"
        initial={[block("known", "known", { order_idx: 0 })]}
        onReady={() => undefined} />
    </SyncContext.Provider>);

  await act(async () => {
    sync.emit({
      client_id: "other",
      ts: 1,
      ops: [{ op: "move", uid: "moved", parent_uid: null,
              order_idx: 1, page_title: "Page" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Page", undefined);
});

it("quoted TODO controls preserve the quote prefix and update optimistically", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("u1", "> {{[[TODO]]}} quoted task"),
  ]);
  act(() => getOutline().handlers.onToggleTodo("u1"));
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "> {{[[DONE]]}} quoted task" },
  ]]);
  expect(findNode(getOutline().blocks, "u1")!.text)
    .toBe("> {{[[DONE]]}} quoted task");
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

it("a remote parent-based cross-page move (server-resolved page_title) removes from the source and refetches the target", async () => {
  // The server enriches a bare parent-based cross-page move with the resolved
  // target title before broadcasting (see ops_apply._broadcast_op). The client
  // then handles it off op.page_title with no special casing: the source drops
  // the block, the target refetches (the op carries no block content).
  const sync = makeSync();
  const fetchMock = stubFetch([
    ["/api/page/Dst", pagePayload("Dst", [
      block("tp", "target parent", { order_idx: 0 }),
      block("moved", "moved here", { order_idx: 1 }),
    ])],
  ]);
  let src!: Outline;
  let dst!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle="Src"
        initial={[{ ...block("p", "parent", { order_idx: 0 }),
                    children: [block("moved", "moved here", { order_idx: 0 })] }]}
        onReady={(o) => { src = o; }} />
      <Harness pageTitle="Dst"
        initial={[block("tp", "target parent", { order_idx: 0 })]}
        onReady={(o) => { dst = o; }} />
    </SyncContext.Provider>);

  await act(async () => {
    sync.emit({
      client_id: "other", ts: 1,
      ops: [{ op: "move", uid: "moved", parent_uid: "tp", order_idx: 0,
               page_title: "Dst" }],
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });

  // source: page_title != our page → the block is dropped (its target parent
  // was never in this tree)
  expect(findNode(src.blocks, "moved")).toBeNull();
  expect(src.blocks.map((b) => b.uid)).toEqual(["p"]);
  // target: op carries no block content, so it pulls the authoritative tree
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Dst", undefined);
  expect(dst.blocks.map((b) => b.uid)).toEqual(["tp", "moved"]);
});

it("target-side refetch ignores global settlement and adopts a safe response", async () => {
  const sync = makeSync("connected", {
    settled: () => new Promise(() => undefined),
  });
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

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledWith("/api/page/Page", undefined);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["srv"]);
  // the focused uid ("u1") no longer exists in the adopted tree
  expect(getOutline().focus).toBeNull();
});
