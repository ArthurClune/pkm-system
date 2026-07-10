import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse, stubFetch } from "../test-helpers";
import { SearchModal } from "./SearchModal";

afterEach(() => vi.unstubAllGlobals());

const results = {
  pages: [{ id: 4, title: "Paper" }],
  blocks: [{ uid: "uid_b3", page_title: "Machine Learning",
             snippet: "a <mark>paper</mark> about attention" }],
};

function renderModal(onClose = vi.fn()) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SearchModal open={true} onClose={onClose} />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

it("debounces input, lists pages before block snippets with real <mark>s", async () => {
  const fetchMock = stubFetch([["/api/search?q=paper", results]]);
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pap" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pape" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "paper" } });
  const items = await screen.findAllByRole("listitem");
  expect(fetchMock).toHaveBeenCalledTimes(1); // only the settled query fired
  expect(items[0].textContent).toContain("Paper");           // page hit first
  expect(items[1].textContent).toContain("Machine Learning"); // then block hit
  const mark = items[1].querySelector("mark");
  expect(mark).not.toBeNull();
  expect(mark!.textContent).toBe("paper");
});

it("Enter navigates to the selected hit and closes", async () => {
  stubFetch([["/api/search?q=paper", results]]);
  const onClose = renderModal();
  const input = screen.getByPlaceholderText("Search…");
  fireEvent.change(input, { target: { value: "paper" } });
  await screen.findAllByRole("listitem");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

it("drops a stale response that resolves after a newer query's", async () => {
  // Controllable promises: each fetch call is resolved manually by the test.
  const resolvers = new Map<string, (r: Response) => void>();
  const fetchMock = vi.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => resolvers.set(String(input), resolve)),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderModal();
  const input = screen.getByPlaceholderText("Search…");

  fireEvent.change(input, { target: { value: "alpha" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // debounce fires
  fireEvent.change(input, { target: { value: "paper" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  // NEWER query resolves first…
  await act(async () => {
    resolvers.get("/api/search?q=paper")!(jsonResponse(results));
  });
  await screen.findAllByRole("listitem");

  // …then the OLD query's slow response arrives late: it must be dropped.
  const stale = { pages: [{ id: 9, title: "Stale Alpha" }], blocks: [] };
  await act(async () => {
    resolvers.get("/api/search?q=alpha")!(jsonResponse(stale));
    await new Promise((r) => setTimeout(r, 0));
  });

  const items = screen.getAllByRole("listitem");
  expect(items[0].textContent).toContain("Paper");
  expect(screen.queryByText("Stale Alpha")).toBeNull();
});

it("Escape closes without navigating", () => {
  stubFetch([]);
  const onClose = renderModal();
  fireEvent.keyDown(screen.getByPlaceholderText("Search…"), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it('shows a create-page row when no page hit matches the query exactly', async () => {
  stubFetch([["/api/search?q=papers", results]]); // page hit is "Paper", query is "papers"
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "papers" } });
  await screen.findAllByRole("listitem");
  expect(screen.getByText('Create page "papers"')).toBeInTheDocument();
});

it('shows a create-page row when there are no search results at all', async () => {
  stubFetch([["/api/search?q=nonexistent", { pages: [], blocks: [] }]]);
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "nonexistent" } });
  await waitFor(() =>
    expect(screen.getByText('Create page "nonexistent"')).toBeInTheDocument());
});

it("does NOT show a create-page row when a page hit matches case-insensitively", async () => {
  stubFetch([["/api/search?q=PAPER", results]]); // page hit "Paper" matches "PAPER" case-insensitively
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "PAPER" } });
  await screen.findAllByRole("listitem");
  expect(screen.queryByText(/Create page/)).toBeNull();
});

it("does not flash the create row while a newer query's results are in flight", async () => {
  const resolvers = new Map<string, (r: Response) => void>();
  const fetchMock = vi.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => resolvers.set(String(input), resolve)),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderModal();
  const input = screen.getByPlaceholderText("Search…");

  fireEvent.change(input, { target: { value: "zzz" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    resolvers.get("/api/search?q=zzz")!(jsonResponse({ pages: [], blocks: [] }));
  });
  await waitFor(() => expect(screen.getByText('Create page "zzz"')).toBeInTheDocument());

  // Type more while the next fetch is still in flight: the stale create row
  // (for "zzz") must disappear until the new query's results settle.
  fireEvent.change(input, { target: { value: "zzzy" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Create page "zzz"')).toBeNull();
  expect(screen.queryByText('Create page "zzzy"')).toBeNull();
});

it('picking the create row POSTs the page and navigates to it', async () => {
  const fetchMock = stubFetch([
    ["/api/search?q=papers", results],
    ["/api/pages", { id: 42, title: "papers", created_at: 1, updated_at: 1 }],
  ]);
  const onClose = renderModal();
  const input = screen.getByPlaceholderText("Search…");
  fireEvent.change(input, { target: { value: "papers" } });
  const createRow = await screen.findByText('Create page "papers"');
  await act(async () => {
    fireEvent.click(createRow);
  });
  expect(fetchMock).toHaveBeenCalledWith("/api/pages", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ title: "papers" }),
  }));
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

it("a failed create POST keeps the modal open and does not navigate", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/search?q=papers")) return jsonResponse(results);
    if (url.startsWith("/api/pages")) return jsonResponse({ detail: "boom" }, 500);
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onClose = renderModal();
  const input = screen.getByPlaceholderText("Search…");
  fireEvent.change(input, { target: { value: "papers" } });
  const createRow = await screen.findByText('Create page "papers"');
  await act(async () => {
    fireEvent.click(createRow);
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText("page view here")).toBeNull();
  expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
});
