import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BacklinkGroup } from "../api/payloads";
import { SidebarContext } from "../contexts";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { uid } from "../test-helpers";
import { BacklinkGroupList } from "./BacklinkGroupList";

type OnNavigate = NonNullable<ComponentProps<typeof BacklinkGroupList>["onNavigate"]>;

const group: BacklinkGroup = {
  page_id: 1, page_title: "Source",
  items: [{ uid: uid("uid_a"), text: "text", breadcrumbs: [] }],
};

function mount(onNavigate: (pageTitle: string, uid: string) => void) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <BacklinkGroupList groups={[group]} onNavigate={onNavigate} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
}

it("navigates with the group's page title and the clicked item's uid", () => {
  const onNavigate = vi.fn();
  mount(onNavigate);
  fireEvent.click(screen.getByText("text"));
  expect(onNavigate).toHaveBeenCalledWith("Source", "uid_a");
});

it("pageTitle and uid can't be swapped", () => {
  const someUid = uid("abcdef");
  const onNavigate: OnNavigate = () => undefined;
  // @ts-expect-error (pageTitle, uid) swapped
  onNavigate(someUid, "Page");
  expect(true).toBe(true);
});
