import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "./test-helpers";
import { App } from "./App";

class NoopObserver {
  constructor(_cb: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NoopObserver));
afterEach(() => vi.unstubAllGlobals());

it("shift-click stacks sidebar panels newest-first; close removes one", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/AI", pagePayload("AI", [block("uid_s2", "ai body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]] and [[AI]]")])],
  ]);
  render(
    <MemoryRouter initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "AI" }), { shiftKey: true });
  expect(await screen.findByText("ai body")).toBeInTheDocument();

  const panels = screen.getAllByRole("region"); // section elements with aria-label
  expect(within(panels[0]).getByText("ai body")).toBeInTheDocument(); // newest on top

  fireEvent.click(within(panels[0]).getByRole("button", { name: "close panel" }));
  expect(screen.queryByText("ai body")).toBeNull();
  expect(screen.getByText("paper body")).toBeInTheDocument();
});

it("cmd-u opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", metaKey: true });
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("ctrl-u opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "u", ctrlKey: true });
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});

it("cmd-k no longer opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.queryByPlaceholderText("Search…")).toBeNull();
});

it("ctrl-cmd-d navigates to the home page", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/journal", { days: [] }],
  ]);
  render(<MemoryRouter initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Paper" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, metaKey: true });
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "Paper" })).toBeNull();
  });
});

it("unknown route renders the not-found view", () => {
  stubFetch([]);
  render(<MemoryRouter initialEntries={["/definitely/not/a/route"]}><App /></MemoryRouter>);
  expect(screen.getByText("Page not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" })).toBeInTheDocument();
});
