import { act, render, screen } from "@testing-library/react";
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

it("renders more than seventy results from one request without show more", async () => {
  const items = Array.from({ length: 71 }, (_, i) => ({
    uid: `uid_q${i}`,
    text: `result ${i}`,
  }));
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 6, page_title: "Generative Models", items }],
      total: items.length,
    }],
  ]);

  renderExpr(EXPR);

  expect(await screen.findByText("result 70")).toBeInTheDocument();
  expect(screen.getByText("71 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(`/api/query?expr=${ENC}`, undefined);
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

it("clears the current error when a changed expression succeeds", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/query?expr=${ENC_A}`)) {
      return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
    }
    if (url.startsWith(`/api/query?expr=${ENC_B}`)) {
      return Promise.resolve(jsonResponse({
        groups: [{
          page_id: 2,
          page_title: "Beta page",
          items: [{ uid: "b1", text: "recovered" }],
        }],
        total: 1,
      }));
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { rerender } = renderExpr(EXPR_A);
  expect(await screen.findByText(/500/)).toBeInTheDocument();

  rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <QueryBlock expr={EXPR_B} />
    </MemoryRouter>,
  );

  expect(await screen.findByText("recovered")).toBeInTheDocument();
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
