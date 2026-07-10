import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { stubFetch } from "../test-helpers";
import { TopBar } from "./TopBar";

afterEach(() => vi.unstubAllGlobals());

function renderTopBar(path: string, openInSidebar = vi.fn()) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <TopBar onSearchClick={vi.fn()} />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it("clicking the search button calls onSearchClick", () => {
  const onSearchClick = vi.fn();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <TopBar onSearchClick={onSearchClick} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onSearchClick).toHaveBeenCalledOnce();
});

it("shows no page menu on the journal route", () => {
  renderTopBar("/");
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull();
});

it("shows a page menu on a page route", () => {
  renderTopBar("/page/Paper");
  expect(screen.getByRole("button", { name: "Page menu" })).toBeInTheDocument();
});

it("page menu button starts closed and toggles aria-expanded on click", () => {
  renderTopBar("/page/Paper");
  const button = screen.getByRole("button", { name: "Page menu" });
  expect(button).toHaveAttribute("aria-haspopup", "menu");
  expect(button).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Open in sidebar" })).toBeInTheDocument();
});

it("picking 'Open in sidebar' calls openInSidebar with the current page title and closes the menu", () => {
  const openInSidebar = vi.fn();
  renderTopBar("/page/Machine%20Learning", openInSidebar);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in sidebar" }));

  expect(openInSidebar).toHaveBeenCalledWith("Machine Learning");
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes the menu on outside click", () => {
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();

  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes the menu on Escape", () => {
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});

it("picking 'Delete page…' asks for confirmation, and cancelling makes no request", () => {
  const fetchMock = stubFetch([]);
  vi.stubGlobal("confirm", vi.fn(() => false));
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));

  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Paper"));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeInTheDocument(); // untouched: nothing happened
});

it("confirming delete sends DELETE to the page's URL, closes the menu, and navigates to /", async () => {
  const fetchMock = stubFetch([["/api/page/Machine%20Learning", { ok: true }]]);
  vi.stubGlobal("confirm", vi.fn(() => true));
  renderTopBar("/page/Machine%20Learning");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  });

  expect(fetchMock).toHaveBeenCalledWith("/api/page/Machine%20Learning",
    expect.objectContaining({ method: "DELETE" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByText("home")).toBeInTheDocument();
});

it("a failed delete closes the menu but does not navigate", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  vi.stubGlobal("confirm", vi.fn(() => true));
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  });

  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByText("page view here")).toBeInTheDocument();
  expect(screen.queryByText("home")).toBeNull();
});
