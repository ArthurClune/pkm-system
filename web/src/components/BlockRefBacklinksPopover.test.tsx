import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { apiGet } from "../api/typedClient";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { BlockRefBacklinksPopover } from "./BlockRefBacklinksPopover";

vi.mock("../api/typedClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/typedClient")>();
  return { ...actual, apiGet: vi.fn() };
});
const mockApiGet = vi.mocked(apiGet);

// Same location-probe pattern as BlockRef.test.tsx: assert where a click
// actually navigated to, not just that some handler fired.
function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      {children}
      <Probe />
    </MemoryRouter>
  );
}

afterEach(() => {
  mockApiGet.mockReset();
});

it("fetches and renders referencing blocks", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [{
    page_id: 2, page_title: "Source Page",
    items: [{ uid: "uid_s1", text: "see ((uid_t1))", breadcrumbs: ["Parent"] }],
  }] });
  render(<BlockRefBacklinksPopover uid="uid_t1" x={10} y={20}
                                   onClose={vi.fn()} />, { wrapper });
  expect(await screen.findByText("Source Page")).toBeInTheDocument();
  expect(screen.getByText("Parent")).toBeInTheDocument();
  expect(mockApiGet).toHaveBeenCalledWith(
    "/api/block/{uid}/backlinks", { path: { uid: "uid_t1" } });
});

it("shows a verbose error when the fetch fails", async () => {
  mockApiGet.mockRejectedValueOnce(new Error("boom"));
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={vi.fn()} />, { wrapper });
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
});

it("shows a stale-badge message when there are no references", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [] });
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={vi.fn()} />, { wrapper });
  expect(await screen.findByText(/no references.*badge may be stale/i)).toBeInTheDocument();
});

it("Escape closes", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [] });
  const onClose = vi.fn();
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={onClose} />, { wrapper });
  await screen.findByText(/no.*references/i);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("outside mousedown closes", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [] });
  const onClose = vi.fn();
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={onClose} />, { wrapper });
  await screen.findByText(/no.*references/i);
  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalled();
});

it("navigates on Enter when the item itself is focused", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [{
    page_id: 2, page_title: "Source Page",
    items: [{ uid: "uid_s1", text: "mentions it here", breadcrumbs: [] }],
  }] });
  const onClose = vi.fn();
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={onClose} />, { wrapper });
  const item = await screen.findByRole("link", { name: "mentions it here" });
  fireEvent.keyDown(item, { key: "Enter" });
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Source%20Page#uid_s1");
});

it("navigates to the referencing page and hash on click, and closes", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [{
    page_id: 2, page_title: "Source Page",
    items: [{ uid: "uid_s1", text: "mentions it here", breadcrumbs: [] }],
  }] });
  const onClose = vi.fn();
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={onClose} />, { wrapper });
  fireEvent.click(await screen.findByRole("link", { name: "mentions it here" }));
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Source%20Page#uid_s1");
});
