import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOutlineSessionActive } from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, clientIdOf, jsonResponse, makeSync, orderIdxOf, pagePayload,
         rawTitleOf, uidOf } from "../test-helpers";
import { PageView } from "./PageView";

afterEach(() => vi.unstubAllGlobals());

// The server/replica answer /api/page/<raw> with the canonical "Paper" page.
describe.each([
  ["/page/Paper", "Paper"],      // control: raw === canonical
  ["/page/Paper%09", "Paper\t"], // control whitespace: normalized always
  ["/page/Paper%20", "Paper "],  // plain-space flag strips the trailing space
])("PageView at %s", (path, raw) => {
  // A non-canonical path costs one extra initial GET (the raw read, then
  // the canonical re-key read). `setup` serves the initial reads itself and
  // hands fetchImpl the call number as if there were one: its first call is
  // number 2, the read a resync starts.
  const extra = raw === "Paper" ? 0 : 1;
  const initialReads = () => Promise.resolve(jsonResponse(
    pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")])));
  function setup(fetchImpl: (call: number) => Promise<Response>) {
    let n = 0;
    const fetchMock = vi.fn(() => {
      n += 1;
      return n <= 1 + extra ? initialReads() : fetchImpl(n - extra);
    });
    vi.stubGlobal("fetch", fetchMock);
    const sync = makeSync();
    const view = (resyncGeneration: number) => (
      <SyncContext.Provider value={{ ...sync, resyncGeneration }}>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
          <Routes><Route path="/page/*" element={<PageView />} /></Routes>
        </MemoryRouter>
      </SyncContext.Provider>
    );
    const r = render(view(0));
    return { fetchMock, sync, rerender: (g: number) => r.rerender(view(g)) };
  }

  it("keeps one outline session per page", async () => {
    const initial = pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")]);
    setup(() => Promise.resolve(jsonResponse(initial)));
    await screen.findByText("first");
    expect(isOutlineSessionActive(rawTitleOf("Paper"))).toBe(true);
    if (raw !== "Paper") expect(isOutlineSessionActive(rawTitleOf(raw))).toBe(false);
  });

  it("a resync response dispatched before a remote batch cannot erase it", async () => {
    let resolveResync!: (response: Response) => void;
    const resync = new Promise<Response>((done) => { resolveResync = done; });
    const initial = pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")]);
    const both = pagePayload(canonicalTitleOf("Paper"), [
      block("tuid-u1", "first"),
      block("tuid-r1", "from the iPad", { order_idx: orderIdxOf(2) }),
    ]);
    const { fetchMock, sync, rerender } = setup((calls) => {
      if (calls === 2) return resync;
      return Promise.resolve(jsonResponse(both));
    });
    await screen.findByText("first");
    rerender(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2 + extra));
    act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
      { op: "create", uid: uidOf("tuid-r1"), page_title: rawTitleOf("Paper"),
        parent_uid: null, order_idx: orderIdxOf(2), text: "from the iPad" },
    ] }));
    expect(screen.getByText("from the iPad")).toBeInTheDocument();
    await act(async () => {
      resolveResync(jsonResponse(initial)); // read served before the batch
      await resync;
      await Promise.resolve();
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("from the iPad")).toBeInTheDocument();
  });

  it("a resync response that moved on but predates a remote batch cannot erase it", async () => {
    let resolveResync!: (response: Response) => void;
    const resync = new Promise<Response>((done) => { resolveResync = done; });
    // The server read the resync answers from already has R1, not R2.
    const withR1 = pagePayload(canonicalTitleOf("Paper"), [
      block("tuid-u1", "first"),
      block("tuid-r1", "remote one", { order_idx: orderIdxOf(2) }),
    ]);
    const all = pagePayload(canonicalTitleOf("Paper"), [
      block("tuid-u1", "first"),
      block("tuid-r1", "remote one", { order_idx: orderIdxOf(2) }),
      block("tuid-r2", "remote two", { order_idx: orderIdxOf(3) }),
    ]);
    const { fetchMock, sync, rerender } = setup((calls) => {
      if (calls === 2) return resync;
      return Promise.resolve(jsonResponse(all));
    });
    await screen.findByText("first");
    act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
      { op: "create", uid: uidOf("tuid-r1"), page_title: rawTitleOf("Paper"),
        parent_uid: null, order_idx: orderIdxOf(2), text: "remote one" },
    ] }));
    rerender(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2 + extra));
    act(() => sync.emit({ client_id: clientIdOf("other"), ts: 2, ops: [
      { op: "create", uid: uidOf("tuid-r2"), page_title: rawTitleOf("Paper"),
        parent_uid: null, order_idx: orderIdxOf(3), text: "remote two" },
    ] }));
    expect(screen.getByText("remote two")).toBeInTheDocument();
    await act(async () => {
      resolveResync(jsonResponse(withR1));
      await resync;
      await Promise.resolve();
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("remote two")).toBeInTheDocument();
  });

  it("a resync response dispatched before a local split cannot erase it", async () => {
    let resolveResync!: (response: Response) => void;
    const resync = new Promise<Response>((done) => { resolveResync = done; });
    const initial = pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")]);
    let resolveFresh!: (response: Response) => void;
    const fresh = new Promise<Response>((done) => { resolveFresh = done; });
    const { fetchMock, sync, rerender } = setup((calls) => {
      return calls === 2 ? resync : fresh;
    });
    fireEvent.click(await screen.findByText("first"));
    const textarea = document.querySelector(".block-input") as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 5);
    rerender(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2 + extra));
    fireEvent.keyDown(textarea, { key: "Enter" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3 + extra));
    const created = sync.sent.flat().find((op) => op.op === "create");
    if (!created || created.op !== "create") throw new Error("missing create");
    await act(async () => {
      resolveResync(jsonResponse(initial));
      await resync;
      await Promise.resolve();
    });
    await act(async () => {
      resolveFresh(jsonResponse(pagePayload(canonicalTitleOf("Paper"), [
        block("tuid-u1", "first", { order_idx: orderIdxOf(0) }),
        block(created.uid, created.text, { order_idx: created.order_idx }),
      ])));
      await fresh;
      await Promise.resolve();
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelectorAll(".block-row")).toHaveLength(2);
  });
});
