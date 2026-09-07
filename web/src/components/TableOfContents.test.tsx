// The rendered side of {{toc}} (pkm-mzks): a nested list of links to
// #<uid>, which the page's existing hash scroll-and-flash consumes.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { TableOfContents } from "./TableOfContents";
import type { TocEntry } from "./tocEntries";

function entry(uid: string, text: string, level: 1 | 2 | 3,
               children: TocEntry[] = []): TocEntry {
  return { uid, text, level, children };
}

function mount(entries: TocEntry[]) {
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Notes"]}>
      <TableOfContents entries={entries} />
    </MemoryRouter>);
  return container;
}

it("renders a nested list of links, each pointing at its block's hash", () => {
  const container = mount([
    entry("aaa", "Intro", 1),
    entry("bbb", "Setup", 1, [entry("ccc", "Install", 2)]),
  ]);

  const links = Array.from(container.querySelectorAll("a.toc-link"));
  expect(links.map((a) => a.textContent))
    .toEqual(["Intro", "Setup", "Install"]);
  // The router resolves a hash-only target against the current location, so
  // an entry stays on this page and only sets the hash PageView watches.
  expect(links.map((a) => a.getAttribute("href")))
    .toEqual(["/page/Notes#aaa", "/page/Notes#bbb", "/page/Notes#ccc"]);
  // "Install" is nested inside the "Setup" item, not a sibling of it.
  const outer = container.querySelectorAll(":scope > nav > ol > li");
  expect(outer).toHaveLength(2);
  expect(Array.from(outer[1].querySelectorAll(":scope > ol > li > a"))
    .map((a) => a.textContent)).toEqual(["Install"]);
  expect(outer[0].querySelector("ol")).toBeNull();
});

it("labels the nav and marks each item with its heading level", () => {
  const container = mount([entry("aaa", "Intro", 1),
                           entry("bbb", "Deep", 3)]);
  expect(screen.getByRole("navigation", { name: "Table of contents" }))
    .toBeTruthy();
  const items = container.querySelectorAll("li.toc-item");
  expect(items[0].className).toContain("toc-level-1");
  expect(items[1].className).toContain("toc-level-3");
});

it("says so when the page has no headings", () => {
  const container = mount([]);
  expect(container.querySelector(".toc-empty")?.textContent)
    .toBe("no headings on this page");
  expect(container.querySelector("a")).toBeNull();
});
