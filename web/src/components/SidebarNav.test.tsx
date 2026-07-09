import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { SidebarNav } from "./SidebarNav";

afterEach(() => vi.unstubAllGlobals());

it("renders entries in the order returned by the API, as page links", async () => {
  stubFetch([["/api/sidebar", { entries: [
    { id: 2, title: "AWS" }, { id: 1, title: "AI" },
  ] }]]);
  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  const links = await screen.findAllByRole("link");
  expect(links.map((l) => l.textContent)).toEqual(["AWS", "AI"]);
  expect(links[0]).toHaveAttribute("href", "/page/AWS");
});

it("renders nothing when there are no entries", async () => {
  stubFetch([["/api/sidebar", { entries: [] }]]);
  const { container } = render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await Promise.resolve();
  expect(container.querySelector("ul")).toBeNull();
});

it("calls onNavigate when an entry link is clicked", async () => {
  stubFetch([["/api/sidebar", { entries: [{ id: 1, title: "AI" }] }]]);
  const onNavigate = vi.fn();
  render(<MemoryRouter><SidebarNav onNavigate={onNavigate} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("link", { name: "AI" }));
  expect(onNavigate).toHaveBeenCalledOnce();
});

it("shows a quiet error and no crash when the fetch fails", async () => {
  stubFetch([]); // unmatched -> 404
  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
});
