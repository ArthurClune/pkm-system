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
  function Page({ pageNumber }: { pageNumber: number }) {
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

it("falls back to the download link when the document fails to load", async () => {
  failLoad = true;
  render(<PdfViewer href={href} label="Notes" />);
  await act(async () => {});
  expect(screen.getByText("Couldn't render this PDF.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  expect(screen.queryByTestId("pdf-document")).toBeNull();
});
