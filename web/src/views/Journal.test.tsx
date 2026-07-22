import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JournalDay } from "../api/payloads";
import {
  acquireOutlineSession,
  isOutlineSessionActive,
  repairActiveOutlineSessions,
} from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, stubFetch } from "../test-helpers";
import { Journal } from "./Journal";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});
afterEach(() => vi.unstubAllGlobals());

function day(date: string, title: string, blocks = [block(`uid_${date}`, `entry ${date}`)],
             exists = true): JournalDay {
  return { date, title, exists, blocks: exists ? blocks : [] };
}

function intersect() {
  const entries = [{ isIntersecting: true }] as unknown as IntersectionObserverEntry[];
  act(() => {
    for (const o of FakeIntersectionObserver.instances) {
      o.callback(entries, o as unknown as IntersectionObserver);
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("renders the first batch newest-first and loads older days on intersect", async () => {
  const fetchMock = stubFetch([
    // more-specific prefix FIRST (plain ?days=5 also prefixes the before-url)
    ["/api/journal?days=5&before=2026-07-04", { days: [
      day("2026-07-03", "July 3rd, 2026"),
      day("2026-07-02", "July 2nd, 2026", [], false),
    ] }],
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026"),
      day("2026-07-07", "July 7th, 2026", [], false),
      day("2026-07-06", "July 6th, 2026"),
      day("2026-07-05", "July 5th, 2026", [], false),
      day("2026-07-04", "July 4th, 2026"),
    ] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "July 8th, 2026" }))
    .toHaveAttribute("href", "/page/July%208th%2C%202026");
  expect(screen.getByText("entry 2026-07-06")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 5th, 2026" })).not.toBeInTheDocument();
  expect(screen.queryAllByRole("button", { name: /start writing/i })).toHaveLength(0);

  intersect();
  expect(await screen.findByRole("link", { name: "July 3rd, 2026" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 2nd, 2026" })).not.toBeInTheDocument();
  // oldest already-loaded date is passed as the exclusive `before`
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/journal?days=5&before=2026-07-04", undefined);
});

it("keeps today visible for composing even when its page does not exist yet", async () => {
  stubFetch([
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026", [], false),
      day("2026-07-07", "July 7th, 2026", [], false),
    ] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);

  expect(await screen.findByRole("link", { name: "July 8th, 2026" }))
    .toHaveAttribute("href", "/page/July%208th%2C%202026");
  expect(screen.getAllByRole("button", { name: /start writing/i })).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).not.toBeInTheDocument();
});

it("resolves ((block refs)) from every batch's block_ref_texts", async () => {
  stubFetch([
    ["/api/journal?days=5&before=2026-07-08", {
      days: [day("2026-07-07", "July 7th, 2026",
                 [block("u2", "older ((ref_bbbb))")])],
      block_ref_texts: { ref_bbbb: { text: "resolved beta", page_title: "B" } },
    }],
    ["/api/journal?days=5", {
      days: [day("2026-07-08", "July 8th, 2026",
                 [block("u1", "see ((ref_aaaa))")])],
      block_ref_texts: { ref_aaaa: { text: "resolved alpha", page_title: "A" } },
    }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);
  expect(await screen.findByText("resolved alpha")).toBeInTheDocument();

  intersect();
  expect(await screen.findByText("resolved beta")).toBeInTheDocument();
  // maps merge across batches: the first batch's refs still resolve
  expect(screen.getByText("resolved alpha")).toBeInTheDocument();
  expect(screen.queryByText(/\(\(ref_/)).not.toBeInTheDocument();
});

it("discards a stale in-flight load when a resync resets the journal", async () => {
  // First /api/journal fetch is gated (held in flight); every later journal
  // fetch resolves immediately with the fresh post-resync day. The cleanup
  // POST is answered separately so it can't consume a journal response.
  let releaseStale!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { releaseStale = res; });
  let journalCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    journalCalls += 1;
    return journalCalls === 1
      ? gated
      : Promise.resolve(jsonResponse({ days: [day("2026-07-08", "Fresh day")] }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const sync = makeSync();
  const inSync = (s: typeof sync) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>
    </SyncContext.Provider>
  );
  const { rerender } = render(inSync(sync));
  // resync arrives while the initial fetch is still in flight
  rerender(inSync({ ...sync, resyncSeq: 1 }));
  expect(await screen.findByRole("link", { name: "Fresh day" })).toBeInTheDocument();

  // the superseded response lands late: dropped, not rendered
  await act(async () => {
    releaseStale(jsonResponse({ days: [day("2026-07-07", "Stale day")] }));
  });
  expect(screen.queryByText("Stale day")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Fresh day" })).toBeInTheDocument();
  // exactly two journal loads: the gated original and the resync reload
  // (the mount also fires one /api/journal/cleanup POST, excluded here)
  const journalLoads = fetchMock.mock.calls.filter(
    ([url]) => String(url).startsWith("/api/journal?"));
  expect(journalLoads).toHaveLength(2);
});

it("keeps day sections mounted across a resync (no remount churn)", async () => {
  // pkm-ss9k: a resync bump must refresh content in place. Blanking the day
  // list first unmounts every .journal-day and remounts it after the refetch,
  // which detaches the DOM mid-interaction (Playwright "not stable" flake).
  let journalCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    journalCalls += 1;
    return Promise.resolve(jsonResponse({ days: [
      day("2026-07-08", "July 8th, 2026",
          [block("u1", journalCalls === 1 ? "before resync" : "after resync")]),
    ] }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const sync = makeSync();
  const inSync = (s: typeof sync) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>
    </SyncContext.Provider>
  );
  const { rerender } = render(inSync(sync));
  await screen.findByText("before resync");
  const section = document.querySelector(".journal-day");
  expect(section).not.toBeNull();

  rerender(inSync({ ...sync, resyncSeq: 1 }));
  // the authoritative refetch replaces the content...
  expect(await screen.findByText("after resync")).toBeInTheDocument();
  expect(screen.queryByText("before resync")).not.toBeInTheDocument();
  // ...inside the SAME section element: no unmount/remount cycle
  expect(document.querySelector(".journal-day")).toBe(section);
});

it("does not adopt a journal payload over an active session changed in flight", async () => {
  const title = "July 8th, 2026";
  const journal = deferred<Response>();
  const freshPage = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    return url.startsWith("/api/journal?") ? journal.promise : freshPage.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const active = acquireOutlineSession(title, [block("u1", "before")]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=5", undefined,
  ));

  active.applyOptimistic([block("u1", "local during request")]);
  await act(async () => {
    journal.resolve(jsonResponse({ days: [day(
      "2026-07-08", title, [block("u1", "stale journal")],
    )] }));
    await journal.promise;
  });

  expect(screen.getByText("local during request")).toBeInTheDocument();
  expect(screen.queryByText("stale journal")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/July%208th%2C%202026", undefined,
  ));
  freshPage.resolve(jsonResponse({
    page: { id: 1, title, created_at: 1, updated_at: 1 },
    blocks: [block("u1", "fresh page")], backlinks: {
      groups: [], total_pages: 0, offset: 0, limit: 20,
    }, block_ref_texts: {},
  }));
  await vi.waitFor(() => expect(screen.getByText("fresh page")).toBeInTheDocument());
  view.unmount();
  active.release();
});

it("does not adopt an old journal payload into a session created mid-flight", async () => {
  const title = "July 9th, 2026";
  const journal = deferred<Response>();
  const freshPage = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    return url.startsWith("/api/journal?") ? journal.promise : freshPage.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=5", undefined,
  ));
  const active = acquireOutlineSession(
    title, [block("u1", "opened during request")],
  );

  await act(async () => {
    journal.resolve(jsonResponse({ days: [day(
      "2026-07-09", title, [block("u1", "stale journal")],
    )] }));
    await journal.promise;
  });

  expect(screen.getByText("opened during request")).toBeInTheDocument();
  expect(screen.queryByText("stale journal")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/July%209th%2C%202026", undefined,
  ));
  freshPage.resolve(jsonResponse({
    page: { id: 1, title, created_at: 1, updated_at: 1 },
    blocks: [block("u1", "fresh page")], backlinks: {
      groups: [], total_pages: 0, offset: 0, limit: 20,
    }, block_ref_texts: {},
  }));
  await vi.waitFor(() => expect(screen.getByText("fresh page")).toBeInTheDocument());
  view.unmount();
  active.release();
});

it("does not create a session from a response received after unmount", async () => {
  const title = "Late Journal Leak";
  const journal = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=5", undefined,
  ));

  view.unmount();
  await act(async () => {
    journal.resolve(jsonResponse({
      days: [day("2026-07-09", title, [block("late", "late journal")])],
      block_ref_texts: {},
    }));
    await journal.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(isOutlineSessionActive(title)).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("releases captured session reservations when unmounted in flight", async () => {
  const title = "Journal Unmount Reservation";
  const journal = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const active = acquireOutlineSession(title, [block("active", "active")]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=5", undefined,
  ));

  view.unmount();
  active.release();

  expect(isOutlineSessionActive(title)).toBe(false);
  journal.resolve(jsonResponse({ days: [], block_ref_texts: {} }));
  await journal.promise;
});

it("stops auto-loading when a batch comes back short (journal exhausted)", async () => {
  // pkm-03x6: the API returns only non-empty days; fewer than requested
  // means there is nothing older, so the journal stops asking entirely.
  const fetchMock = stubFetch([
    ["/api/journal?days=5&before=2026-07-04", { days: [
      day("2026-06-20", "June 20th, 2026"),
    ] }],
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026"),
      day("2026-07-07", "July 7th, 2026"),
      day("2026-07-06", "July 6th, 2026"),
      day("2026-07-05", "July 5th, 2026"),
      day("2026-07-04", "July 4th, 2026"),
    ] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);
  await screen.findByRole("link", { name: "July 8th, 2026" });
  intersect();
  expect(await screen.findByRole("link", { name: "June 20th, 2026" }))
    .toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=5&before=2026-07-04", undefined));
  // exhausted: no sentinel to keep polling, and no manual button either
  await waitFor(() =>
    expect(document.querySelector(".journal-sentinel")).toBeNull());
  expect(screen.queryByRole("button", { name: /load older days/i }))
    .not.toBeInTheDocument();
});

it("a resync reloads the whole scrolled window, not just the head batch " +
   "(pkm-wstt)", async () => {
  const head = [
    day("2026-07-22", "July 22nd, 2026"),
    day("2026-07-14", "July 14th, 2026"),
    day("2026-07-09", "July 9th, 2026"),
    day("2026-07-07", "July 7th, 2026"),
    day("2026-07-04", "July 4th, 2026"),
  ];
  const older = [
    day("2026-07-02", "July 2nd, 2026"),
    day("2026-06-30", "June 30th, 2026"),
    day("2026-06-29", "June 29th, 2026"),
    day("2026-06-22", "June 22nd, 2026"),
    day("2026-06-20", "June 20th, 2026"),
  ];
  const fetchMock = stubFetch([
    ["/api/journal?days=10", { days: [...head, ...older] }],
    ["/api/journal?days=5&before=2026-07-04", { days: older }],
    ["/api/journal?days=5", { days: head }],
  ]);
  const sync = makeSync();
  const inSync = (s: typeof sync) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>
    </SyncContext.Provider>
  );
  const { rerender } = render(inSync(sync));
  await screen.findByRole("link", { name: "July 22nd, 2026" });
  intersect();
  await screen.findByRole("link", { name: "June 20th, 2026" });

  rerender(inSync({ ...sync, resyncSeq: 1 }));
  // ten days were on screen, so the reload asks for all ten in one batch
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/journal?days=10", undefined));
  expect(await screen.findByRole("link", { name: "June 20th, 2026" }))
    .toBeInTheDocument();
  expect(screen.getByRole("link", { name: "July 22nd, 2026" }))
    .toBeInTheDocument();
});

it("treats a 404 on an active session's authoritative refetch as an empty day, " +
   "not a failed load (pkm-fy52: day deleted underneath us)", async () => {
  const title = "July 8th, 2026";
  const journal = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) return journal.promise;
    if (url.startsWith("/api/page/")) {
      return Promise.resolve(jsonResponse({ detail: "not found" }, 404));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  let active: ReturnType<typeof acquireOutlineSession> | null = null;
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/journal?days=5", undefined,
    ));
    // Opened mid-flight (after the journal fetch dispatched, before it
    // resolved): the response processes this title via the "active at
    // response" branch, which re-fetches the day's own page rather than
    // trusting the journal payload.
    active = acquireOutlineSession(title, [block("u1", "existing content")]);
    await act(async () => {
      journal.resolve(jsonResponse({
        days: [day("2026-07-08", title, [block("u1", "journal-sent content")])],
        block_ref_texts: {},
      }));
      await journal.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    // The journal's own payload for this title must never be trusted once
    // a session was already active — and the resulting authoritative
    // refetch 404s (the page was deleted underneath us), which must
    // resolve to an empty day, not surface an error or keep stale content.
    expect(screen.queryByText("journal-sent content")).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.queryByText("existing content"),
    ).not.toBeInTheDocument());
    expect(document.querySelectorAll(".error")).toHaveLength(0);
  } finally {
    journal.resolve(jsonResponse({ days: [], block_ref_texts: {} }));
    view.unmount();
    active?.release();
  }
});

it("a repair-triggered day reload treats a 404 as an empty day (pkm-fy52)", async () => {
  const title = "July 8th, 2026";
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/journal/cleanup") {
      return Promise.resolve(jsonResponse({ deleted: [] }));
    }
    if (url.startsWith("/api/journal?")) {
      return Promise.resolve(jsonResponse({
        days: [day("2026-07-08", title)], block_ref_texts: {},
      }));
    }
    if (url.startsWith("/api/page/")) {
      return Promise.resolve(jsonResponse({ detail: "not found" }, 404));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>,
  );
  try {
    expect(await screen.findByText("entry 2026-07-08")).toBeInTheDocument();

    // A repair epoch forces every active session through its stored
    // authoritative loader (no explicit override) — the other 404 call site.
    await act(async () => { await repairActiveOutlineSessions(); });

    expect(screen.queryByText("entry 2026-07-08")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".error")).toHaveLength(0);
  } finally {
    view.unmount();
  }
});

it("fires the empty-daily cleanup once on mount", async () => {
  const fetchMock = stubFetch([
    ["/api/journal/cleanup", { deleted: [] }],
    ["/api/journal?days=5", { days: [day("2026-07-08", "July 8th, 2026")] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);
  await screen.findByRole("link", { name: "July 8th, 2026" });

  const cleanups = fetchMock.mock.calls.filter(
    ([url]) => String(url) === "/api/journal/cleanup");
  expect(cleanups).toEqual([["/api/journal/cleanup", { method: "POST" }]]);
});
