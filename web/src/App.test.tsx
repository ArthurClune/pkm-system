import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "./router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SIDEBAR_STORAGE_KEY } from "./sidebar";
import { block, pagePayload, stubFetch } from "./test-helpers";
import { App } from "./App";

class NoopObserver {
  constructor(_cb: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NoopObserver));
afterEach(() => vi.unstubAllGlobals());

it("shift-click stacks sidebar panels newest-first; close removes one", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/AI", pagePayload("AI", [block("uid_s2", "ai body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]] and [[AI]]")])],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "AI" }), { shiftKey: true });
  expect(await screen.findByText("ai body")).toBeInTheDocument();

  const panels = screen.getAllByRole("region"); // section elements with aria-label
  expect(within(panels[0]).getByText("ai body")).toBeInTheDocument(); // newest on top

  fireEvent.click(within(panels[0]).getByRole("button", { name: "close panel" }));
  expect(screen.queryByText("ai body")).toBeNull();
  expect(screen.getByText("paper body")).toBeInTheDocument();
});

it("cmd-u opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", metaKey: true });
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("ctrl-u opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", ctrlKey: true });
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("clicking the top bar's Search button opens the search modal; the left nav has no search entry", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull(); // journal: no page menu
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("the top bar's page menu opens 'Open in sidebar', which stacks the current page", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", { name: "Paper" });

  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in sidebar" }));

  const panel = await screen.findByRole("region"); // the stacked sidebar panel
  expect(within(panel).getByText("paper body")).toBeInTheDocument();
});

it("cmd-k no longer opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.queryByPlaceholderText("Search…")).toBeNull();
});

it("ctrl-cmd-d navigates to the home page", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/journal", { days: [] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Paper" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, metaKey: true });
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "Paper" })).toBeNull();
  });
});

it("clicking the sidebar toggle collapses the left nav and persists the choice; clicking again restores it", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  const nav = screen.getByRole("navigation");
  expect(nav).not.toHaveClass("collapsed");

  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(nav).toHaveClass("collapsed");
  expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");

  fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(nav).not.toHaveClass("collapsed");
  expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("open");
});

it("honours a persisted 'collapsed' sidebar preference on initial render", async () => {
  localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.getByRole("navigation")).toHaveClass("collapsed");
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
});

it("search stays reachable via the top bar when the sidebar is collapsed", async () => {
  localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("unknown route renders the not-found view", () => {
  stubFetch([]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/definitely/not/a/route"]}><App /></MemoryRouter>);
  expect(screen.getByText("Page not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" })).toBeInTheDocument();
});
