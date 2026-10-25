import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BacklinkGroup } from "../api/payloads";
import { SidebarContext } from "../contexts";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { pageIdOf, canonicalTitleOf, typeProbe, uidOf } from "../test-helpers";
import { BacklinkGroupList } from "./BacklinkGroupList";

type OnNavigate = NonNullable<ComponentProps<typeof BacklinkGroupList>["onNavigate"]>;

const group: BacklinkGroup = {
  page_id: pageIdOf(1), page_title: canonicalTitleOf("Source"),
  items: [{ uid: uidOf("tuid-uid_a"), text: "text", ancestor_uids: [] }],
};

function mount(onNavigate?: OnNavigate, groups: BacklinkGroup[] = [group],
               ancestorTexts: Record<string, string> = {}) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <BacklinkGroupList groups={groups} ancestorTexts={ancestorTexts}
                           onNavigate={onNavigate} />
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

it("renders each ancestor's text from the shared map, root first", () => {
  const nested: BacklinkGroup = { ...group, items: [{
    uid: uidOf("tuid-uid_b"), text: "leaf",
    ancestor_uids: [uidOf("tuid-root"), uidOf("tuid-mid")] }] };
  mount(undefined, [nested], { "tuid-root": "Root text", "tuid-mid": "Mid" });
  expect(screen.getByText("Root text › Mid")).toBeInTheDocument();
});

it("names an ancestor the map lacks by its uid", () => {
  const nested: BacklinkGroup = { ...group, items: [{
    uid: uidOf("tuid-uid_c"), text: "leaf",
    ancestor_uids: [uidOf("tuid-root"), uidOf("tuid-gone")] }] };
  mount(undefined, [nested], { "tuid-root": "Root text" });
  expect(screen.getByText("Root text › tuid-gone")).toBeInTheDocument();
});

// pageTitle and uid can't be swapped.
typeProbe(() => {
  const someUid = uidOf("abcdef");
  const onNavigate: OnNavigate = () => undefined;
  // @ts-expect-error (pageTitle, uid) swapped
  onNavigate(someUid, "Page");
});
