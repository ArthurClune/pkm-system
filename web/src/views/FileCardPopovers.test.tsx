import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { apiGet } from "../api/typedClient";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { MISSING_BLOCK_TEXT } from "./filesCore";
import { FileDescriptionPopover, FileRefsPopover } from "./FileCardPopovers";

vi.mock("../api/typedClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/typedClient")>();
  return { ...actual, apiGet: vi.fn() };
});
const mockApiGet = vi.mocked(apiGet);

// Same location-probe pattern as BlockRefBacklinksPopover.test.tsx.
function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/files"]}>
      {children}
      <Probe />
    </MemoryRouter>
  );
}

afterEach(() => {
  mockApiGet.mockReset();
  vi.restoreAllMocks();
});

const REFS = [
  { uid: "a1", page_title: "Alpha" },
  { uid: "b1", page_title: "Beta" },
];

it("fetches block text and renders refs grouped by page", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
    b1: { text: "beta mentions it", page_title: "Beta" },
  } });
  render(<FileRefsPopover refs={REFS} x={10} y={20} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText("alpha mentions it")).toBeInTheDocument();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("beta mentions it")).toBeInTheDocument();
  expect(mockApiGet).toHaveBeenCalledWith(
    "/api/block-refs", { query: { uids: "a1,b1" } });
});

it("navigates to the referencing block on click, and closes", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
    b1: { text: "beta mentions it", page_title: "Beta" },
  } });
  const onClose = vi.fn();
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={onClose} />,
         { wrapper });
  fireEvent.click(await screen.findByRole("link",
                                          { name: "alpha mentions it" }));
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Alpha#a1");
});

it("renders a placeholder row for a uid the endpoint omitted", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
  } });
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText(MISSING_BLOCK_TEXT)).toBeInTheDocument();
});

it("falls back to page-title-only rows when the fetch fails", async () => {
  mockApiGet.mockRejectedValueOnce(new Error("boom"));
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText(/could not load block text/i))
    .toBeInTheDocument();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getAllByText(MISSING_BLOCK_TEXT)).toHaveLength(2);
});

it("Escape and outside mousedown close the refs popover", async () => {
  mockApiGet.mockResolvedValue({ block_ref_texts: {} });
  const onClose = vi.fn();
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={onClose} />,
         { wrapper });
  await screen.findAllByText(MISSING_BLOCK_TEXT);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("shows the description without any fetch", () => {
  render(<FileDescriptionPopover label="Description"
                                 text="a bar chart of monthly revenue"
                                 x={5} y={5} onClose={vi.fn()} />,
         { wrapper });
  expect(screen.getByRole("dialog", { name: "Description" }))
    .toHaveTextContent("a bar chart of monthly revenue");
  expect(mockApiGet).not.toHaveBeenCalled();
});

it("clamps into the viewport like the block-ref popover", async () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 480, height: 300, x: 0, y: 0, top: 0, left: 0,
    right: 480, bottom: 300, toJSON: () => ({}),
  } as DOMRect);
  render(<FileDescriptionPopover label="Description" text="wide"
                                 x={2000} y={1500} onClose={vi.fn()} />,
         { wrapper });
  const popover = screen.getByRole("dialog", { name: "Description" });
  expect(popover.style.left).toBe(`${1024 - 480 - 12}px`);
  expect(popover.style.top).toBe(`${768 - 300 - 12}px`);
});
