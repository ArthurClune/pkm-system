import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, test, vi } from "vitest";
import {
  isOutlineEditorActive,
  isOutlineSessionActive,
} from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { sha256Hex } from "../replica/sha256";
import { READ_INIT, block, jsonResponse, makeSync, pagePayload, reserveOutlineEditor, stubFetch } from "../test-helpers";
import { EditableSidebarPanel } from "./EditableSidebarPanel";
import { EditablePage } from "../views/EditablePage";
import { PageView } from "../views/PageView";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(sync = makeSync(), title = "Paper",
               blocks = [block("uid_s1", "a paper block", { order_idx: 0 })]) {
  stubFetch([["/api/page/Paper", pagePayload(title, blocks)]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditableSidebarPanel title={title} />
      </SyncContext.Provider>
    </MemoryRouter>);
  return sync;
}

test("fetches its page and renders it as an editable outline", async () => {
  mount();
  expect(await screen.findByText("a paper block")).toBeInTheDocument();
});

test("a title change cannot mount the previous payload under the new title", async () => {
  const next = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/page/Alpha") {
      return Promise.resolve(jsonResponse(pagePayload("Alpha", [
        block("alpha", "alpha tree"),
      ])));
    }
    if (url === "/api/page/Beta") return next.promise;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  const tree = (title: string) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditableSidebarPanel title={title} />
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const view = render(tree("Alpha"));
  expect(await screen.findByText("alpha tree")).toBeInTheDocument();
  expect(isOutlineEditorActive("Alpha")).toBe(true);

  view.rerender(tree("Beta"));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Beta", READ_INIT,
  ));
  expect(screen.queryByText("alpha tree")).not.toBeInTheDocument();
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(isOutlineEditorActive("Beta")).toBe(false);
  expect(isOutlineSessionActive("Alpha")).toBe(false);

  await act(async () => {
    next.resolve(jsonResponse(pagePayload("Beta", [
      block("beta", "beta tree"),
    ])));
    await next.promise;
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("beta tree")).toBeInTheDocument();
  expect(isOutlineEditorActive("Beta")).toBe(true);

  view.unmount();
  expect(isOutlineSessionActive("Beta")).toBe(false);
});

test("editing a block in the panel sends the op after the debounce", async () => {
  vi.useFakeTimers();
  const sync = mount();
  await vi.waitFor(() => screen.getByText("a paper block"));
  fireEvent.click(screen.getByText("a paper block"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "edited in panel" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "uid_s1", text: "edited in panel",
      base_text_hash: sha256Hex("a paper block") }],
  ]);
});

test("a remote websocket batch updates the panel", async () => {
  const sync = mount();
  await screen.findByText("a paper block");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "create", uid: "r1", page_title: "Paper", parent_uid: null,
      order_idx: 1, text: "from the iPad" },
  ] }));
  expect(screen.getByText("from the iPad")).toBeInTheDocument();
});

test("a page already open elsewhere in this tab falls back to read-only", async () => {
  const release = reserveOutlineEditor("Paper");
  try {
    mount();
    fireEvent.click(await screen.findByText("a paper block"));
    expect(screen.queryByRole("textbox")).toBeNull();
  } finally {
    release();
  }
});

test("main-first same-title mounts keep one editor and one live fallback", async () => {
  const blocks = [block("uid_s1", "a paper block", { order_idx: 0 })];
  stubFetch([["/api/page/Paper", pagePayload("Paper", blocks)]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditablePage title="Paper" initial={blocks} />
        <EditableSidebarPanel title="Paper" />
      </SyncContext.Provider>
    </MemoryRouter>);

  await vi.waitFor(() => {
    expect(screen.getAllByText("a paper block")).toHaveLength(2);
  });
  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);
});

test("sidebar-first same-title mounts preserve its editor when main joins", async () => {
  const blocks = [block("uid_s1", "a paper block", { order_idx: 0 })];
  stubFetch([["/api/page/Paper", pagePayload("Paper", blocks)]]);
  const sync = makeSync();
  const view = (showMain: boolean) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditableSidebarPanel title="Paper" />
        {showMain && <EditablePage title="Paper" initial={blocks} />}
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(view(false));
  await screen.findByText("a paper block");

  rerender(view(true));

  expect(screen.getAllByText("a paper block")).toHaveLength(2);
  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);
});

test("an expired sidebar parent cannot publish an empty same-title child", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const fetchMock = vi.fn(() =>
    fetchMock.mock.calls.length === 1 ? older.promise : newer.promise);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Paper"]}>
        <EditableSidebarPanel title="Paper" />
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
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
    expiredPublished = screen.queryByRole("button", {
      name: "Click to start writing…",
    }) !== null;

    await act(async () => {
      newer.resolve(jsonResponse(pagePayload("Paper", [
        block("new", "newer main response"),
      ])));
      await newer.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    newerCopies = screen.queryAllByText("newer main response").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(expiredPublished).toBe(false);
  expect(newerCopies).toBe(2);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

// pkm-63s1: a daily page nobody has written to yet 404s (the server
// auto-creates only today's). That is an empty page, not an error, in every
// surface that displays it — the same fixture in the main pane and in a
// sidebar panel must both render an editable empty outline.
const MISSING_DAILY = "June 3rd, 2026";

const missingDailyTree = (surface: "main" | "sidebar") => (
  <SyncContext.Provider value={makeSync()}>
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                  initialEntries={["/page/June%203rd%2C%202026"]}>
      {surface === "main"
        ? <Routes><Route path="/page/*" element={<PageView />} /></Routes>
        : <EditableSidebarPanel title={MISSING_DAILY} />}
    </MemoryRouter>
  </SyncContext.Provider>
);

for (const surface of ["main", "sidebar"] as const) {
  test(`a missing daily page is an editable empty outline in the ${surface} pane`,
       async () => {
    stubFetch([]);
    const view = render(missingDailyTree(surface));
    try {
      expect(await screen.findByRole("button", {
        name: "Click to start writing…",
      })).toBeInTheDocument();
      expect(document.querySelectorAll(".error")).toHaveLength(0);
    } finally {
      view.unmount();
    }
    expect(isOutlineSessionActive(MISSING_DAILY)).toBe(false);
  });
}

test("shows the fetch error", async () => {
  stubFetch([]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Missing" />
      </SyncContext.Provider>
    </MemoryRouter>);
  expect(await screen.findByText(/request failed: 404/i)).toBeInTheDocument();
});

test("a uid prop scrolls to and flashes that block within the panel's own container (pkm-gdi5)", async () => {
  const scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  stubFetch([["/api/page/Paper", pagePayload("Paper", [
    block("uid_s0", "some other block"),
    block("uid_s1", "target block"),
  ])]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Paper" uid="uid_s1" />
      </SyncContext.Provider>
    </MemoryRouter>);
  await screen.findByText("target block");
  const row = container.querySelector('[data-uid="uid_s1"]');
  expect(row).not.toBeNull();
  expect(scrollIntoView).toHaveBeenCalled();
  expect(scrollIntoView.mock.instances[0]).toBe(row);
  expect(row!.classList.contains("flash-target")).toBe(true);
});

test("no uid prop: no scroll/flash side effect", async () => {
  const scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "target block")])]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Paper" />
      </SyncContext.Provider>
    </MemoryRouter>);
  await screen.findByText("target block");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

// pkm-0one: a ((uid)) typed into a sidebar block must resolve live, the
// same as it does in the main pane -- not only after the panel is reopened.
test("a ((uid)) ref missing from the seed map resolves live in the panel", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [
      block("uid_s1", "see ((ref_zz9))", { order_idx: 0 }),
    ])],
    ["/api/block-refs", {
      block_ref_texts: { ref_zz9: { text: "the target block", page_title: "Paper" } },
    }],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Paper" />
      </SyncContext.Provider>
    </MemoryRouter>);

  await screen.findByText("((ref_zz9))");
  await waitFor(() => {
    expect(screen.getByText("the target block")).toBeInTheDocument();
  });
  expect(screen.queryByText("((ref_zz9))")).not.toBeInTheDocument();
});

test("releases a failed parent read when the panel unmounts", async () => {
  stubFetch([]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Failed sidebar read" />
      </SyncContext.Provider>
    </MemoryRouter>);
  expect(await screen.findByText(/request failed: 404/i)).toBeInTheDocument();

  view.unmount();

  expect(isOutlineSessionActive("Failed sidebar read")).toBe(false);
});
