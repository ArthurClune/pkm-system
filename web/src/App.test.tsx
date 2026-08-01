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

it("Daily Notes and Current Work are both primary links, whatever the route (pkm-nn7o)", async () => {
  stubFetch([["/api/current-work", { sections: [
    { id: "last-24-hours", title: "Last 24 hours", pages: [] },
    { id: "24-to-48-hours", title: "24–48 hours", pages: [] },
    { id: "48-hours-to-7-days", title: "48 hours–7 days", pages: [] },
  ] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/current-work"]}><App /></MemoryRouter>);

  // both carry the always-highlighted variant even though only /current-work
  // is the active route
  expect(screen.getByRole("link", { name: "Daily Notes" }).className).toContain("primary");
  expect(screen.getByRole("link", { name: "Current Work" }).className).toContain("primary");
});

it("links to TODO under Daily Notes and Current Work (pkm-6s7l)", async () => {
  stubFetch([["/api/page/TODO", pagePayload("TODO", [block("uid_t1", "todo body")])]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/TODO"]}><App /></MemoryRouter>);

  const links = screen.getAllByRole("link").map((link) => link.textContent);
  expect(links.slice(0, 3)).toEqual(["Daily Notes", "Current Work", "TODO"]);
  expect(screen.getByRole("link", { name: "TODO" })).toHaveAttribute("href", "/page/TODO");
  expect(await screen.findByRole("heading", { name: "TODO" })).toBeInTheDocument();
});

it("the TODO nav link is a primary link and reflects the active route", async () => {
  stubFetch([["/api/page/TODO", pagePayload("TODO", [block("uid_t1", "todo body")])]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/TODO"]}><App /></MemoryRouter>);

  const link = screen.getByRole("link", { name: "TODO" });
  expect(link.className).toContain("primary");
  expect(link.className).toContain("active");
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

// pkm-57mo: the center pane widens into whatever space a missing/collapsed
// sidebar frees up. The pane's own width is a CSS var driven off these
// classes, so the classes are what's testable in JS; the actual widths are
// asserted in e2e/page-width.spec.ts.
it("the .app container has no-sidebar by default (no stack, no left collapse)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  await screen.findByPlaceholderText("Search…");
  const app = container.querySelector(".app");
  expect(app).toHaveClass("no-sidebar");
  expect(app).not.toHaveClass("nav-collapsed");
});

it("opening a page in the sidebar drops the no-sidebar class from .app", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]]")])],
  ]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  const app = container.querySelector(".app");
  expect(app).toHaveClass("no-sidebar");

  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  await screen.findByText("paper body");
  expect(app).not.toHaveClass("no-sidebar");
});

it("hiding the stacked sidebar (Cmd-/) restores the no-sidebar class on .app", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]]")])],
  ]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  const app = container.querySelector(".app");
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  await screen.findByText("paper body");
  expect(app).not.toHaveClass("no-sidebar");

  fireEvent.keyDown(window, { key: "/", metaKey: true });
  expect(screen.queryByText("paper body")).toBeNull();
  expect(app).toHaveClass("no-sidebar");
});

it("collapsing the left nav adds nav-collapsed to .app; restoring it removes it", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  const app = container.querySelector(".app");
  expect(app).not.toHaveClass("nav-collapsed");

  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(app).toHaveClass("nav-collapsed");

  fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(app).not.toHaveClass("nav-collapsed");
});

it("both a collapsed left nav and an absent right sidebar apply both classes together", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  const app = container.querySelector(".app");
  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(app).toHaveClass("nav-collapsed");
  expect(app).toHaveClass("no-sidebar");
});

it("unknown route renders the not-found view", () => {
  stubFetch([]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/definitely/not/a/route"]}><App /></MemoryRouter>);
  expect(screen.getByText("Page not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" })).toBeInTheDocument();
});

it("Settings nav link sits below the user-editable favourites but is styled primary (pkm-eztt)", () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  const nav = container.querySelector(".left-nav");
  // Role "link" only catches <a>/NavLink elements, not the ThemeToggle or
  // SidebarNav's "Edit" toggle (both <button>s) -- so this is exactly the
  // three primary destinations plus Settings, in DOM order.
  const links = within(nav as HTMLElement).getAllByRole("link").map((el) => el.textContent);
  expect(links).toEqual(["Daily Notes", "Current Work", "TODO", "Files", "Settings"]);

  const settingsLink = screen.getByRole("link", { name: "Settings" });
  expect(settingsLink).toHaveClass("primary");
});

it("Assistant link opens a new section below the pinned pages (pkm-usb6)", () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  // The pinned list draws its own upper rule; this class draws the lower one,
  // so the user's entries are fenced on both sides.
  expect(screen.getByRole("button", { name: "Assistant" })).toHaveClass("nav-section-start");
});

it("Settings nav link navigates to /settings", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
});

it("renders the Files view at /files", async () => {
  // the suite's global fetch stub 404s /api/assets/search, so the view
  // lands in its error state, which still renders the heading.
  stubFetch([]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/files"]}><App /></MemoryRouter>);
  expect(
    await screen.findByRole("heading", { name: "Files" }),
  ).toBeInTheDocument();
});

// pkm-77w2: this exercises useRouteTitle() as actually mounted inside App
// (App.tsx:59), not via a synthetic probe -- useRouteTitle.test.tsx covers
// the hook in isolation, but only a real <App/> render proves the wiring
// itself wasn't dropped.
it("sets the browser title from the centralized route table as App navigates between static routes (pkm-77w2)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  await screen.findByPlaceholderText("Search…");
  expect(document.title).toBe("Daily Notes — pkm");

  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  expect(document.title).toBe("Settings — pkm");
});

it("the hamburger exposes the drawer's expanded state and what it controls (pkm-rwwp)", () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  const hamburger = screen.getByRole("button", { name: "menu" });
  const nav = container.querySelector(".left-nav") as HTMLElement;
  expect(nav.id).toBe("left-nav");
  expect(hamburger).toHaveAttribute("aria-controls", "left-nav");
  expect(hamburger).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(hamburger);
  expect(hamburger).toHaveAttribute("aria-expanded", "true");
  expect(nav).toHaveClass("open");

  fireEvent.click(hamburger);
  expect(hamburger).toHaveAttribute("aria-expanded", "false");
  expect(nav).not.toHaveClass("open");
});

it("closing the nav drawer returns focus to the hamburger (pkm-rwwp)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  const hamburger = screen.getByRole("button", { name: "menu" });

  // closed by the hamburger itself
  fireEvent.click(hamburger);
  fireEvent.click(hamburger);
  expect(hamburger).toHaveFocus();

  // and closed by picking a destination: focus must not be left on a link
  // that visibility:hidden is about to take away
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.click(hamburger);
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" }))
    .toBeInTheDocument();
  expect(hamburger).toHaveFocus();
});

it("a never-opened drawer does not steal focus on mount or navigation (pkm-rwwp)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  const hamburger = screen.getByRole("button", { name: "menu" });
  expect(hamburger).not.toHaveFocus();
  // every NavLink calls setNavOpen(false) unconditionally; on desktop, where
  // the drawer is permanent, that must not pull focus to a display:none button
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" }))
    .toBeInTheDocument();
  expect(hamburger).not.toHaveFocus();
});
