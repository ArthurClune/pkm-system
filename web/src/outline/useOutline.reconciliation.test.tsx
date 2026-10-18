import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import type { DeliveryOutcome, WriteOutcome, WriteTicket } from "../sync/opQueue";
import { SyncContext } from "../sync/SyncProvider";
import { sha256Hex } from "../replica/sha256";
import {
  block,
  jsonResponse,
  makeSync,
  orderIdxOf,
  pagePayload,
  READ_INIT,
  stubFetch,
  canonicalTitleOf,
  uidOf,
  clientIdOf,
  ticketIdOf,
} from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ title: pageTitle, initial, onReady }: {
  title: string;
  initial: BlockNode[];
  onReady(outline: Outline): void;
}) {
  const outline = useOutline(canonicalTitleOf(pageTitle), initial);
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
      <Harness title="Page" initial={[block("tuid-u1", "first")]}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>,
  );

  act(() => sync.emit({
    client_id: clientIdOf("other"), ts: 1,
    ops: [{ op: "move", uid: uidOf("unknown"), parent_uid: null,
            order_idx: orderIdxOf(0), page_title: "Page" }],
  }));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    outline.handlers.onFocusBlock(uidOf("tuid-u1"), 5);
    outline.handlers.onSplit(uidOf("tuid-u1"), 5);
  });
  const created = sync.sent[0].find((op) => op.op === "create");
  if (!created || created.op !== "create") throw new Error("missing create op");

  await act(async () => {
    response.resolve(jsonResponse(pagePayload("Page", [block("tuid-u1", "first")] )));
    await response.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(outline.blocks).toHaveLength(2);
  expect(outline.focus?.uid).toBe(created.uid);

  await act(async () => {
    fresh.resolve(jsonResponse(pagePayload("Page", [
      block("tuid-u1", "first", { order_idx: orderIdxOf(0) }),
      block(created.uid, created.text, { order_idx: created.order_idx }),
    ])));
    await fresh.promise;
    await Promise.resolve();
  });
  expect(outline.blocks).toHaveLength(2);
  expect(outline.focus?.uid).toBe(created.uid);
});

it("adopts an empty daily rather than rejecting when the cross-page-move catch-up read 404s", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ detail: "not found" }, 404)));
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness title="August 17th, 2026" initial={[block("tuid-u1", "old")]}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>,
  );

  // A move op naming this page for a uid never seen here (session.snapshot
  // has only "tuid-u1") is the cross-page-move target case: outlineSessions'
  // needsAuthoritative fires and useOutline's refetch calls loadOutlineBlocks
  // with substituteMissingDaily. That policy turns this 404 into an empty
  // page instead of a rejection that refetch's own catch(() => undefined)
  // would otherwise swallow, leaving the stale "old" block behind.
  act(() => sync.emit({
    client_id: clientIdOf("other"), ts: 1,
    ops: [{ op: "move", uid: uidOf("incoming"), parent_uid: null, order_idx: orderIdxOf(0),
            page_title: "August 17th, 2026" }],
  }));

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await vi.waitFor(() => expect(outline.blocks).toHaveLength(0));
});

it("adopts Page A while only Page B has an unsettled write", () => {
  const sync = makeSync("connected", { pending: 1 });
  let pageA!: Outline;
  let pageB!: Outline;
  const renderViews = (a: BlockNode[]) => (
    <SyncContext.Provider value={sync}>
      <Harness title="Page A" initial={a}
        onReady={(value) => { pageA = value; }} />
      <Harness title="Page B" initial={[block("tuid-b", "B")]}
        onReady={(value) => { pageB = value; }} />
    </SyncContext.Provider>
  );
  const { rerender } = render(renderViews([block("tuid-a", "old A")]));

  act(() => pageB.handlers.onSetHeading(uidOf("tuid-b"), 1));
  rerender(renderViews([block("tuid-a", "server A")]));

  expect(pageA.blocks[0].text).toBe("server A");
});

it("delivery replaces a blocked pre-delivery response with exactly one fresh read", async () => {
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  const sent: WriteTicket[] = [];
  const sync = makeSync("connected", {
    enqueue: (_ops, scope) => {
      const ticket = { id: ticketIdOf("write-1"), scope: scope ?? [],
                       settled: settled.promise,
                       delivered: delivered.promise };
      sent.push(ticket);
      return ticket;
    },
  });
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(
    pagePayload("Page", [block("tuid-u1", "authoritative", { heading: 1 })]),
  )));
  vi.stubGlobal("fetch", fetchMock);
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness title="Page" initial={[block("tuid-u1", "old")]}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>,
  );

  act(() => outline.handlers.onSetHeading(uidOf("tuid-u1"), 1));
  expect(sent[0].scope).toEqual(["page", "Page"]);
  const token = outline.session!.beginAuthoritativeRead("parent");
  act(() => {
    outline.session!.receiveAuthoritative(token, [block("tuid-u1", "pre-delivery")]);
  });
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
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Page", READ_INIT);
  expect(outline.blocks[0]).toMatchObject({ text: "authoritative", heading: 1 });
});

it("a new parent tree flushes a live draft before adopting it", () => {
  stubFetch([["/api/page/", pagePayload("Page A", [block("tuid-a", "server A")])]]);
  const sync = makeSync("connected", {
    settled: () => new Promise(() => undefined),
  });
  let outline!: Outline;
  const view = (initial: BlockNode[]) => (
    <SyncContext.Provider value={sync}>
      <Harness title="Page A" initial={initial}
        onReady={(value) => { outline = value; }} />
    </SyncContext.Provider>
  );
  const { rerender } = render(view([block("tuid-a", "old A")]));
  act(() => {
    outline.handlers.onFocusBlock(uidOf("tuid-a"), 0);
    // Held, so no debounce timer is involved.
    outline.handlers.onDraftChange(uidOf("tuid-a"), "typed", true);
  });

  rerender(view([block("tuid-a", "server A")]));

  expect(sync.sent).toEqual([[{
    op: "update_text", uid: "tuid-a", text: "typed",
    base_text_hash: sha256Hex("old A"), page_title: "Page A",
  }]]);
  // The flushed draft is an unsettled relevant write, so the parent tree waits.
  expect(outline.blocks[0].text).toBe("typed");
  act(() => outline.handlers.onBlurBlock(uidOf("tuid-a")));
  // The draft was consumed by that flush, not duplicated by the blur.
  expect(sync.sent).toHaveLength(1);
});
