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

it("cmd-u focuses the top bar's search bar", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", metaKey: true });
  expect(screen.getByPlaceholderText("Search…")).toHaveFocus();
});

it("ctrl-u focuses the top bar's search bar", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", ctrlKey: true });
  expect(screen.getByPlaceholderText("Search…")).toHaveFocus();
});

it("links to Current Work under Daily Notes and renders the route", async () => {
  stubFetch([["/api/current-work", { sections: [
    { id: "last-24-hours", title: "Last 24 hours", pages: [] },
    { id: "24-to-48-hours", title: "24–48 hours", pages: [] },
    { id: "48-hours-to-7-days", title: "48 hours–7 days", pages: [] },
  ] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/current-work"]}><App /></MemoryRouter>);

  const links = screen.getAllByRole("link").map((link) => link.textContent);
  expect(links.slice(0, 2)).toEqual(["Daily Notes", "Current Work"]);
  expect(screen.getByRole("link", { name: "Current Work" }))
    .toHaveAttribute("href", "/current-work");
  expect(await screen.findByRole("heading", { name: "Current Work" })).toBeInTheDocument();
});

it("the top bar has a focusable search bar; the left nav has no search entry", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull(); // journal: no page menu
  const input = screen.getByPlaceholderText("Search…");
  input.focus();
  expect(input).toHaveFocus();
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

it("cmd-k does not focus the search bar", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.getByPlaceholderText("Search…")).not.toHaveFocus();
});

it("cmd-/ hides the stacked right sidebar; pressing it again shows it", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]]")])],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "/", metaKey: true });
  expect(screen.queryByText("paper body")).toBeNull();

  fireEvent.keyDown(window, { key: "/", metaKey: true });
  // Panels remount on re-show, so the content is re-fetched.
  expect(await screen.findByText("paper body")).toBeInTheDocument();
});

it("ctrl-/ also toggles the right sidebar", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]]")])],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "/", ctrlKey: true });
  expect(screen.queryByText("paper body")).toBeNull();
});

it("opening a page in the sidebar reveals a hidden right sidebar", async () => {
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

  fireEvent.keyDown(window, { key: "/", metaKey: true });
  expect(screen.queryByText("paper body")).toBeNull();

  fireEvent.click(screen.getByRole("link", { name: "AI" }), { shiftKey: true });
  expect(await screen.findByText("ai body")).toBeInTheDocument();
  expect(screen.getByText("paper body")).toBeInTheDocument();
});

it("plain '/' with no modifier does not hide the right sidebar", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]]")])],
  ]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "/" });
  expect(screen.getByText("paper body")).toBeInTheDocument();
});

// Ctrl-Cmd-D was the original binding but macOS reserves it for dictionary
// lookup, so the page never receives the keydown; Ctrl-Shift-D replaces it.
it("ctrl-shift-d navigates to the home page", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/journal", { days: [] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Paper" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "Paper" })).toBeNull();
  });
});

it("ctrl-cmd-d is no longer bound", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Paper" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, metaKey: true });
  expect(screen.getByRole("heading", { name: "Paper" })).toBeInTheDocument();
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
  const input = screen.getByPlaceholderText("Search…");
  input.focus();
  expect(input).toHaveFocus();
});

it("unknown route renders the not-found view", () => {
  stubFetch([]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/definitely/not/a/route"]}><App /></MemoryRouter>);
  expect(screen.getByText("Page not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" })).toBeInTheDocument();
});
