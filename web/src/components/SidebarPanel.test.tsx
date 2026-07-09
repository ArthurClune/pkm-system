import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "../test-helpers";
import { SidebarPanel } from "./SidebarPanel";

afterEach(() => vi.unstubAllGlobals());

it("fetches its page and renders title plus block tree, no backlinks", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "a paper block")], {
    backlinks: { groups: [{ page_id: 1, page_title: "Machine Learning", items: [
      { uid: "uid_b3", text: "should not render", breadcrumbs: [] }] }],
      total_pages: 1, offset: 0, limit: 20 },
  })]]);
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={() => undefined} /></MemoryRouter>);
  expect(await screen.findByText("a paper block")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.queryByText("should not render")).toBeNull();
});

it("close button fires onClose", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [])]]);
  const onClose = vi.fn();
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={onClose} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "close panel" }));
  expect(onClose).toHaveBeenCalledOnce();
});
