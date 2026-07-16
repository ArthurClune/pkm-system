import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { defer, jsonResponse, stubFetch } from "../test-helpers";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { QueryBlock } from "./QueryBlock";

afterEach(() => vi.unstubAllGlobals());

const EXPR = "{and: [[Generative Models]] [[Link]]}";
const ENC = encodeURIComponent(EXPR);
const EXPR_A = "{and: [[Alpha]]}";
const ENC_A = encodeURIComponent(EXPR_A);
const EXPR_B = "{and: [[Beta]]}";
const ENC_B = encodeURIComponent(EXPR_B);

function renderExpr(expr: string) {
  return render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={expr} /></MemoryRouter>);
}

it("evaluates on mount, groups by page, shows the total, paginates", async () => {
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}&limit=20&offset=1`, {
      groups: [{ page_id: 7, page_title: "July 1st, 2026", items: [
        { uid: "uid_q2", text: "second [[Link]]" }] }],
      total: 2,
    }],
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 6, page_title: "Generative Models", items: [
        { uid: "uid_q1", text: "a [[Link]] here" }] }],
      total: 2,
    }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR} /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByText("2 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/query?expr=${ENC}&limit=20&offset=0`, undefined);
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "July 1st, 2026" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("InlineSegments renders query segments as live QueryBlocks", async () => {
  stubFetch([[`/api/query?expr=${ENC}`, { groups: [], total: 0 }]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <InlineSegments segments={tokenizeBlock(`{{[[query]]: ${EXPR}}}`)} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("0 results")).toBeInTheDocument();
  expect(screen.getByText(`query: ${EXPR}`)).toBeInTheDocument();
});

it("caps nested query recursion with an inert placeholder and no extra fetch", async () => {
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 9, page_title: "Self", items: [
        { uid: "uid_r1", text: `see {{query: ${EXPR}}}` }] }],
      total: 1,
    }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR} depth={1} /></MemoryRouter>);
  expect(await screen.findByText("1 result")).toBeInTheDocument();
  // The nested query inside the result item sits at the cap: inert, no fetch.
  expect(screen.getByText(`{{query: ${EXPR}}}`)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("clears a stale error once a show-more retry succeeds", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
    }
    return new Response(JSON.stringify({
      groups: [{ page_id: 1, page_title: "P", items: [
        { uid: `uid_e${calls}`, text: `item ${calls}` }] }],
      total: 3,
    }), { status: 200 });
  }));
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/500/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByText("item 3")).toBeInTheDocument();
  expect(screen.queryByText(/500/)).toBeNull();
});

it("shows the server's 400 as an error state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "bad query" }), { status: 400 })));
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr="{nonsense" /></MemoryRouter>);
  expect(await screen.findByText(/400/)).toBeInTheDocument();
});

// --- out-of-order / concurrency (pkm-stn6) ---

it("keeps only the current expr's results when a superseded expr resolves late", async () => {
  const a = defer<Response>();
  const b = defer<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/query?expr=${ENC_A}`)) return a.promise;
    if (url.startsWith(`/api/query?expr=${ENC_B}`)) return b.promise;
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { rerender } = renderExpr(EXPR_A);
  rerender(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR_B} /></MemoryRouter>);

  // The obsolete expr's own fetch is still in flight when the current one settles first.
  b.resolve(jsonResponse({
    groups: [{ page_id: 2, page_title: "Beta page", items: [{ uid: "b1", text: "b" }] }], total: 1,
  }));
  expect(await screen.findByText("Beta page")).toBeInTheDocument();

  // The obsolete expr's response arrives late; it must not overwrite the current state.
  await act(async () => {
    a.resolve(jsonResponse({
      groups: [{ page_id: 1, page_title: "Alpha page", items: [{ uid: "a1", text: "a" }] }], total: 1,
    }));
    await Promise.resolve();
  });
  expect(screen.queryByText("Alpha page")).toBeNull();
  expect(screen.getByText("Beta page")).toBeInTheDocument();
});

it("drops an obsolete pagination response after a rerender changes the expr", async () => {
  const pageA = defer<Response>();
  const initialB = defer<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/query?expr=${ENC_A}&limit=20&offset=0`) {
      return Promise.resolve(jsonResponse({
        groups: [{ page_id: 1, page_title: "Alpha page", items: [{ uid: "a1", text: "a" }] }], total: 2,
      }));
    }
    if (url === `/api/query?expr=${ENC_A}&limit=20&offset=1`) return pageA.promise;
    if (url.startsWith(`/api/query?expr=${ENC_B}`)) return initialB.promise;
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { rerender } = renderExpr(EXPR_A);
  await screen.findByText("Alpha page");
  fireEvent.click(screen.getByRole("button", { name: /show more/i })); // A's page-2 request now pending

  rerender(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR_B} /></MemoryRouter>);
  initialB.resolve(jsonResponse({
    groups: [{ page_id: 5, page_title: "Beta page", items: [{ uid: "b1", text: "b" }] }], total: 1,
  }));
  expect(await screen.findByText("Beta page")).toBeInTheDocument();

  // A's stale page-2 response arrives after the rerender to B; it must not merge into B's groups.
  await act(async () => {
    pageA.resolve(jsonResponse({
      groups: [{ page_id: 1, page_title: "Alpha page", items: [{ uid: "a2", text: "a2" }] }], total: 2,
    }));
    await Promise.resolve();
  });
  expect(screen.queryByText("a2")).toBeNull();
  expect(screen.getByText("Beta page")).toBeInTheDocument();
});

it("ignores a stale generation's rejection while the current generation is still pending", async () => {
  const a = defer<Response>();
  const b = defer<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/query?expr=${ENC_A}`)) return a.promise;
    if (url.startsWith(`/api/query?expr=${ENC_B}`)) return b.promise;
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { rerender } = renderExpr(EXPR_A);
  rerender(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><QueryBlock expr={EXPR_B} /></MemoryRouter>);

  // The obsolete expr's request fails while the current expr's own request is still pending.
  await act(async () => {
    a.reject(new Error("stale network failure"));
    await Promise.resolve().then(() => Promise.resolve());
  });
  expect(screen.queryByText(/stale network failure/)).toBeNull();

  b.resolve(jsonResponse({ groups: [{ page_id: 9, page_title: "Beta page", items: [] }], total: 0 }));
  expect(await screen.findByText("Beta page")).toBeInTheDocument();
  expect(screen.queryByText(/stale network failure/)).toBeNull();
});

it("ignores a second show-more click while a page request is already in flight", async () => {
  const page = defer<Response>();
  let pageCalls = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/query?expr=${ENC_A}&limit=20&offset=0`) {
      return Promise.resolve(jsonResponse({
        groups: [{ page_id: 1, page_title: "P", items: [{ uid: "x1", text: "x" }] }], total: 3,
      }));
    }
    if (url === `/api/query?expr=${ENC_A}&limit=20&offset=1`) {
      pageCalls += 1;
      return page.promise;
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  renderExpr(EXPR_A);
  const button = await screen.findByRole("button", { name: /show more/i });
  // Both clicks are dispatched before React can commit a disabling rerender,
  // so this exercises the component's own guard rather than the DOM's.
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(pageCalls).toBe(1);

  page.resolve(jsonResponse({
    groups: [{ page_id: 1, page_title: "P", items: [{ uid: "x2", text: "y" }] }], total: 3,
  }));
  expect(await screen.findByText("y")).toBeInTheDocument();
  expect(pageCalls).toBe(1);
});
