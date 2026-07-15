import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { isOutlineSessionActive } from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, pagePayload, stubFetch } from "../test-helpers";
import { EditableSidebarPanel } from "../components/EditableSidebarPanel";
import { PageView } from "./PageView";

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <Routes>
        <Route path="/page/*" element={<PageView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("fetches and renders a page, resolving block refs from the payload", async () => {
  const fetchMock = stubFetch([
    ["/api/page/Generative%20Models", pagePayload("Generative Models", [
      block("uid_p1", "intro [[Paper]]"),
      block("uid_p2", "See ((uid_r1))"),
    ], { block_ref_texts: { uid_r1: { text: "the referenced text", page_title: "Paper" } } })],
  ]);
  renderAt("/page/Generative%20Models");
  expect(await screen.findByRole("heading", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.getByText("the referenced text")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Generative%20Models", undefined);
});

it("keeps literal slashes in namespace titles", async () => {
  const fetchMock = stubFetch([
    ["/api/page/AWS/SCP", pagePayload("AWS/SCP", [block("uid_n1", "scp notes")])],
  ]);
  renderAt("/page/AWS/SCP");
  expect(await screen.findByRole("heading", { name: "AWS/SCP" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/AWS/SCP", undefined);
});

it("shows an error state on 404", async () => {
  const fetchMock = stubFetch([]);
  renderAt("/page/Nope");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("releases a failed parent read when the page unmounts", async () => {
  stubFetch([]);
  const view = renderAt("/page/Failed%20read");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();

  view.unmount();

  expect(isOutlineSessionActive("Failed read")).toBe(false);
});

it("an expired same-title parent response cannot publish an empty child", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const fetchMock = vi.fn(() =>
    fetchMock.mock.calls.length === 1 ? older.promise : newer.promise);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title="Paper" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  let expiredPublished = false;
  let newerCopies = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expiredPublished = screen.queryByRole("heading", { name: "Paper" }) !== null;

    await act(async () => {
      newer.resolve(jsonResponse(pagePayload("Paper", [
        block("new", "newer response"),
      ])));
      await newer.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    newerCopies = screen.queryAllByText("newer response").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(expiredPublished).toBe(false);
  expect(newerCopies).toBe(2);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("a losing failed parent renders the accepted same-title winner without error", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const fetchMock = vi.fn(() =>
    fetchMock.mock.calls.length === 1 ? older.promise : newer.promise);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title="Paper" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  let copies = 0;
  let metadataCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.reject(new Error("expired transport failed"));
      await older.promise.catch(() => undefined);
      await Promise.resolve();
    });
    await act(async () => {
      newer.resolve(jsonResponse(pagePayload("Paper", [
        block("winner", "accepted winner"),
        block("winner-ref", "((winner_ref))"),
      ], {
        block_ref_texts: {
          winner_ref: { text: "shared payload metadata", page_title: "Source" },
        },
      })));
      await newer.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("accepted winner").length;
    metadataCopies = screen.queryAllByText("shared payload metadata").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("a failed newer parent elects one fresh controller for both panes", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const recovery = deferred<Response>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return newer.promise;
    return recovery.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title="Paper" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  let copies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      await Promise.resolve();
    });
    await act(async () => {
      newer.reject(new Error("newer controller failed"));
      await newer.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload("Paper", [
        block("recovered", "recovered once"),
      ])));
      await recovery.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("recovered once").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    recovery.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(copies).toBe(2);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("unmounting the newer parent elects one surviving controller", async () => {
  const older = deferred<Response>();
  const abandoned = deferred<Response>();
  const recovery = deferred<Response>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return abandoned.promise;
    return recovery.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  const tree = (showSidebar: boolean) => (
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        {showSidebar && <EditableSidebarPanel title="Paper" />}
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const view = render(tree(true));
  let copies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    view.rerender(tree(false));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload("Paper", [
        block("survivor", "surviving controller"),
      ])));
      await recovery.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("surviving controller").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    abandoned.resolve(jsonResponse(pagePayload("Paper", [])));
    recovery.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(copies).toBe(1);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("scrolls to and flashes the block named in the location hash (pkm-pzdu)", async () => {
  const scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [
      block("uid_t0", "some other block"),
      block("uid_t1", "target block"),
    ])],
  ]);
  const { container } = renderAt("/page/Paper#uid_t1");
  await screen.findByRole("heading", { name: "Paper" });
  const row = container.querySelector('[data-uid="uid_t1"]');
  expect(row).not.toBeNull();
  expect(scrollIntoView).toHaveBeenCalled();
  expect(scrollIntoView.mock.instances[0]).toBe(row);
  expect(row!.classList.contains("flash-target")).toBe(true);
});

it("a hash naming no block on the page is a no-op (pkm-pzdu)", async () => {
  const scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_t0", "only block")])],
  ]);
  renderAt("/page/Paper#uid_gone");
  await screen.findByRole("heading", { name: "Paper" });
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("a parent resync response dispatched before a local split cannot erase it", async () => {
  let resolveResync!: (response: Response) => void;
  const resync = new Promise<Response>((done) => { resolveResync = done; });
  let resolveFresh!: (response: Response) => void;
  const fresh = new Promise<Response>((done) => { resolveFresh = done; });
  let calls = 0;
  const initial = pagePayload("Paper", [block("u1", "first")]);
  const fetchMock = vi.fn(() => {
    calls += 1;
    if (calls === 1) return Promise.resolve(jsonResponse(initial));
    return calls === 2 ? resync : fresh;
  });
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  const view = (resyncSeq: number) => (
    <SyncContext.Provider value={{ ...sync, resyncSeq }}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const { rerender } = render(view(0));
  fireEvent.click(await screen.findByText("first"));
  const textarea = document.querySelector(".block-input") as HTMLTextAreaElement;
  textarea.setSelectionRange(5, 5);

  rerender(view(1));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(document.querySelector(".block-input")).toHaveValue("");
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const created = sync.sent.flat().find((op) => op.op === "create");
  if (!created || created.op !== "create") throw new Error("missing create op");

  await act(async () => {
    resolveResync(jsonResponse(initial));
    await resync;
    await Promise.resolve();
  });

  expect(document.querySelectorAll(".block-row")).toHaveLength(2);
  expect(document.querySelector(".block-input")).toHaveValue("");

  await act(async () => {
    resolveFresh(jsonResponse(pagePayload("Paper", [
      block("u1", "first", { order_idx: 0 }),
      block(created.uid, created.text, { order_idx: created.order_idx }),
    ])));
    await fresh;
    await Promise.resolve();
  });
  expect(document.querySelectorAll(".block-row")).toHaveLength(2);
  expect(document.querySelector(".block-input")).toHaveValue("");
});
