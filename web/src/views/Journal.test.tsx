import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JournalDay } from "../api/payloads";
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
  render(<MemoryRouter><Journal /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "July 8th, 2026" }))
    .toHaveAttribute("href", "/page/July%208th%2C%202026");
  expect(screen.getByText("entry 2026-07-06")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /start writing/i }).length).toBe(2);

  intersect();
  expect(await screen.findByRole("link", { name: "July 3rd, 2026" })).toBeInTheDocument();
  // oldest already-loaded date is passed as the exclusive `before`
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/journal?days=5&before=2026-07-04", undefined);
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
  render(<MemoryRouter><Journal /></MemoryRouter>);
  expect(await screen.findByText("resolved alpha")).toBeInTheDocument();

  intersect();
  expect(await screen.findByText("resolved beta")).toBeInTheDocument();
  // maps merge across batches: the first batch's refs still resolve
  expect(screen.getByText("resolved alpha")).toBeInTheDocument();
  expect(screen.queryByText(/\(\(ref_/)).not.toBeInTheDocument();
});

it("discards a stale in-flight load when a resync resets the journal", async () => {
  // First /api/journal fetch is gated (held in flight); every later fetch
  // resolves immediately with the fresh post-resync day.
  let releaseStale!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { releaseStale = res; });
  const fetchMock = vi.fn()
    .mockReturnValueOnce(gated)
    .mockResolvedValue(jsonResponse({ days: [day("2026-07-08", "Fresh day")] }));
  vi.stubGlobal("fetch", fetchMock);

  const sync = makeSync();
  const inSync = (s: typeof sync) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter><Journal /></MemoryRouter>
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
  // exactly two loads: the gated original and the resync reload
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("stops auto-loading after 3 consecutive empty batches", async () => {
  const empty = (from: string, dates: string[]) =>
    [`/api/journal?days=5&before=${from}`,
     { days: dates.map((d) => day(d, d, [], false)) }] as [string, unknown];
  stubFetch([
    empty("2026-07-04", ["2026-07-03", "2026-07-02", "2026-07-01", "2026-06-30", "2026-06-29"]),
    empty("2026-06-29", ["2026-06-28", "2026-06-27", "2026-06-26", "2026-06-25", "2026-06-24"]),
    empty("2026-06-24", ["2026-06-23", "2026-06-22", "2026-06-21", "2026-06-20", "2026-06-19"]),
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026"),
      day("2026-07-07", "July 7th, 2026", [], false),
      day("2026-07-06", "July 6th, 2026", [], false),
      day("2026-07-05", "July 5th, 2026", [], false),
      day("2026-07-04", "July 4th, 2026", [], false),
    ] }],
  ]);
  render(<MemoryRouter><Journal /></MemoryRouter>);
  await screen.findByRole("link", { name: "July 8th, 2026" });
  intersect();
  await screen.findByText("2026-07-03");
  intersect();
  await screen.findByText("2026-06-28");
  intersect();
  await screen.findByText("2026-06-23");
  // three all-empty batches in a row -> sentinel replaced by a manual button
  expect(await screen.findByRole("button", { name: /load older days/i }))
    .toBeInTheDocument();
});
