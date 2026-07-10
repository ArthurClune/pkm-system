import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { TopBar } from "./TopBar";

function renderTopBar(
  path: string,
  openInSidebar = vi.fn(),
  sidebarCollapsed = false,
  onToggleSidebar = vi.fn(),
) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <TopBar onSearchClick={vi.fn()} sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={onToggleSidebar} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
}

it("clicking the search button calls onSearchClick", () => {
  const onSearchClick = vi.fn();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <TopBar onSearchClick={onSearchClick} sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onSearchClick).toHaveBeenCalledOnce();
});

it("shows the sidebar toggle before the search button, labelled to hide an open sidebar", () => {
  renderTopBar("/");
  const toggle = screen.getByRole("button", { name: "Hide sidebar" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const search = screen.getByRole("button", { name: "Search" });
  // DOM order backs the "left edge, before search" placement enforced by CSS.
  expect(toggle.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("reflects a collapsed sidebar with a 'Show sidebar' label and aria-expanded=false", () => {
  renderTopBar("/", vi.fn(), true);
  const button = screen.getByRole("button", { name: "Show sidebar" });
  expect(button).toHaveAttribute("aria-expanded", "false");
});

it("clicking the sidebar toggle calls onToggleSidebar", () => {
  const onToggleSidebar = vi.fn();
  renderTopBar("/", vi.fn(), false, onToggleSidebar);
  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(onToggleSidebar).toHaveBeenCalledOnce();
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
