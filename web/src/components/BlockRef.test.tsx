// Click-to-navigate on resolved ((block refs)) — pkm-pzdu.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, SidebarContext } from "../contexts";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { BlockRef } from "./BlockRef";

function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function mount(refTexts: Record<string, BlockRefText>,
               openInSidebar = vi.fn()) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <BlockRefContext.Provider value={refTexts}>
          <BlockRef uid="ref_aa1" depth={0} />
        </BlockRefContext.Provider>
      </SidebarContext.Provider>
      <Probe />
    </MemoryRouter>);
  return openInSidebar;
}

const RESOLVED: Record<string, BlockRefText> = {
  ref_aa1: { text: "target text", page_title: "Paper" },
};

it("clicking a resolved ref navigates to its page with the uid as hash", () => {
  mount(RESOLVED);
  fireEvent.click(screen.getByText("target text"));
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Paper#ref_aa1");
});

it("encodes the target page title in the path", () => {
  mount({ ref_aa1: { text: "x", page_title: "Machine Learning" } });
  fireEvent.click(screen.getByText("x"));
  expect(screen.getByTestId("loc"))
    .toHaveTextContent("/page/Machine%20Learning#ref_aa1");
});

it("shift-click opens the target page in the sidebar instead", () => {
  const openInSidebar = mount(RESOLVED);
  fireEvent.click(screen.getByText("target text"), { shiftKey: true });
  expect(openInSidebar).toHaveBeenCalledWith("Paper");
  expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/);
});

it("Enter on a focused ref navigates like a click", () => {
  mount(RESOLVED);
  const ref = screen.getByRole("link", { name: "target text" });
  fireEvent.keyDown(ref, { key: "Enter" });
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Paper#ref_aa1");
});

it("an inner [[link]] in the resolved text navigates to ITS page, not the ref target", () => {
  mount({ ref_aa1: { text: "see [[World]]", page_title: "Paper" } });
  fireEvent.click(screen.getByRole("link", { name: "World" }));
  expect(screen.getByTestId("loc")).toHaveTextContent(/\/page\/World$/);
});

it("an unresolved ref is not a link", () => {
  mount({});
  expect(screen.getByText("((ref_aa1))")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});
