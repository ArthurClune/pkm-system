import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import type { Backlinks } from "../api/payloads";
import { ROUTER_FUTURE_FLAGS } from "../router";
import {
  resetPlainSpaceTitleCanonicalization, setPlainSpaceTitleCanonicalization,
} from "../sync/titleCanonicalization";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";

afterEach(resetPlainSpaceTitleCanonicalization);

// The server indexes [[ AI ]] and [[ML ]] as refs to AI and ML under the
// plain-space flag, so on page AI both blocks are backlinks and the two
// spellings of ML are one page.
const initial: Backlinks = {
  groups: [{
    page_id: pageIdOf(3), page_title: canonicalTitleOf("Daily"),
    items: [
      { uid: uidOf("tuid-a"), text: "[[AI]] and [[ML]]", breadcrumbs: [] },
      { uid: uidOf("tuid-b"), text: "[[ AI ]] and [[ML ]]", breadcrumbs: [] },
    ],
  }],
  total_pages: 1, offset: 0, limit: 20,
};

const openPanel = () => render(
  <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
    <BacklinksSection title={canonicalTitleOf("AI")} initial={initial} />
  </MemoryRouter>);

const chips = () => [...document.querySelectorAll(".filter-candidates .filter-chip")]
  .map((chip) => chip.textContent);

it("merges padded spellings into one chip under the flag", async () => {
  setPlainSpaceTitleCanonicalization(true);
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
  expect(chips()).toEqual(["ML (2)"]);
});

it("re-derives the chips when the flag flips", async () => {
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
  expect(chips()).toEqual([" AI  (1)", "ML (1)", "ML  (1)"]);
  act(() => setPlainSpaceTitleCanonicalization(true));
  expect(chips()).toEqual(["ML (2)"]);
});
