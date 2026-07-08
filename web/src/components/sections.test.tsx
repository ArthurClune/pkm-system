import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Backlinks } from "../api/payloads";
import { pagePayload, stubFetch } from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";
import { mergeGroups } from "./groups";
import { UnlinkedSection } from "./UnlinkedSection";

afterEach(() => vi.unstubAllGlobals());

const initial: Backlinks = {
  groups: [{
    page_id: 3,
    page_title: "July 7th, 2026",
    items: [{ uid: "uid_b4", text: "Studying [[Machine Learning]] today",
              breadcrumbs: ["Morning", "Reading"] }],
  }],
  total_pages: 2,
  offset: 0,
  limit: 20,
};

it("mergeGroups merges batches by page_id and dedupes items", () => {
  const merged = mergeGroups(
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }] }],
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
     { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] }],
  );
  expect(merged).toEqual([
    { page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
    { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] },
  ]);
});

it("renders backlink groups with breadcrumbs and loads more on demand", async () => {
  const more = pagePayload("Machine Learning", [], {
    backlinks: {
      groups: [{ page_id: 9, page_title: "AI", items: [
        { uid: "uid_b9", text: "more [[Machine Learning]]", breadcrumbs: [] }] }],
      total_pages: 2, offset: 1, limit: 20,
    },
  });
  const fetchMock = stubFetch([["/api/page/Machine%20Learning?bl_offset=1", more]]);
  render(
    <MemoryRouter>
      <BacklinksSection title="Machine Learning" initial={initial} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/linked references \(2\)/i)).toBeInTheDocument();
  expect(screen.getByText("Morning › Reading")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "July 7th, 2026" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "AI" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Machine%20Learning?bl_offset=1&bl_limit=20", undefined);
  // 2 groups loaded of total_pages 2 -> button gone
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("unlinked references fetch lazily on first open and paginate", async () => {
  const fetchMock = stubFetch([
    ["/api/unlinked?title=Machine%20Learning&limit=20&offset=1", {
      groups: [{ page_id: 5, page_title: "AGI", items: [
        { uid: "uid_u2", text: "machine learning épilogue" }] }],
      total: 2,
    }],
    ["/api/unlinked?title=Machine%20Learning", {
      groups: [{ page_id: 2, page_title: "AI", items: [
        { uid: "uid_u1", text: "AI overview mentions Machine Learning in plain text" }] }],
      total: 2,
    }],
  ]);
  render(
    <MemoryRouter>
      <UnlinkedSection title="Machine Learning" />
    </MemoryRouter>,
  );
  expect(fetchMock).not.toHaveBeenCalled(); // collapsed = no fetch
  fireEvent.click(screen.getByText(/unlinked references/i));
  expect(await screen.findByText(/mentions Machine Learning/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/épilogue/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});
