import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import type { Backlinks } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import type { DeliveryOutcome, WriteOutcome, WriteTicket } from "../sync/opQueue";
import { SyncContext } from "../sync/SyncProvider";
import { jsonResponse, makeSync, pagePayload, stubFetch } from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";
import { mergeGroups } from "./groups";
import { UnlinkedSection } from "./UnlinkedSection";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function unlinkedPayload() {
  return {
    groups: [{ page_id: 2, page_title: "Source", items: [
      { uid: "uid_u1", text: "Acme created it" },
      { uid: "uid_u2", text: "Acme reviewed it" },
    ] }],
    total: 2,
  };
}

const initial: Backlinks = {
  groups: [{
    page_id: 3,
    page_title: "July 7th, 2026",
    items: [{ uid: "uid_b4", text: "Studying [[Machine Learning]] today",
              breadcrumbs: ["Morning", "Reading"] }],
  }],
  total_pages: 2,
  offset: 0,
  limit: 20,
};

it("mergeGroups merges batches by page_id and dedupes items", () => {
  const merged = mergeGroups(
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }] }],
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
     { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] }],
  );
  expect(merged).toEqual([
    { page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
    { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] },
  ]);
});

it("renders backlink groups with breadcrumbs and loads more on demand", async () => {
  const more = pagePayload("Machine Learning", [], {
    backlinks: {
      groups: [{ page_id: 9, page_title: "AI", items: [
        { uid: "uid_b9", text: "more [[Machine Learning]]", breadcrumbs: [] }] }],
      total_pages: 2, offset: 1, limit: 20,
    },
  });
  const fetchMock = stubFetch([["/api/page/Machine%20Learning?bl_offset=1", more]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Machine Learning" initial={initial} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/linked references \(2\)/i)).toBeInTheDocument();
  expect(screen.getByText("Morning › Reading")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "July 7th, 2026" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "AI" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Machine%20Learning?bl_offset=1&bl_limit=20", undefined);
  // 2 groups loaded of total_pages 2 -> button gone
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("backlinks show-more merges batches from the same source page", async () => {
  const groupA = {
    page_id: 9, page_title: "Src",
    items: [{ uid: "s1", text: "one", breadcrumbs: [] }],
  };
  const groupAmore = {
    page_id: 9, page_title: "Src",
    items: [{ uid: "s2", text: "two", breadcrumbs: [] }],
  };
  const backlinksInitial: Backlinks =
    { groups: [groupA], total_pages: 2, offset: 0, limit: 1 };
  stubFetch([
    ["/api/page/T?bl_offset=1", pagePayload("T", [],
      { backlinks: { groups: [groupAmore], total_pages: 2, offset: 1, limit: 1 } })],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="T" initial={backlinksInitial} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("two")).toBeInTheDocument();
  // one group heading, not two duplicate-keyed groups
  expect(screen.getAllByText("Src")).toHaveLength(1);
});

it("shows an error and re-enables the button when show-more fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Machine Learning" initial={initial} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/500/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /show more/i })).not.toBeDisabled();
});

it("refresh generation replaces the first backlink batch", async () => {
  const refreshed = pagePayload("ACME", [], {
    backlinks: {
      groups: [{ page_id: 8, page_title: "Fresh Source", items: [
        { uid: "fresh", text: "[[ACME]] now linked", breadcrumbs: [] },
      ] }],
      total_pages: 1, offset: 0, limit: 20,
    },
  });
  stubFetch([["/api/page/ACME?bl_offset=0&bl_limit=20", refreshed]]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("link", { name: "Fresh Source" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).toBeNull();
});

it("refresh with an open filter panel refetches from offset 0 at limit 100 until complete", async () => {
  const fetchMock = stubFetch([
    ["/api/page/Claude?bl_offset=1&bl_limit=100", pagePayload("Claude", [], {
      backlinks: {
        groups: [{ page_id: 12, page_title: "Fresh B", items: [
          { uid: "fresh-b", text: "beta [[Claude]] #Idea", breadcrumbs: [] },
        ] }],
        total_pages: 2, offset: 1, limit: 100,
      },
    })],
    ["/api/page/Claude?bl_offset=0&bl_limit=100", pagePayload("Claude", [], {
      backlinks: {
        groups: [{ page_id: 11, page_title: "Fresh A", items: [
          { uid: "fresh-a", text: "alpha [[Claude]] #Paper", breadcrumbs: [] },
        ] }],
        total_pages: 2, offset: 0, limit: 100,
      },
    })],
  ]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude"
        initial={{ ...filterInitial, groups: filterInitial.groups.slice(0, 1), total_pages: 1 }}
        refreshGeneration={0} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude"
        initial={{ ...filterInitial, groups: filterInitial.groups.slice(0, 1), total_pages: 1 }}
        refreshGeneration={1} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("link", { name: "Fresh A" })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Fresh B" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Claude?bl_offset=0&bl_limit=100", undefined);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Claude?bl_offset=1&bl_limit=100", undefined);
  expect(screen.queryByRole("link", { name: "Daily A" })).toBeNull();
});

it("refresh preserves filter selections and panel state while replacing groups", async () => {
  const refreshed = pagePayload("Claude", [], {
    backlinks: {
      groups: [
        { page_id: 11, page_title: "Fresh Visible", items: [
          { uid: "fresh-visible", text: "clean [[Claude]] #Idea", breadcrumbs: [] },
        ] },
        { page_id: 12, page_title: "Fresh Hidden", items: [
          { uid: "fresh-hidden", text: "blocked [[Claude]] #Paper #Idea", breadcrumbs: [] },
        ] },
      ],
      total_pages: 2, offset: 0, limit: 100,
    },
  });
  stubFetch([["/api/page/Claude?bl_offset=0&bl_limit=100", refreshed]]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={filterInitial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  fireEvent.click(screen.getByRole("button", { name: "Paper (2)" }), { shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Idea (1)" }));
  expect(screen.getByText(/linked references \(1 of 2\)/i)).toBeInTheDocument();
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={filterInitial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("link", { name: "Fresh Visible" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /filter \(2\)/i }))
    .toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Idea" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Paper" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Fresh Hidden" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Daily A" })).toBeNull();
});

it("failed refresh keeps old groups and offers retry refresh", async () => {
  let refreshCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/page/ACME?bl_offset=0&bl_limit=20") {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return new Response(JSON.stringify({ detail: "refresh boom" }), { status: 500 });
      }
      return jsonResponse(pagePayload("ACME", [], {
        backlinks: {
          groups: [{ page_id: 10, page_title: "Recovered Source", items: [
            { uid: "recovered", text: "[[ACME]] linked", breadcrumbs: [] },
          ] }],
          total_pages: 1, offset: 0, limit: 20,
        },
      }));
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  }));
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/request failed: 500/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "July 7th, 2026" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry refresh/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /retry refresh/i }));
  expect(await screen.findByRole("link", { name: "Recovered Source" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).toBeNull();
});

it("ignores an older refresh response that resolves after a newer generation", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== "/api/page/ACME?bl_offset=0&bl_limit=20") {
      return Promise.resolve(new Response(JSON.stringify({ detail: "not found" }), { status: 404 }));
    }
    calls += 1;
    return calls === 1 ? older.promise : newer.promise;
  }));
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={2} />
    </MemoryRouter>,
  );
  await act(async () => {
    newer.resolve(jsonResponse(pagePayload("ACME", [], {
      backlinks: {
        groups: [{ page_id: 11, page_title: "Newest Source", items: [
          { uid: "newest", text: "[[ACME]] newest", breadcrumbs: [] },
        ] }],
        total_pages: 1, offset: 0, limit: 20,
      },
    })));
    await newer.promise;
    await Promise.resolve();
  });
  expect(await screen.findByRole("link", { name: "Newest Source" })).toBeInTheDocument();
  await act(async () => {
    older.resolve(jsonResponse(pagePayload("ACME", [], {
      backlinks: {
        groups: [{ page_id: 12, page_title: "Stale Source", items: [
          { uid: "stale", text: "[[ACME]] stale", breadcrumbs: [] },
        ] }],
        total_pages: 1, offset: 0, limit: 20,
      },
    })));
    await older.promise;
    await Promise.resolve();
  });
  expect(screen.getByRole("link", { name: "Newest Source" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Stale Source" })).toBeNull();
});

it("ignores a stale show-more response that resolves after a refresh generation", async () => {
  const staleMore = deferred<Response>();
  const refresh = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/page/ACME?bl_offset=1&bl_limit=20") return staleMore.promise;
    if (url === "/api/page/ACME?bl_offset=0&bl_limit=20") return refresh.promise;
    return Promise.resolve(new Response(JSON.stringify({ detail: "not found" }), { status: 404 }));
  }));
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  await act(async () => {
    refresh.resolve(jsonResponse(pagePayload("ACME", [], {
      backlinks: {
        groups: [{ page_id: 10, page_title: "Fresh Source", items: [
          { uid: "fresh", text: "[[ACME]] refreshed", breadcrumbs: [] },
        ] }],
        total_pages: 1, offset: 0, limit: 20,
      },
    })));
    await refresh.promise;
    await Promise.resolve();
  });
  expect(await screen.findByRole("link", { name: "Fresh Source" })).toBeInTheDocument();
  await act(async () => {
    staleMore.resolve(jsonResponse(pagePayload("ACME", [], {
      backlinks: {
        groups: [{ page_id: 11, page_title: "Stale Page", items: [
          { uid: "stale-more", text: "[[ACME]] stale page", breadcrumbs: [] },
        ] }],
        total_pages: 2, offset: 1, limit: 20,
      },
    })));
    await staleMore.promise;
    await Promise.resolve();
  });
  expect(screen.getByRole("link", { name: "Fresh Source" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Stale Page" })).toBeNull();
});

it("ignores a stale filter-panel load-all response that resolves after a refresh generation", async () => {
  const staleLoadAll = deferred<Response>();
  const refresh = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/page/Claude?bl_offset=1&bl_limit=100") return staleLoadAll.promise;
    if (url === "/api/page/Claude?bl_offset=0&bl_limit=100") return refresh.promise;
    return Promise.resolve(new Response(JSON.stringify({ detail: "not found" }), { status: 404 }));
  }));
  const partial = {
    ...filterInitial,
    groups: filterInitial.groups.slice(0, 1),
  };
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={partial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={partial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  await act(async () => {
    refresh.resolve(jsonResponse(pagePayload("Claude", [], {
      backlinks: {
        groups: [{ page_id: 10, page_title: "Fresh Visible", items: [
          { uid: "fresh-visible", text: "clean [[Claude]] #Idea", breadcrumbs: [] },
        ] }],
        total_pages: 1, offset: 0, limit: 100,
      },
    })));
    await refresh.promise;
    await Promise.resolve();
  });
  expect(await screen.findByRole("link", { name: "Fresh Visible" })).toBeInTheDocument();
  await act(async () => {
    staleLoadAll.resolve(jsonResponse(pagePayload("Claude", [], {
      backlinks: {
        groups: [{ page_id: 2, page_title: "Daily B", items: [
          { uid: "stale-load-all", text: "gamma [[Claude]]", breadcrumbs: ["reading #Paper"] },
        ] }],
        total_pages: 2, offset: 1, limit: 100,
      },
    })));
    await staleLoadAll.promise;
    await Promise.resolve();
  });
  expect(screen.getByRole("link", { name: "Fresh Visible" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Daily B" })).toBeNull();
});

it("changing filter-panel state does not issue a second refresh for the same generation", async () => {
  const refresh = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/page/ACME?bl_offset=0&bl_limit=20") return refresh.promise;
    return Promise.resolve(new Response(JSON.stringify({ detail: "not found" }), { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const singlePage = { ...initial, total_pages: 1 };
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={singlePage} refreshGeneration={0} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={singlePage} refreshGeneration={1} />
    </MemoryRouter>,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    refresh.resolve(jsonResponse(pagePayload("ACME", [], {
      backlinks: {
        groups: singlePage.groups,
        total_pages: 1,
        offset: 0,
        limit: 20,
      },
    })));
    await refresh.promise;
    await Promise.resolve();
  });
});

it("unlinked references fetch lazily on first open and paginate", async () => {
  const fetchMock = stubFetch([
    ["/api/unlinked?title=Machine%20Learning&limit=20&offset=1", {
      groups: [{ page_id: 5, page_title: "AGI", items: [
        { uid: "uid_u2", text: "machine learning épilogue" }] }],
      total: 2,
    }],
    ["/api/unlinked?title=Machine%20Learning", {
      groups: [{ page_id: 2, page_title: "AI", items: [
        { uid: "uid_u1", text: "AI overview mentions Machine Learning in plain text" }] }],
      total: 2,
    }],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <UnlinkedSection title="Machine Learning" />
    </MemoryRouter>,
  );
  expect(fetchMock).not.toHaveBeenCalled(); // collapsed = no fetch
  fireEvent.click(screen.getByText(/unlinked references/i));
  expect(await screen.findByText(/mentions Machine Learning/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/épilogue/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("queues a canonical update with the snapshot hash and source scope", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click((await screen.findAllByRole("button", { name: "Link" }))[0]);
  await vi.waitFor(() => expect(sync.sent).toHaveLength(1));
  expect(sync.sent[0]).toEqual([{
    op: "update_text",
    uid: "uid_u1",
    text: "[[ACME]] created it",
    base_text_hash: sha256Hex("Acme created it"),
  }]);
  expect(sync.tickets[0].scope).toEqual(["page", "Source"]);
});

it("renders one Link button per result and disables only the pending result", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  const sync = makeSync();
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  sync.enqueue = vi.fn((ops, scope) => {
    sync.sent.push(ops);
    const ticket = {
      id: "controlled-write-1",
      scope: scope ?? [],
      settled: settled.promise,
      delivered: delivered.promise,
    } satisfies WriteTicket;
    sync.tickets.push(ticket);
    return ticket;
  });
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click((await screen.findAllByRole("button", { name: "Link" }))[0]);
  expect(await screen.findByRole("button", { name: "Linking…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Link" })).toBeEnabled();
});

it("disables Link with the read-only reason as its tooltip", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  const sync = makeSync("reconnecting", {
    canEdit: false,
    readOnlyReason: "Replica unavailable",
  });
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  const buttons = await screen.findAllByRole("button", { name: "Link" });
  expect(buttons).toHaveLength(2);
  buttons.forEach((button) => {
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Replica unavailable");
  });
});

it("hides a durably persisted item and notifies only after delivery", async () => {
  stubFetch([["/api/unlinked?title=ACME", {
    groups: [{ page_id: 2, page_title: "Source", items: [
      { uid: "uid_u1", text: "Acme created it" },
    ] }],
    total: 1,
  }]]);
  const sync = makeSync();
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  const onLinked = vi.fn();
  sync.enqueue = vi.fn((ops, scope) => {
    sync.sent.push(ops);
    const ticket = {
      id: "controlled-write-1",
      scope: scope ?? [],
      settled: settled.promise,
      delivered: delivered.promise,
    } satisfies WriteTicket;
    sync.tickets.push(ticket);
    return ticket;
  });
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" onLinked={onLinked} />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  await act(async () => {
    settled.resolve({ status: "persisted", pending: 1 });
    await settled.promise;
  });
  await vi.waitFor(() => {
    expect(screen.queryByText("Acme created it")).toBeNull();
    expect(screen.queryByRole("link", { name: "Source" })).toBeNull();
  });
  expect(onLinked).not.toHaveBeenCalled();
  await act(async () => {
    delivered.resolve({ status: "delivered" });
    await delivered.promise;
  });
  await vi.waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
});

it("retains the item when local persistence fails", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  const sync = makeSync();
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  sync.enqueue = vi.fn((ops, scope) => {
    sync.sent.push(ops);
    const ticket = {
      id: "controlled-write-1",
      scope: scope ?? [],
      settled: settled.promise,
      delivered: delivered.promise,
    } satisfies WriteTicket;
    sync.tickets.push(ticket);
    return ticket;
  });
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click((await screen.findAllByRole("button", { name: "Link" }))[0]);
  await act(async () => {
    settled.resolve({ status: "failed", error: new Error("disk full") });
    await settled.promise;
  });
  expect(screen.getByText("Acme created it")).toBeInTheDocument();
  expect(await screen.findByText("Error: disk full")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Link" })[0]).toBeEnabled();
});

it("restores the item and permits retry after delivery fails", async () => {
  stubFetch([["/api/unlinked?title=ACME", {
    groups: [{ page_id: 2, page_title: "Source", items: [
      { uid: "uid_u1", text: "Acme created it" },
    ] }],
    total: 1,
  }]]);
  const sync = makeSync();
  const firstSettled = deferred<WriteOutcome>();
  const firstDelivered = deferred<DeliveryOutcome>();
  const secondSettled = deferred<WriteOutcome>();
  const secondDelivered = deferred<DeliveryOutcome>();
  const pairs = [
    { settled: firstSettled, delivered: firstDelivered, id: "controlled-write-1" },
    { settled: secondSettled, delivered: secondDelivered, id: "controlled-write-2" },
  ];
  let next = 0;
  sync.enqueue = vi.fn((ops, scope) => {
    sync.sent.push(ops);
    const pair = pairs[next++]!;
    const ticket = {
      id: pair.id,
      scope: scope ?? [],
      settled: pair.settled.promise,
      delivered: pair.delivered.promise,
    } satisfies WriteTicket;
    sync.tickets.push(ticket);
    return ticket;
  });
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  await act(async () => {
    firstSettled.resolve({ status: "persisted", pending: 1 });
    await firstSettled.promise;
  });
  await vi.waitFor(() => expect(screen.queryByText("Acme created it")).toBeNull());
  await act(async () => {
    firstDelivered.resolve({ status: "failed", error: new Error("server down") });
    await firstDelivered.promise;
  });
  expect(await screen.findByText("Acme created it")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Source" })).toBeInTheDocument();
  expect(await screen.findByText("Error: server down")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  expect(sync.enqueue).toHaveBeenCalledTimes(2);
});

it("reports no-safe-match without enqueueing", async () => {
  stubFetch([["/api/unlinked?title=ACME", {
    groups: [{ page_id: 2, page_title: "Source", items: [
      { uid: "uid_u1", text: "`ACME`" },
    ] }],
    total: 1,
  }]]);
  const sync = makeSync();
  const enqueue = vi.fn(sync.enqueue);
  sync.enqueue = enqueue;
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  expect(await screen.findByText("No linkable occurrence found.")).toBeInTheDocument();
  expect(enqueue).not.toHaveBeenCalled();
});

it("shows an error and re-enables the button when unlinked show-more fails", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        groups: [{ page_id: 2, page_title: "AI", items: [
          { uid: "uid_u1", text: "AI overview mentions Machine Learning" }] }],
        total: 2,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
  }));
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <UnlinkedSection title="Machine Learning" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/500/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /show more/i })).not.toBeDisabled();
});

it("show-more buttons carry the shared secondary-button style (pkm-9kye)", () => {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Machine Learning" initial={initial} />
    </MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: /show more/i }))
    .toHaveClass("btn-secondary");
});

const filterInitial: Backlinks = {
  groups: [
    { page_id: 1, page_title: "Daily A", items: [
      { uid: "f1", text: "alpha [[Claude]] #Paper", breadcrumbs: [] },
      { uid: "f2", text: "beta [[Claude]] #Idea", breadcrumbs: [] }] },
    { page_id: 2, page_title: "Daily B", items: [
      { uid: "f3", text: "gamma [[Claude]]", breadcrumbs: ["reading #Paper"] }] },
  ],
  total_pages: 2, offset: 0, limit: 20,
};

it("filter panel: include, exclude via shift-click, clear (pkm-m4an)", () => {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={filterInitial} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  // chips over all items; own title "Claude" absent; breadcrumb #Paper counted
  expect(screen.getByRole("button", { name: "Paper (2)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Idea (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Claude/ })).toBeNull();

  // include Idea -> only beta remains, Daily B group gone, header N of M
  fireEvent.click(screen.getByRole("button", { name: "Idea (1)" }));
  expect(screen.getByText(/linked references \(1 of 2\)/i)).toBeInTheDocument();
  expect(screen.getByText(/beta/)).toBeInTheDocument();
  expect(screen.queryByText(/alpha/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Daily B" })).toBeNull();

  // clear -> everything back
  fireEvent.click(screen.getByRole("button", { name: /clear/i }));
  expect(screen.getByText(/linked references \(2\)/i)).toBeInTheDocument();
  expect(screen.getByText(/alpha/)).toBeInTheDocument();

  // exclude Paper (shift-click) -> f1 (own text) and f3 (ancestor) hidden
  fireEvent.click(screen.getByRole("button", { name: "Paper (2)" }), { shiftKey: true });
  expect(screen.getByText(/beta/)).toBeInTheDocument();
  expect(screen.queryByText(/alpha/)).toBeNull();
  expect(screen.queryByText(/gamma/)).toBeNull();

  // exclude Idea too -> nothing matches
  fireEvent.click(screen.getByRole("button", { name: "Idea (1)" }), { shiftKey: true });
  expect(screen.getByText(/no matching references/i)).toBeInTheDocument();
});

it("opening the filter panel loads all remaining backlinks first (pkm-m4an)", async () => {
  const rest = pagePayload("Claude", [], {
    backlinks: {
      groups: [{ page_id: 5, page_title: "Daily C", items: [
        { uid: "f9", text: "delta [[Claude]] #Paper", breadcrumbs: [] }] }],
      total_pages: 2, offset: 1, limit: 100,
    },
  });
  const fetchMock = stubFetch([["/api/page/Claude?bl_offset=1&bl_limit=100", rest]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude"
        initial={{ ...filterInitial, groups: filterInitial.groups.slice(0, 1) }} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  // chips appear only once the remaining page is fetched (bl_limit=100)
  expect(await screen.findByRole("button", { name: "Paper (2)" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Claude?bl_offset=1&bl_limit=100", undefined);
  // show-more is hidden while the panel is open, even though it was eligible
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("filter panel reaches loaded state when the backlink total shrinks server-side (pkm-m4an)", async () => {
  const shrinkInitial: Backlinks = {
    groups: [{ page_id: 1, page_title: "Daily A", items: [
      { uid: "f1", text: "alpha", breadcrumbs: [] }] }],
    // stale total_pages=3 frozen at mount; server now only has 1 page.
    total_pages: 3, offset: 0, limit: 20,
  };
  const shrunk = pagePayload("Claude", [], {
    backlinks: { groups: [], total_pages: 1, offset: 1, limit: 100 },
  });
  stubFetch([["/api/page/Claude?bl_offset=1&bl_limit=100", shrunk]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={shrinkInitial} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  // must settle into a loaded state -- not hang forever on the loading message
  expect(await screen.findByText(/no references to filter on/i)).toBeInTheDocument();
  expect(screen.queryByText(/loading all references/i)).toBeNull();
  expect(screen.queryByText(/error/i)).toBeNull();
  // stale M in the header is also corrected once the real total is known
  expect(screen.getByText(/linked references \(1\)/i)).toBeInTheDocument();
});
