import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

// The real PdfViewer drags react-pdf/pdfjs into jsdom; the overlay's own
// focus and Escape handling comes from useModal, which the stand-in keeps.
vi.mock("./PdfViewer", async () => {
  const { useRef } = await import("react");
  const { createPortal } = await import("react-dom");
  const { useModal } = await import("../useModal");
  return {
    PdfViewer: function MockViewer({ label, onClose }: {
      label: string; onClose: () => void;
    }) {
      const surfaceRef = useRef<HTMLDivElement>(null);
      const closeRef = useRef<HTMLButtonElement>(null);
      useModal({ surfaceRef, initialFocusRef: closeRef, onClose });
      return createPortal(
        <div role="dialog" aria-label={label} ref={surfaceRef}>
          <button type="button" ref={closeRef} onClick={onClose}>Close</button>
        </div>,
        document.body,
      );
    },
  };
});

import { CellMediaContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { pagePath } from "../paths";
import { rawTitleOf, uidOf } from "../test-helpers";
import { InlineSegments } from "./InlineSegments";

const SHA = "ab".repeat(32);
const PAGE = rawTitleOf("Reading List");
const UID = uidOf("tuid-cell1");
const MERMAID = "```mermaid\ngraph TD; A-->B\n```";

function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function renderCell(text: string, opts: {
  page?: typeof PAGE | null; cell?: boolean;
  openInSidebar?: ReturnType<typeof vi.fn>;
} = {}) {
  const { page = PAGE, cell = true, openInSidebar = vi.fn() } = opts;
  const body: ReactNode = <InlineSegments segments={tokenizeBlock(text)} />;
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        {cell
          ? <CellMediaContext.Provider value={{ page, uid: UID }}>
              {body}
            </CellMediaContext.Provider>
          : body}
      </SidebarContext.Provider>
      <Probe />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("pdf_label_replaces_the_embed", () => {
  const { container } = renderCell(`See [paper.pdf](/assets/${SHA}/paper.pdf)`);
  const label = screen.getByRole("button", {
    name: "Open PDF full screen: paper.pdf",
  });
  expect(label).toHaveTextContent("📄 paper.pdf");
  expect(container).toHaveTextContent("See");
  expect(container.querySelector(".pdf-embed")).toBeNull();
});

it("local_pdf_and_external_image_fetch_nothing_until_clicked", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { container } = renderCell(
    "{{pdf: /api/local/a.pdf}} ![](https://example.org/p.jpg)",
  );
  expect(container.querySelector("img")).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Open PDF full screen: a.pdf" }))
    .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open image full screen: p.jpg" }))
    .toBeInTheDocument();
});

it("pdf_label_opens_the_overlay_and_escape_returns_focus", async () => {
  renderCell(`[paper.pdf](/assets/${SHA}/paper.pdf)`);
  const label = screen.getByRole("button", {
    name: "Open PDF full screen: paper.pdf",
  });
  label.focus();
  fireEvent.click(label);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(label).toHaveFocus();
});

it("image_label_opens_the_image_overlay", async () => {
  renderCell(`![Bed](/assets/${SHA}/bed.png)`);
  const label = screen.getByRole("button", {
    name: "Open image full screen: Bed",
  });
  expect(label).toHaveTextContent("🖼 Bed");
  fireEvent.click(label);
  expect(screen.getByRole("dialog", { name: "Expanded image: Bed" }))
    .toBeInTheDocument();
});

it("image_that_fails_closes_and_reads_unavailable", async () => {
  renderCell(`![Bed](/assets/${SHA}/bed.png)`);
  fireEvent.click(screen.getByRole("button", {
    name: "Open image full screen: Bed",
  }));
  const dialog = screen.getByRole("dialog", { name: "Expanded image: Bed" });
  const img = dialog.querySelector("img");
  expect(img).not.toBeNull();
  fireEvent.error(img!);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Open image full screen: Bed" }))
    .toHaveTextContent("🖼 Bed (unavailable)");
});

it("line_label_navigates_and_shift_opens_the_sidebar", async () => {
  const openInSidebar = vi.fn();
  renderCell(MERMAID, { openInSidebar });
  const label = screen.getByRole("button", { name: "↗ Mermaid diagram" });
  fireEvent.click(label, { shiftKey: true });
  expect(openInSidebar).toHaveBeenCalledWith(PAGE, UID);
  expect(screen.getByTestId("loc")).toHaveTextContent("/start");
  fireEvent.click(label);
  expect(screen.getByTestId("loc"))
    .toHaveTextContent(`${pagePath(PAGE)}#${UID}`);
});

it("line_label_without_a_page_is_text", () => {
  const { container } = renderCell(MERMAID, { page: null });
  expect(screen.queryByRole("button")).toBeNull();
  expect(container).toHaveTextContent("↗ Mermaid diagram");
});

it("label_click_does_not_reach_the_cell", async () => {
  const onCellClick = vi.fn();
  render(
    <MemoryRouter>
      <div onClick={onCellClick}>
        <CellMediaContext.Provider value={{ page: PAGE, uid: UID }}>
          <InlineSegments segments={tokenizeBlock(MERMAID)} />
        </CellMediaContext.Provider>
      </div>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "↗ Mermaid diagram" }));
  expect(onCellClick).not.toHaveBeenCalled();
});

it("outside_a_cell_nothing_changes", () => {
  const { container } = renderCell(`[paper.pdf](/assets/${SHA}/paper.pdf)`,
    { cell: false });
  expect(container.querySelector(".pdf-embed, .pdf-fallback, a[href$='.pdf']"))
    .not.toBeNull();
  expect(screen.queryByRole("button", { name: /full screen/ })).toBeNull();
});
