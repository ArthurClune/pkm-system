import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireOutlineSession,
  isOutlineSessionActive,
  repairActiveOutlineSessions,
} from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, pagePayload, stubFetch } from "../test-helpers";
import { EditableSidebarPanel } from "../components/EditableSidebarPanel";
import { Journal } from "./Journal";
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

class NoopIntersectionObserver {
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(_callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
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

it("links with the canonical payload title and refreshes backlinks", async () => {
  const sync = makeSync();
  const refreshed = pagePayload("ACME", [], { backlinks: {
    groups: [{ page_id: 9, page_title: "Source", items: [{
      uid: "uid_unlinked", text: "[[ACME]] mention", breadcrumbs: [],
    }] }],
    total_pages: 1, offset: 0, limit: 20,
  } });
  const fetchMock = stubFetch([
    ["/api/page/ACME?bl_offset=0&bl_limit=20", refreshed],
    ["/api/unlinked?title=ACME", {
      groups: [{ page_id: 9, page_title: "Source", items: [
        { uid: "uid_unlinked", text: "Acme mention" },
      ] }],
      total: 1,
    }],
    ["/api/page/acme", pagePayload("ACME", [])],
  ]);

  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/acme"]}>
        <Routes><Route path="/page/*" element={<PageView />} /></Routes>
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  expect(await screen.findByRole("heading", { name: "ACME" })).toBeInTheDocument();
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  await vi.waitFor(() => expect(sync.sent).toHaveLength(1));
  expect(sync.sent[0][0]).toMatchObject({
    op: "update_text", uid: "uid_unlinked", text: "[[ACME]] mention",
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/ACME?bl_offset=0&bl_limit=20", undefined,
  ));
  expect(await screen.findByRole("link", { name: "Source" })).toBeInTheDocument();
});

it("shows an error state on 404", async () => {
  const fetchMock = stubFetch([]);
  renderAt("/page/Nope");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("renders an empty editable page for a missing daily title (pkm-fy52)", async () => {
  stubFetch([]);
  renderAt("/page/July%201st%2C%202026");
  expect(await screen.findByRole("heading", { name: "July 1st, 2026" }))
    .toBeInTheDocument();
  expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  expect(document.querySelector(".page")).not.toBeNull();
});

it("still shows the error for a missing normal page (pkm-fy52)", async () => {
  stubFetch([]);
  renderAt("/page/No%20Such%20Page");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
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

it("unmounting the newer parent recovers while the older transport still hangs", async () => {
  const older = deferred<Response>();
  const abandoned = deferred<Response>();
  const recovery = deferred<Response>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return abandoned.promise;
    if (call === 3) return recovery.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
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
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    view.rerender(tree(false));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload("Paper", [
        block("survivor", "hung-parent recovery"),
        block("survivor-ref", "((hung_ref))"),
      ], {
        block_ref_texts: {
          hung_ref: { text: "hung-parent metadata", page_title: "Source" },
        },
      })));
      await recovery.promise;
      older.resolve(jsonResponse(pagePayload("Paper", [
        block("stale-older", "late hung response"),
      ])));
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("hung-parent recovery").length;
    metadataCopies = screen.queryAllByText("hung-parent metadata").length;
    staleCopies = screen.queryAllByText("late hung response").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    abandoned.resolve(jsonResponse(pagePayload("Paper", [])));
    recovery.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(copies).toBe(1);
  expect(metadataCopies).toBe(1);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("an automatic read superseding elected recovery permits one replacement parent", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const elected = deferred<Response>();
  const replacement = deferred<Response>();
  const automatic = deferred<ReturnType<typeof block>[]>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return newer.promise;
    if (call === 3) return elected.promise;
    if (call === 4) return replacement.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
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
  const automaticHandle = acquireOutlineSession("Paper", null);
  let copies = 0;
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      newer.reject(new Error("newest initial parent failed"));
      await newer.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const automaticRead = automaticHandle.requestAuthoritative(
      () => automatic.promise,
    );
    await act(async () => {
      automatic.resolve([block("automatic", "block-only automatic")]);
      await automaticRead;
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    await act(async () => {
      replacement.resolve(jsonResponse(pagePayload("Paper", [
        block("replacement", "post-automatic winner"),
        block("replacement-ref", "((replacement_ref))"),
      ], {
        block_ref_texts: {
          replacement_ref: {
            text: "post-automatic metadata",
            page_title: "Source",
          },
        },
      })));
      await replacement.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      elected.resolve(jsonResponse(pagePayload("Paper", [
        block("stale-elected", "stale elected response"),
      ])));
      await elected.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("post-automatic winner").length;
    metadataCopies = screen.queryAllByText("post-automatic metadata").length;
    staleCopies = screen.queryAllByText("stale elected response").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    elected.resolve(jsonResponse(pagePayload("Paper", [])));
    replacement.resolve(jsonResponse(pagePayload("Paper", [])));
    automatic.resolve([]);
    automaticHandle.release();
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("a hung automatic read cannot strand eager full-parent readiness", async () => {
  const title = "Hung Automatic Paper";
  const older = deferred<Response>();
  const current = deferred<Response>();
  const recovery = deferred<Response>();
  const automatic = deferred<ReturnType<typeof block>[]>();
  let parentCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== "/api/page/Hung%20Automatic%20Paper") {
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    }
    parentCalls += 1;
    if (parentCalls === 1) return older.promise;
    if (parentCalls === 2) return current.promise;
    if (parentCalls === 3) return recovery.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Hung%20Automatic%20Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title={title} />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  const automaticHandle = acquireOutlineSession(title, null);
  let copies = 0;
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(parentCalls).toBe(2));
    const automaticRead = automaticHandle.requestAuthoritative(
      () => automatic.promise,
    );
    await vi.waitFor(() => expect(parentCalls).toBe(3));

    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload(title, [
        block("recovery", "hung-automatic recovery"),
        block("recovery-ref", "((automatic_ref))"),
      ], {
        block_ref_texts: {
          automatic_ref: {
            text: "hung-automatic metadata",
            page_title: "Source",
          },
        },
      })));
      await recovery.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      automatic.resolve([block("stale-automatic", "late automatic blocks")]);
      await automaticRead;
      older.resolve(jsonResponse(pagePayload(title, [
        block("late-older", "late automatic older parent"),
      ])));
      current.resolve(jsonResponse(pagePayload(title, [
        block("late-current", "late automatic current parent"),
      ])));
      await older.promise;
      await current.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("hung-automatic recovery").length;
    metadataCopies = screen.queryAllByText("hung-automatic metadata").length;
    staleCopies = screen.queryAllByText(
      /late automatic blocks|late automatic older|late automatic current/,
    ).length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload(title, [])));
    current.resolve(jsonResponse(pagePayload(title, [])));
    recovery.resolve(jsonResponse(pagePayload(title, [])));
    automatic.resolve([]);
    automaticHandle.release();
    view.unmount();
  }

  expect(parentCalls).toBe(3);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("a repair superseding elected recovery permits one post-repair parent", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const elected = deferred<Response>();
  const repair = deferred<Response>();
  const replacement = deferred<Response>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return newer.promise;
    if (call === 3) return elected.promise;
    if (call === 4) return repair.promise;
    if (call === 5) return replacement.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
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
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      newer.reject(new Error("newest initial parent failed"));
      await newer.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const repairing = repairActiveOutlineSessions();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => {
      repair.resolve(jsonResponse(pagePayload("Paper", [
        block("repair", "block-only repair"),
      ])));
      await repairing;
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    await act(async () => {
      replacement.resolve(jsonResponse(pagePayload("Paper", [
        block("replacement", "post-repair winner"),
        block("replacement-ref", "((repair_ref))"),
      ], {
        block_ref_texts: {
          repair_ref: {
            text: "post-repair metadata",
            page_title: "Source",
          },
        },
      })));
      await replacement.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await act(async () => {
      elected.resolve(jsonResponse(pagePayload("Paper", [
        block("stale-elected", "stale elected response"),
      ])));
      await elected.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("post-repair winner").length;
    metadataCopies = screen.queryAllByText("post-repair metadata").length;
    staleCopies = screen.queryAllByText("stale elected response").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    elected.resolve(jsonResponse(pagePayload("Paper", [])));
    repair.resolve(jsonResponse(pagePayload("Paper", [])));
    replacement.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("canceling elected recovery does not start a second recovery", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const elected = deferred<Response>();
  const fetchMock = vi.fn(() => {
    const call = fetchMock.mock.calls.length;
    if (call === 1) return older.promise;
    if (call === 2) return newer.promise;
    if (call === 3) return elected.promise;
    return Promise.reject(new Error("unexpected second recovery"));
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
  let cancellationErrors = 0;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload("Paper", [])));
      await older.promise;
      newer.reject(new Error("newest initial parent failed"));
      await newer.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    view.rerender(tree(false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    cancellationErrors = screen.queryAllByText(
      /Parent read cancelled for Paper/,
    ).length;

    await act(async () => {
      elected.resolve(jsonResponse(pagePayload("Paper", [
        block("stale-elected", "stale elected response"),
      ])));
      await elected.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
  } finally {
    older.resolve(jsonResponse(pagePayload("Paper", [])));
    newer.resolve(jsonResponse(pagePayload("Paper", [])));
    elected.resolve(jsonResponse(pagePayload("Paper", [])));
    view.unmount();
  }

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(cancellationErrors).toBe(1);
  expect(isOutlineSessionActive("Paper")).toBe(false);
});

it("a captured Journal response superseding recovery elects one full parent", async () => {
  const title = "Captured Paper";
  const older = deferred<Response>();
  const newer = deferred<Response>();
  const elected = deferred<Response>();
  const journal = deferred<Response>();
  const replacement = deferred<Response>();
  let parentCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    if (url !== "/api/page/Captured%20Paper") {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    parentCalls += 1;
    if (parentCalls === 1) return older.promise;
    if (parentCalls === 2) return newer.promise;
    if (parentCalls === 3) return elected.promise;
    if (parentCalls === 4) return replacement.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  const sync = makeSync();
  const tree = (showJournal: boolean) => (
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Captured%20Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title={title} />
        {showJournal && <Journal />}
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const view = render(tree(false));
  let copies = 0;
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(parentCalls).toBe(2));
    await act(async () => {
      older.resolve(jsonResponse(pagePayload(title, [])));
      await older.promise;
      newer.reject(new Error("newest initial parent failed"));
      await newer.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(parentCalls).toBe(3));

    view.rerender(tree(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/journal?days=5", undefined,
    ));
    await act(async () => {
      journal.resolve(jsonResponse({
        days: [{
          date: "2026-07-08",
          title,
          exists: true,
          blocks: [block("journal", "captured block-only response")],
        }],
        block_ref_texts: {},
      }));
      await journal.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(parentCalls).toBe(4));

    await act(async () => {
      replacement.resolve(jsonResponse(pagePayload(title, [
        block("replacement", "post-capture winner"),
        block("replacement-ref", "((capture_ref))"),
      ], {
        block_ref_texts: {
          capture_ref: {
            text: "post-capture metadata",
            page_title: "Source",
          },
        },
      })));
      await replacement.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(parentCalls).toBe(4);

    await act(async () => {
      elected.resolve(jsonResponse(pagePayload(title, [
        block("stale-elected", "stale elected response"),
      ])));
      await elected.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(parentCalls).toBe(4);
    view.rerender(tree(false));
    expect(parentCalls).toBe(4);
    copies = screen.queryAllByText("post-capture winner").length;
    metadataCopies = screen.queryAllByText("post-capture metadata").length;
    staleCopies = screen.queryAllByText("stale elected response").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload(title, [])));
    newer.resolve(jsonResponse(pagePayload(title, [])));
    elected.resolve(jsonResponse(pagePayload(title, [])));
    journal.resolve(jsonResponse({ days: [], block_ref_texts: {} }));
    replacement.resolve(jsonResponse(pagePayload(title, [])));
    view.unmount();
  }

  expect(parentCalls).toBe(4);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("a dormant Journal capture cannot strand parent recovery", async () => {
  const title = "Dormant Capture Paper";
  const older = deferred<Response>();
  const current = deferred<Response>();
  const recovery = deferred<Response>();
  const journal = deferred<Response>();
  let parentCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    if (url !== "/api/page/Dormant%20Capture%20Paper") {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    parentCalls += 1;
    if (parentCalls === 1) return older.promise;
    if (parentCalls === 2) return current.promise;
    if (parentCalls === 3) return recovery.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  const sync = makeSync();
  const tree = (showJournal: boolean) => (
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Dormant%20Capture%20Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title={title} />
        {showJournal && <Journal />}
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const view = render(tree(false));
  let copiesBeforeJournal = 0;
  let copiesAfterJournal = 0;
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(parentCalls).toBe(2));
    view.rerender(tree(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/journal?days=5", undefined,
    ));

    await act(async () => {
      current.reject(new Error(
        "current parent failed during dormant capture",
      ));
      await current.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(parentCalls).toBe(3));

    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload(title, [
        block("recovery", "dormant-capture recovery"),
        block("recovery-ref", "((dormant_ref))"),
      ], {
        block_ref_texts: {
          dormant_ref: {
            text: "dormant-capture metadata",
            page_title: "Source",
          },
        },
      })));
      await recovery.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copiesBeforeJournal = screen.queryAllByText(
      "dormant-capture recovery",
    ).length;

    await act(async () => {
      journal.resolve(jsonResponse({
        days: [{
          date: "2026-07-09",
          title,
          exists: true,
          blocks: [block("late-journal", "late dormant capture")],
        }],
        block_ref_texts: {},
      }));
      await journal.promise;
      older.resolve(jsonResponse(pagePayload(title, [
        block("late-older", "late older parent"),
      ])));
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(parentCalls).toBe(3);
    view.rerender(tree(false));
    copiesAfterJournal = screen.queryAllByText(
      "dormant-capture recovery",
    ).length;
    metadataCopies = screen.queryAllByText("dormant-capture metadata").length;
    staleCopies = screen.queryAllByText(
      /late dormant capture|late older parent/,
    ).length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload(title, [])));
    current.resolve(jsonResponse(pagePayload(title, [])));
    recovery.resolve(jsonResponse(pagePayload(title, [])));
    journal.resolve(jsonResponse({ days: [], block_ref_texts: {} }));
    view.unmount();
  }

  expect(parentCalls).toBe(3);
  expect(copiesBeforeJournal).toBe(2);
  expect(copiesAfterJournal).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("unmounting Journal releases a hung capture before parent recovery", async () => {
  const title = "Unmount Capture Paper";
  const lateTitle = "Late Journal Inactive";
  const older = deferred<Response>();
  const current = deferred<Response>();
  const recovery = deferred<Response>();
  const journal = deferred<Response>();
  let parentCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    if (url !== "/api/page/Unmount%20Capture%20Paper") {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    parentCalls += 1;
    if (parentCalls === 1) return older.promise;
    if (parentCalls === 2) return current.promise;
    if (parentCalls === 3) return recovery.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  const sync = makeSync();
  const tree = (showJournal: boolean) => (
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Unmount%20Capture%20Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        <EditableSidebarPanel title={title} />
        {showJournal && <Journal />}
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const view = render(tree(false));
  let copies = 0;
  let metadataCopies = 0;
  let staleCopies = 0;
  let errors = 0;
  try {
    await vi.waitFor(() => expect(parentCalls).toBe(2));
    view.rerender(tree(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/journal?days=5", undefined,
    ));

    view.rerender(tree(false));
    await act(async () => {
      current.reject(new Error("current parent failed after Journal unmount"));
      await current.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(parentCalls).toBe(3));

    await act(async () => {
      recovery.resolve(jsonResponse(pagePayload(title, [
        block("recovery", "post-unmount recovery"),
        block("recovery-ref", "((unmount_ref))"),
      ], {
        block_ref_texts: {
          unmount_ref: {
            text: "post-unmount metadata",
            page_title: "Source",
          },
        },
      })));
      await recovery.promise;
      journal.resolve(jsonResponse({
        days: [{
          date: "2026-07-09",
          title: lateTitle,
          exists: true,
          blocks: [block("late-journal", "late unmounted journal")],
        }],
        block_ref_texts: {},
      }));
      await journal.promise;
      older.resolve(jsonResponse(pagePayload(title, [
        block("late-older", "late unmount older"),
      ])));
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("post-unmount recovery").length;
    metadataCopies = screen.queryAllByText("post-unmount metadata").length;
    staleCopies = screen.queryAllByText(
      /late unmounted journal|late unmount older/,
    ).length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    older.resolve(jsonResponse(pagePayload(title, [])));
    current.resolve(jsonResponse(pagePayload(title, [])));
    recovery.resolve(jsonResponse(pagePayload(title, [])));
    journal.resolve(jsonResponse({ days: [], block_ref_texts: {} }));
    view.unmount();
  }

  expect(parentCalls).toBe(3);
  expect(copies).toBe(2);
  expect(metadataCopies).toBe(2);
  expect(staleCopies).toBe(0);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive(lateTitle)).toBe(false);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("a superseded resync failure cannot replace a newer parent winner with error", async () => {
  const title = "Resync Paper";
  const resync = deferred<Response>();
  const winner = deferred<Response>();
  const initial = pagePayload(title, [block("initial", "initial page")]);
  let pageCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== "/api/page/Resync%20Paper") {
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    }
    pageCalls += 1;
    const call = pageCalls;
    if (call === 1) return Promise.resolve(jsonResponse(initial));
    if (call === 2) return resync.promise;
    if (call === 3) return winner.promise;
    return Promise.reject(new Error("unexpected parent fetch storm"));
  });
  vi.stubGlobal("fetch", fetchMock);
  const sync = makeSync();
  const tree = (resyncSeq: number, showSidebar: boolean) => (
    <SyncContext.Provider value={{ ...sync, resyncSeq }}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                    initialEntries={["/page/Resync%20Paper"]}>
        <Routes>
          <Route path="/page/*" element={<PageView />} />
        </Routes>
        {showSidebar && <EditableSidebarPanel title={title} />}
      </MemoryRouter>
    </SyncContext.Provider>
  );
  const view = render(tree(0, false));
  let copies = 0;
  let errors = 0;
  try {
    expect(await screen.findByText("initial page")).toBeInTheDocument();
    view.rerender(tree(1, false));
    await vi.waitFor(() => expect(pageCalls).toBe(2));
    view.rerender(tree(1, true));
    await vi.waitFor(() => expect(pageCalls).toBe(3));

    await act(async () => {
      winner.resolve(jsonResponse(pagePayload(title, [
        block("winner", "newer parent winner"),
      ])));
      await winner.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      screen.queryAllByText("newer parent winner"),
    ).toHaveLength(2));

    await act(async () => {
      resync.reject(new Error("late stale resync failed"));
      await resync.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    copies = screen.queryAllByText("newer parent winner").length;
    errors = document.querySelectorAll(".error").length;
  } finally {
    resync.resolve(jsonResponse(initial));
    winner.resolve(jsonResponse(pagePayload(title, [])));
    view.unmount();
  }

  expect(pageCalls).toBe(3);
  expect(copies).toBe(2);
  expect(errors).toBe(0);
  expect(isOutlineSessionActive(title)).toBe(false);
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
