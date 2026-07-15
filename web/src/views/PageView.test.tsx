import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { isOutlineSessionActive } from "../outline/outlineSessions";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, pagePayload, stubFetch } from "../test-helpers";
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
  stubFetch([]);
  renderAt("/page/Nope");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
});

it("releases a failed parent read when the page unmounts", async () => {
  stubFetch([]);
  const view = renderAt("/page/Failed%20read");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();

  view.unmount();

  expect(isOutlineSessionActive("Failed read")).toBe(false);
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
