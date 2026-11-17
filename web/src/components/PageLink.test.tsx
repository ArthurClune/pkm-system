// Page links carry their title namespace as data-ns so the stylesheet can
// colour whole trees ([[AWS/...]], [[Claude/...]]) differently.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { rawTitleOf } from "../test-helpers";
import { PageLink } from "./PageLink";

function mount(titleText: string, tag = false) {
  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <PageLink title={rawTitleOf(titleText)} tag={tag} />
      </SidebarContext.Provider>
    </MemoryRouter>);
  return container.querySelector("a")!;
}

it("stamps a namespaced title's lowercased prefix as data-ns", () => {
  expect(mount("AWS/EC2").getAttribute("data-ns")).toBe("aws");
  expect(mount("LLM/Prompting").getAttribute("data-ns")).toBe("llm");
});

it("leaves plain titles without a data-ns attribute", () => {
  expect(mount("Machine Learning").hasAttribute("data-ns")).toBe(false);
});

it("tags are chips, not coloured tree links: no data-ns", () => {
  const a = mount("AWS/EC2", true);
  expect(a.className).toBe("tag");
  expect(a.hasAttribute("data-ns")).toBe(false);
});

function StateProbe() {
  const { pathname } = useLocation();
  const state: unknown = useLocation().state;
  return <p data-testid="probe">{`${pathname} ${JSON.stringify(state)}`}</p>;
}

function mountRouted(titleText: string) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <Routes>
          <Route path="/" element={<PageLink title={rawTitleOf(titleText)} tag={false} />} />
          <Route path="/page/*" element={<StateProbe />} />
        </Routes>
      </SidebarContext.Provider>
    </MemoryRouter>);
  fireEvent.click(screen.getByRole("link"));
  return screen.getByTestId("probe").textContent;
}

it("a link to a Paper/ page asks the page to seed its template", () => {
  expect(mountRouted("Paper/x")).toBe('/page/Paper/x {"seedTemplate":true}');
});

it("a link to a title without a template carries no state", () => {
  expect(mountRouted("Machine Learning")).toBe("/page/Machine%20Learning null");
});
