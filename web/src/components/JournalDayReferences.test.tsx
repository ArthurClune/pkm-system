import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { pagePayload, stubFetch } from "../test-helpers";
import { JournalDayReferences } from "./JournalDayReferences";

afterEach(() => vi.unstubAllGlobals());

it("renders nothing while loading and stays absent when a day has no references",
  async () => {
    const fetchMock = stubFetch([
      ["/api/page/July%207th%2C%202026", pagePayload("July 7th, 2026", [])],
    ]);
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <JournalDayReferences title="July 7th, 2026" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.querySelector(".backlinks")).toBeNull();
    // A small preview limit, and a URL distinct from a plain parent-page
    // read of the same title (the two can otherwise collide when a page is
    // open in both the journal and elsewhere at once).
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/page/July%207th%2C%202026?bl_limit=5", { method: "GET" });
  });

it("renders the reused BacklinksSection once a day's references load",
  async () => {
    stubFetch([
      ["/api/page/July%207th%2C%202026", pagePayload("July 7th, 2026", [], {
        backlinks: {
          groups: [{ page_id: 9, page_title: "Plans", items: [
            { uid: "uid_p1", text: "Remind me on [[July 7th, 2026]]",
              breadcrumbs: [] }] }],
          total_pages: 1, offset: 0, limit: 20,
        },
      })],
    ]);
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <JournalDayReferences title="July 7th, 2026" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/linked references \(1\)/i))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plans" })).toBeInTheDocument();
  });

it("resolves ((block refs)) carried in the day's own fetch, not just the " +
   "ambient journal-wide map", async () => {
    stubFetch([
      ["/api/page/July%207th%2C%202026", pagePayload("July 7th, 2026", [], {
        backlinks: {
          groups: [{ page_id: 9, page_title: "Plans", items: [
            { uid: "uid_p1", text: "see ((ref_local)) for details",
              breadcrumbs: [] }] }],
          total_pages: 1, offset: 0, limit: 20,
        },
        block_ref_texts: {
          ref_local: { text: "resolved locally", page_title: "Elsewhere" },
        },
      })],
    ]);
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <JournalDayReferences title="July 7th, 2026" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("resolved locally")).toBeInTheDocument();
  });

it("stays absent when the fetch fails (offline / day deleted underneath us)",
  async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <JournalDayReferences title="July 7th, 2026" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.querySelector(".backlinks")).toBeNull();
  });
