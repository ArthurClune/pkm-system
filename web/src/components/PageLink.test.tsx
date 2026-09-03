// Page links carry their title namespace as data-ns so the stylesheet can
// colour whole trees ([[AWS/...]], [[Claude/...]]) differently (pkm-r71a).
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { PageLink } from "./PageLink";

function mount(title: string, tag = false) {
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <PageLink title={title} tag={tag} />
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
