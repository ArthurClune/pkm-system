import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import type { ShownBacklinkGroup } from "./groups";
import { SidebarContext } from "../contexts";
import { pageIdOf, canonicalTitleOf, typeProbe, uidOf } from "../test-helpers";
import { BacklinkGroupList } from "./BacklinkGroupList";

type OnNavigate = NonNullable<ComponentProps<typeof BacklinkGroupList>["onNavigate"]>;

const group: ShownBacklinkGroup = {
  page_id: pageIdOf(1), page_title: canonicalTitleOf("Source"),
  items: [{ uid: uidOf("tuid-uid_a"), text: "text", crumbs: [] }],
};

function mount(onNavigate?: OnNavigate, shown: ShownBacklinkGroup = group) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <BacklinkGroupList groups={[shown]} onNavigate={onNavigate} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
}

it("navigates with the group's page title and the clicked item's uid", () => {
  const onNavigate = vi.fn();
  mount(onNavigate);
  fireEvent.click(screen.getByText("text"));
  expect(onNavigate).toHaveBeenCalledWith("Source", "tuid-uid_a");
});

const imageGroup: ShownBacklinkGroup = {
  ...group,
  items: [{
    uid: uidOf("tuid-uid_img"), crumbs: [],
    text: `![pic](/assets/${"ab".repeat(32)}/pic.png)`,
  }],
};

it("rows with onNavigate render media inert", () => {
  mount(() => undefined, imageGroup);
  expect(screen.getByRole("img", { name: "pic" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Expand image/ })).toBeNull();
});

it("rows without onNavigate keep media live", () => {
  mount(undefined, imageGroup);
  expect(screen.getByRole("button", { name: /Expand image/ })).toBeInTheDocument();
});

// pageTitle and uid can't be swapped.
typeProbe(() => {
  const someUid = uidOf("abcdef");
  const onNavigate: OnNavigate = () => undefined;
  // @ts-expect-error (pageTitle, uid) swapped
  onNavigate(someUid, "Page");
});
