import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ---- observer stubs --------------------------------------------------
type IOEntry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
type IOCallback = (entries: IOEntry[]) => void;
const observers: Array<{ cb: IOCallback; opts?: IntersectionObserverInit; targets: Element[] }> = [];

class FakeIntersectionObserver {
  cb: IOCallback;
  opts?: IntersectionObserverInit;
  targets: Element[] = [];
  constructor(cb: IOCallback, opts?: IntersectionObserverInit) {
    this.cb = cb;
    this.opts = opts;
    observers.push(this);
  }
  observe(t: Element) { this.targets.push(t); }
  unobserve() {}
  disconnect() {}
}
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The mount observer is the one created with a rootMargin; the indicator
// observer is the one with a threshold array.
const mountObserver = () => observers.find((o) => o.opts?.rootMargin !== undefined)!;
const indicatorObserver = () => observers.find((o) => Array.isArray(o.opts?.threshold))!;

const slotEntry = (page: number, ratio: number): IOEntry => {
  const target = document.querySelector(`[data-page="${page}"]`)!;
  return { target, isIntersecting: ratio > 0, intersectionRatio: ratio };
};

// ---- react-pdf mock --------------------------------------------------
let failLoad = false;
vi.mock("react-pdf", async () => {
  const { useEffect } = await import("react");
  const fakePdf = {
    numPages: 3,
    getPage: () =>
      Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) }),
  };
  function Document({ onLoadSuccess, onLoadError, children }: {
    onLoadSuccess?: (pdf: typeof fakePdf) => void;
    onLoadError?: (err: Error) => void;
    children?: ReactNode;
  }) {
    useEffect(() => {
      if (failLoad) onLoadError?.(new Error("bad pdf"));
      else onLoadSuccess?.(fakePdf);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="pdf-document">{children}</div>;
  }
  function Page({ pageNumber, onRenderSuccess }: {
    pageNumber: number;
    onRenderSuccess?: () => void;
  }) {
    // the real react-pdf Page fires this once the canvas has rasterized
    useEffect(() => {
      onRenderSuccess?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <canvas data-testid={`page-${pageNumber}`} />;
  }
  return { Document, Page, pdfjs: { GlobalWorkerOptions: {} } };
});

import { PdfViewer } from "./PdfViewer";

const href = `/assets/${"ab".repeat(32)}/doc.pdf`;

beforeEach(() => {
  failLoad = false;
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

async function renderLoaded() {
  render(<PdfViewer href={href} label="Notes" />);
  // let the mock Document's onLoadSuccess effect and getPage(1) settle
  await act(async () => {});
}

it("renders page 1 eagerly and placeholders for the rest", async () => {
  await renderLoaded();
  expect(screen.getByTestId("page-1")).toBeInTheDocument();
  expect(screen.queryByTestId("page-2")).toBeNull();
  expect(document.querySelectorAll("[data-page]")).toHaveLength(3);
  expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
});

it("mounts a page when the mount observer sees it approach", async () => {
  await renderLoaded();
  act(() => mountObserver().cb([slotEntry(3, 0.01)]));
  expect(screen.getByTestId("page-3")).toBeInTheDocument();
});

it("drops the placeholder minHeight once a page has rendered", async () => {
  // Placeholder heights assume all pages match page 1; a rendered canvas is
  // the real height, so keeping minHeight leaves trailing whitespace under
  // shorter pages in mixed-page-size PDFs.
  await renderLoaded();
  const slot1 = document.querySelector('[data-page="1"]') as HTMLElement;
  const slot2 = document.querySelector('[data-page="2"]') as HTMLElement;
  expect(slot1.style.minHeight).toBe(""); // page 1 rendered: canvas owns the height
  expect(slot2.style.minHeight).not.toBe(""); // still an unrendered placeholder
});

it("updates the indicator to the most-visible page", async () => {
  await renderLoaded();
  act(() => indicatorObserver().cb([slotEntry(1, 0.1), slotEntry(3, 0.9)]));
  expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
});

it("expand opens the fullscreen overlay and Escape closes it", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector(".pdf-overlay")).toBeNull();
});

it("the Close button also collapses the overlay", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(document.querySelector(".pdf-overlay")).toBeNull();
});

it("the overlay is an aria-modal dialog", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const overlay = document.querySelector(".pdf-overlay")!;
  expect(overlay).toHaveAttribute("role", "dialog");
  expect(overlay).toHaveAttribute("aria-modal", "true");
});

it("focus moves into the dialog on open and returns to Expand on close", async () => {
  await renderLoaded();
  const expand = screen.getByRole("button", { name: "Expand" });
  expand.focus();
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(expand).toHaveFocus();
});

it("Tab wraps focus from the last overlay control to the first, and Shift+Tab back", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const download = screen.getByRole("link", { name: "Download" });
  const close = screen.getByRole("button", { name: "Close" });
  // Close (focused on open) is the last focusable; Tab wraps to Download
  fireEvent.keyDown(window, { key: "Tab" });
  expect(download).toHaveFocus();
  // Download is the first focusable; Shift+Tab wraps back to Close
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(close).toHaveFocus();
});

it("pulls focus back into the dialog when Tab arrives from outside it", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(screen.getByRole("link", { name: "Download" })).toHaveFocus();
});

it("locks body scrolling while the overlay is open and restores the prior value", async () => {
  document.body.style.overflow = "auto";
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});

it("no click anywhere in the viewer bubbles to an enclosing block's click-to-edit handler", async () => {
  // Regression test for pkm-srek: a real block renders this viewer inside
  // EditableBlockTree's `.block-text`, which has its own onClick that
  // re-enters edit mode (and would unmount this viewer, along with any
  // `expanded` state, before the overlay ever renders) unless every click
  // target inside the viewer -- including the portalled overlay, since React
  // portals propagate synthetic events through the REACT tree, not the DOM
  // tree -- stops propagation. The whole viewer is an interactive island.
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <PdfViewer href={href} label="Notes" />
    </div>,
  );
  await act(async () => {});

  // inline footer: Download anchor click must not enter edit mode
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  expect(onParentClick).not.toHaveBeenCalled();

  // overlay content other than Close: bar background, title, page
  // indicator, Download -- none of these may close the overlay or bubble.
  fireEvent.click(document.querySelector(".pdf-overlay-bar")!);
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(document.querySelector(".pdf-overlay-title")!);
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("link", { name: "Download" }));
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(document.querySelector(".pdf-overlay")).toBeNull();
  expect(onParentClick).not.toHaveBeenCalled();
});

it("falls back to the download link when the document fails to load", async () => {
  failLoad = true;
  render(<PdfViewer href={href} label="Notes" />);
  await act(async () => {});
  expect(screen.getByText("Couldn't render this PDF.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  expect(screen.queryByTestId("pdf-document")).toBeNull();
});
