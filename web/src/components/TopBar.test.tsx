import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { TopBar } from "./TopBar";

function renderTopBar(path: string, openInSidebar = vi.fn()) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <TopBar onSearchClick={vi.fn()} />
      </SidebarContext.Provider>
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
