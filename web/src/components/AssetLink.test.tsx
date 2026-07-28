// Clickable bare /assets/<sha>/<filename> URLs -- pkm-gdi5. Click resolves
// the sha to the block that references it (GET /api/search?exact=1) and
// opens THAT block; no hit (or a failed lookup) falls back to opening the
// raw asset in a new tab.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { AssetLink } from "./AssetLink";

const SHA = "492d80a8b6a72a7c4615c69a9a7def6fac0e019d452f9c88bb61ca8a671dbfd7";
const URL = `/assets/${SHA}/IMG_0868.jpeg`;

function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function mount(openInSidebar = vi.fn()) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <AssetLink url={URL} sha={SHA} filename="IMG_0868.jpeg" />
      </SidebarContext.Provider>
      <Probe />
    </MemoryRouter>,
  );
  return openInSidebar;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders the filename as a link, titled with the full asset URL", () => {
  mount();
  const link = screen.getByRole("link", { name: "IMG_0868.jpeg" });
  expect(link).toHaveAttribute("title", URL);
  expect(link).toHaveAttribute("href", URL);
});

it("click resolves the referencing block and navigates to it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({
      pages: [],
      blocks: [{ uid: "blk1", page_title: "Charts", snippet: "…" }],
    }),
  }));
  mount();
  fireEvent.click(screen.getByRole("link", { name: "IMG_0868.jpeg" }));
  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/Charts#blk1"));
  const [reqUrl] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(String(reqUrl)).toBe(`/api/search?q=${SHA}&exact=1`);
});

it("shift-click resolves the referencing block and opens it in the sidebar", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({
      pages: [],
      blocks: [{ uid: "blk1", page_title: "Charts", snippet: "…" }],
    }),
  }));
  const openInSidebar = mount();
  fireEvent.click(screen.getByRole("link", { name: "IMG_0868.jpeg" }), { shiftKey: true });
  await waitFor(() => expect(openInSidebar).toHaveBeenCalledWith("Charts", "blk1"));
  // never navigated the main window
  expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/);
});

it("Enter on a focused link behaves like a click", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({
      pages: [],
      blocks: [{ uid: "blk1", page_title: "Charts", snippet: "…" }],
    }),
  }));
  mount();
  const link = screen.getByRole("link", { name: "IMG_0868.jpeg" });
  link.focus();
  fireEvent.keyDown(link, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/Charts#blk1"));
});

it("no referencing block found: opens the raw asset instead", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ pages: [], blocks: [] }),
  }));
  const openSpy = vi.fn();
  vi.stubGlobal("open", openSpy);
  mount();
  fireEvent.click(screen.getByRole("link", { name: "IMG_0868.jpeg" }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith(URL, "_blank", "noopener"));
  expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/);
});

it("lookup failure: falls back to opening the raw asset", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false, status: 500,
    json: async () => ({ detail: "boom" }),
    clone() { return this; },
  }));
  const openSpy = vi.fn();
  vi.stubGlobal("open", openSpy);
  mount();
  fireEvent.click(screen.getByRole("link", { name: "IMG_0868.jpeg" }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith(URL, "_blank", "noopener"));
});
