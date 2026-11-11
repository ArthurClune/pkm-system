import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { Backlinks } from "../api/payloads";
import {
  canonicalTitleOf, defer, jsonResponse, pageIdOf, pagePayload, uidOf,
} from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";

afterEach(() => vi.unstubAllGlobals());

const T = canonicalTitleOf("T");
const group = (n: number) => ({
  page_id: pageIdOf(n), page_title: canonicalTitleOf(`P${n}`),
  items: [{ uid: uidOf(`tuid-${n}`), text: `t${n}`, breadcrumbs: [] }],
});
const initial: Backlinks = {
  groups: [group(1)], total_pages: 4, offset: 0, limit: 1,
};
const batch = (ns: number[], total = 4) =>
  jsonResponse(pagePayload(T, [], {
    backlinks: { groups: ns.map(group), total_pages: total, offset: 0,
                 limit: 1 },
  }));
const failure = () =>
  new Response(JSON.stringify({ detail: "boom" }), { status: 500 });

function section(refreshGeneration = 0) {
  return (
    <MemoryRouter>
      <BacklinksSection title={T} initial={initial}
                        refreshGeneration={refreshGeneration} />
    </MemoryRouter>
  );
}

it("Show more stays disabled until both an in-flight loadMore and loadAll " +
   "settle", async () => {
  const more = defer<Response>();
  const all = defer<Response>();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/page/T?bl_offset=1&bl_limit=1") return more.promise;
    if (url === "/api/page/T?bl_offset=1&bl_limit=100") return all.promise;
    return Promise.resolve(failure());
  }));
  render(section());

  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

  await act(async () => { more.resolve(batch([2])); await more.promise; });
  expect(await screen.findByRole("link", { name: "P2" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

  await act(async () => { all.resolve(failure()); await all.promise; });
  expect(await screen.findByRole("button", { name: "Show more" }))
    .not.toBeDisabled();
});

it("a Show more click in the same tick as Retry refresh fetches nothing",
   async () => {
  const retry = defer<Response>();
  let refreshes = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== "/api/page/T?bl_offset=0&bl_limit=1") {
      return Promise.resolve(batch([2]));
    }
    refreshes += 1;
    return refreshes === 1 ? Promise.resolve(failure()) : retry.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(section(0));
  view.rerender(section(1));
  const retryButton =
    await screen.findByRole("button", { name: /retry refresh/i });
  const showMore = screen.getByRole("button", { name: "Show more" });
  expect(showMore).not.toBeDisabled();

  act(() => {
    retryButton.click();
    showMore.click();
  });

  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/page/T?bl_offset=0&bl_limit=1",
    "/api/page/T?bl_offset=0&bl_limit=1",
  ]);
  await act(async () => { retry.resolve(batch([3])); await retry.promise; });
  expect(await screen.findByRole("link", { name: "P3" })).toBeInTheDocument();
});
