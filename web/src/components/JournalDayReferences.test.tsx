import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { BlockRefProvider } from "./BlockRefProvider";
import { journalBacklinks } from "../test-helpers";
import { JournalDayReferences } from "./JournalDayReferences";

afterEach(() => vi.unstubAllGlobals());

const PLANS = [{
  page_id: 9,
  page_title: "Plans",
  items: [{ uid: "uid_p1", text: "Remind me on [[July 7th, 2026]]",
            breadcrumbs: [] }],
}];

function show(refs: Parameters<typeof journalBacklinks>[0],
              seed: Record<string, { text: string; page_title: string }> = {}) {
  const fetchMock = vi.fn(() =>
    Promise.reject(new Error("no request may be made for a rendered day")));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BlockRefProvider seed={seed}>
        <JournalDayReferences title="July 7th, 2026"
                              backlinks={journalBacklinks(refs)} />
      </BlockRefProvider>
    </MemoryRouter>,
  );
  return fetchMock;
}

it("stays absent for a day nothing links to", () => {
  const fetchMock = show([]);
  expect(document.querySelector(".backlinks")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("renders the reused BacklinksSection from the day's own payload, with no "
 + "request of its own (pkm-5fak)", () => {
  // The references arrive in /api/journal's payload. A fetch from here is the
  // N+1 this replaced: one page read per day on screen.
  const fetchMock = show(PLANS);
  expect(screen.getByText(/linked references \(1\)/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Plans" })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("resolves ((block refs)) in a reference's text from the journal-wide map",
() => {
  // The server merges the backlink items' own ((refs)) into the journal
  // payload's block_ref_texts, which the Journal seeds for every day.
  show(
    [{ page_id: 9, page_title: "Plans",
       items: [{ uid: "uid_p1", text: "see ((ref_local)) for details",
                 breadcrumbs: [] }] }],
    { ref_local: { text: "resolved locally", page_title: "Elsewhere" } },
  );
  expect(screen.getByText("resolved locally")).toBeInTheDocument();
});
