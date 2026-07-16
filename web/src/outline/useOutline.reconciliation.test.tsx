import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import type { DeliveryOutcome, WriteOutcome,
              WriteTicket } from "../sync/opQueue";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, pagePayload } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ title, initial, onReady }: {
  title: string;
  initial: BlockNode[];
  onReady(outline: Outline): void;
}) {
  const outline = useOutline(title, initial);
  useEffect(() => onReady(outline));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("does not let an old target refetch erase a split made after dispatch", async () => {
  const response = deferred<Response>();
  const fresh = deferred<Response>();
  const fetchMock = vi.fn(() =>
    fetchMock.mock.calls.length === 1 ? response.promise : fresh.promise);
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness title="Page" initial={[block("u1", "first")]}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>,
  );

  act(() => sync.emit({
    client_id: "other", ts: 1,
    ops: [{ op: "move", uid: "unknown", parent_uid: null,
            order_idx: 0, page_title: "Page" }],
  }));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    outline.handlers.onFocusBlock("u1", 5);
    outline.handlers.onSplit("u1", 5);
  });
  const created = sync.sent[0].find((op) => op.op === "create");
  if (!created || created.op !== "create") throw new Error("missing create op");

  await act(async () => {
    response.resolve(jsonResponse(pagePayload("Page", [block("u1", "first")] )));
    await response.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(outline.blocks).toHaveLength(2);
  expect(outline.focus?.uid).toBe(created.uid);

  await act(async () => {
    fresh.resolve(jsonResponse(pagePayload("Page", [
      block("u1", "first", { order_idx: 0 }),
      block(created.uid, created.text, { order_idx: created.order_idx }),
    ])));
    await fresh.promise;
    await Promise.resolve();
  });
  expect(outline.blocks).toHaveLength(2);
  expect(outline.focus?.uid).toBe(created.uid);
});

it("adopts Page A while only Page B has an unsettled write", () => {
  const sync = makeSync("connected", { pending: 1 });
  let pageA!: Outline;
  let pageB!: Outline;
  const renderViews = (a: BlockNode[]) => (
    <SyncContext.Provider value={sync}>
      <Harness title="Page A" initial={a}
        onReady={(value) => { pageA = value; }} />
      <Harness title="Page B" initial={[block("b", "B")]}
        onReady={(value) => { pageB = value; }} />
    </SyncContext.Provider>
  );
  const { rerender } = render(renderViews([block("a", "old A")]));

  act(() => pageB.handlers.onSetHeading("b", 1));
  rerender(renderViews([block("a", "server A")]));

  expect(pageA.blocks[0].text).toBe("server A");
});

it("delivery replaces a blocked pre-delivery response with exactly one fresh read", async () => {
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  const sent: WriteTicket[] = [];
  const sync = makeSync("connected", {
    enqueue: (_ops, scope) => {
      const ticket = { id: "write-1", scope: scope ?? [],
                       settled: settled.promise,
                       delivered: delivered.promise };
      sent.push(ticket);
      return ticket;
    },
  });
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(
    pagePayload("Page", [block("u1", "authoritative", { heading: 1 })]),
  )));
  vi.stubGlobal("fetch", fetchMock);
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness title="Page" initial={[block("u1", "old")]}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>,
  );

  act(() => outline.handlers.onSetHeading("u1", 1));
  expect(sent[0].scope).toEqual(["page", "Page"]);
  const token = outline.session!.beginAuthoritativeRead("parent");
  act(() => outline.session!.receiveAuthoritative(
    token, [block("u1", "pre-delivery")],
  ));
  expect(outline.blocks[0]).toMatchObject({ text: "old", heading: 1 });

  await act(async () => {
    settled.resolve({ status: "persisted", pending: 0 });
    await settled.promise;
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchMock).not.toHaveBeenCalled();

  delivered.resolve({ status: "delivered" });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Page", undefined);
  expect(outline.blocks[0]).toMatchObject({ text: "authoritative", heading: 1 });
});
