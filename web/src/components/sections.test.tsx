import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import type { Backlinks } from "../api/payloads";
import { pagePayload, stubFetch } from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";
import { mergeGroups } from "./groups";
import { UnlinkedSection } from "./UnlinkedSection";

afterEach(() => vi.unstubAllGlobals());

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
