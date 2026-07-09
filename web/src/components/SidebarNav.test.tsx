import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse, stubFetch } from "../test-helpers";
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

it("hides add/remove/reorder controls until edit mode is toggled on", async () => {
  stubFetch([["/api/sidebar", { entries: [{ id: 1, title: "AWS" }] }]]);
  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await screen.findByRole("link", { name: "AWS" });

  expect(screen.queryByPlaceholderText(/add page/i)).toBeNull();
  expect(screen.queryByRole("button", { name: /remove aws/i })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  expect(screen.getByPlaceholderText(/add page/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /remove aws/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
  expect(screen.queryByPlaceholderText(/add page/i)).toBeNull();
});

it("adding an entry posts the title and refreshes the list", async () => {
  let sidebarGets = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/sidebar" && method === "GET") {
      sidebarGets += 1;
      return jsonResponse({ entries: sidebarGets === 1
        ? [{ id: 1, title: "AWS" }]
        : [{ id: 1, title: "AWS" }, { id: 2, title: "Crypto" }] });
    }
    if (url === "/api/sidebar" && method === "POST") {
      expect(JSON.parse(String(init?.body))).toEqual({ title: "Crypto" });
      return jsonResponse({ id: 2, title: "Crypto" });
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);

  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await screen.findByRole("link", { name: "AWS" });
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByPlaceholderText(/add page/i), { target: { value: "Crypto" } });
  fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

  await screen.findByRole("link", { name: "Crypto" });
  expect(sidebarGets).toBe(2);
});

it("removing an entry deletes it and refreshes the list", async () => {
  let sidebarGets = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/sidebar" && method === "GET") {
      sidebarGets += 1;
      return jsonResponse({ entries: sidebarGets === 1
        ? [{ id: 1, title: "AWS" }, { id: 2, title: "AI" }]
        : [{ id: 2, title: "AI" }] });
    }
    if (url === "/api/sidebar/1" && method === "DELETE") {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);

  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await screen.findByRole("link", { name: "AWS" });
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  fireEvent.click(screen.getByRole("button", { name: /remove aws/i }));

  await screen.findByRole("link", { name: "AI" });
  expect(screen.queryByRole("link", { name: "AWS" })).toBeNull();
});

it("moving an entry down calls the reorder API with the new order", async () => {
  let sidebarGets = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/sidebar" && method === "GET") {
      sidebarGets += 1;
      return jsonResponse({ entries: sidebarGets === 1
        ? [{ id: 1, title: "AWS" }, { id: 2, title: "AI" }]
        : [{ id: 2, title: "AI" }, { id: 1, title: "AWS" }] });
    }
    if (url === "/api/sidebar" && method === "PUT") {
      expect(JSON.parse(String(init?.body))).toEqual({ order: [2, 1] });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);

  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await screen.findByRole("link", { name: "AWS" });
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  fireEvent.click(screen.getByRole("button", { name: /move aws down/i }));

  await waitFor(() => {
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["AI", "AWS"]);
  });
});

it("disables the up button on the first entry and the down button on the last", async () => {
  stubFetch([["/api/sidebar", { entries: [
    { id: 1, title: "AWS" }, { id: 2, title: "AI" },
  ] }]]);
  render(<MemoryRouter><SidebarNav /></MemoryRouter>);
  await screen.findByRole("link", { name: "AWS" });
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

  expect(screen.getByRole("button", { name: /move aws up/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /move ai down/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /move aws down/i })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: /move ai up/i })).not.toBeDisabled();
});
