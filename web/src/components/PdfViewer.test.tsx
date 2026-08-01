import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
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
// Manual mode lets a test control exactly when a document's load and its
// page-1 metadata resolve, independently -- needed to exercise the
// old-document-completes-late races (pkm-qs7y). Each mount/href-change of
// the mocked Document registers one entry in pendingLoads.
type Viewport = { width: number; height: number };
type LoadHandle = {
  file: string;
  resolveSuccess: (numPages: number) => void;
  resolveError: () => void;
  resolvePage: (viewport: Viewport) => void;
};
let manual = false;
const pendingLoads: LoadHandle[] = [];
// StrictMode double-invokes mount effects, so a single logical mount can
// register more than one handle for the same file -- resolve by file, not
// by index, so tests don't need to know or care how many times it fired.
const loadsFor = (file: string) => pendingLoads.filter((l) => l.file === file);
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("react-pdf", async () => {
  const { useEffect } = await import("react");
  const fakePdf = {
    numPages: 3,
    getPage: () =>
      Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) }),
  };
  function Document({ file, onLoadSuccess, onLoadError, children }: {
    file?: string;
    onLoadSuccess?: (pdf: { numPages: number; getPage: () => Promise<{ getViewport: (o: { scale: number }) => Viewport }> }) => void;
    onLoadError?: (err: Error) => void;
    children?: ReactNode;
  }) {
    useEffect(() => {
      if (manual) {
        const pageDeferred = createDeferred<{ getViewport: (o: { scale: number }) => Viewport }>();
        pendingLoads.push({
          file: file ?? "",
          resolveSuccess: (numPages) =>
            onLoadSuccess?.({ numPages, getPage: () => pageDeferred.promise }),
          resolveError: () => onLoadError?.(new Error("bad pdf")),
          resolvePage: (viewport) => pageDeferred.resolve({ getViewport: () => viewport }),
        });
        return;
      }
      if (failLoad) onLoadError?.(new Error("bad pdf"));
      else onLoadSuccess?.(fakePdf);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file]);
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
  manual = false;
  pendingLoads.length = 0;
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  // the scroll-lock test seeds a body overflow; don't leak it on failure
  document.body.style.overflow = "";
});

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

it("the overlay's scroll frame is a labelled tab stop inside the trap", async () => {
  // Browsers make scrollable containers implicit tab stops, but the trap
  // only sees explicit matches -- without a real tabindex a keyboard user
  // could never reach the frame to scroll the PDF (pkm-bqrk review).
  await renderLoaded();
  // the inline frame keeps its native (implicit) behaviour; it unmounts
  // while expanded, so check it before opening the overlay
  expect(document.querySelector(".pdf-embed .pdf-frame")).not.toHaveAttribute("tabindex");
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const frame = document.querySelector(".pdf-overlay .pdf-frame")!;
  expect(frame).toHaveAttribute("tabindex", "0");
  expect(frame).toHaveAttribute("role", "region");
  expect(frame).toHaveAttribute("aria-label", "Notes");
});

it("Tab wraps focus from the last overlay tab stop to the first, and Shift+Tab back", async () => {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const download = screen.getByRole("link", { name: "Download" });
  const frame = document.querySelector(".pdf-overlay .pdf-frame") as HTMLElement;
  // the frame is the last tab stop; Tab wraps to Download
  frame.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(download).toHaveFocus();
  // Download is the first tab stop; Shift+Tab wraps back to the frame
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(frame).toHaveFocus();
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

// ---- pkm-qs7y: reset and generation-guard on href change --------------

const href2 = `/assets/${"cd".repeat(32)}/doc2.pdf`;

it("resets expansion and page state when href changes to a new document", async () => {
  const { rerender } = render(<PdfViewer href={href} label="Notes" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  act(() => indicatorObserver().cb([slotEntry(3, 0.9)]));
  expect(document.querySelector(".pdf-overlay")).not.toBeNull();
  // both the inline footer and the overlay show the indicator while expanded
  expect(screen.getAllByText("Page 3 of 3")).toHaveLength(2);

  rerender(<PdfViewer href={href2} label="Notes 2" />);
  await act(async () => {});

  // a new href is a new document: the overlay and the stale page number from
  // the previous document must not survive the switch
  expect(document.querySelector(".pdf-overlay")).toBeNull();
  expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
});

it("a slow getPage(1) from the previous document cannot overwrite the new document's metadata", async () => {
  manual = true;
  const { rerender } = render(<PdfViewer href={href} label="A" />);
  await act(async () => {});
  expect(pendingLoads).toHaveLength(1);

  // the old document finishes loading, but its page-1 metadata is still in
  // flight when href changes
  act(() => pendingLoads[0].resolveSuccess(5));

  rerender(<PdfViewer href={href2} label="B" />);
  await act(async () => {});
  expect(pendingLoads).toHaveLength(2);

  act(() => pendingLoads[1].resolveSuccess(2));
  await act(async () => {
    pendingLoads[1].resolvePage({ width: 100, height: 200 });
  });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

  // the old document's stale getPage(1) resolves late: it must not resurrect
  // its page count or aspect for the currently-displayed document
  await act(async () => {
    pendingLoads[0].resolvePage({ width: 1, height: 999 });
  });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
});

it("a document load that finishes after href has already moved on does not resurrect its metadata", async () => {
  manual = true;
  const { rerender } = render(<PdfViewer href={href} label="A" />);
  await act(async () => {});
  expect(pendingLoads).toHaveLength(1); // the old load is registered but never resolves

  rerender(<PdfViewer href={href2} label="B" />);
  await act(async () => {});
  expect(pendingLoads).toHaveLength(2);

  act(() => pendingLoads[1].resolveSuccess(2));
  await act(async () => {
    pendingLoads[1].resolvePage({ width: 100, height: 200 });
  });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

  // the abandoned load for the old href finally completes -- too late
  act(() => pendingLoads[0].resolveSuccess(9));
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  expect(screen.queryByText(/of 9/)).toBeNull();
});

it("a stale load error from the previous document does not mark the new document as failed", async () => {
  manual = true;
  const { rerender } = render(<PdfViewer href={href} label="A" />);
  await act(async () => {});

  rerender(<PdfViewer href={href2} label="B" />);
  await act(async () => {});
  act(() => pendingLoads[1].resolveSuccess(2));
  await act(async () => {
    pendingLoads[1].resolvePage({ width: 100, height: 200 });
  });

  act(() => pendingLoads[0].resolveError());
  expect(screen.queryByText("Couldn't render this PDF.")).toBeNull();
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
});

it("StrictMode double-invocation still guards a slow getPage(1) from the previous document", async () => {
  // The render-time gen bump + reset (see PdfViewer.tsx) relies on being
  // idempotent under React's double-invoked renders/effects in StrictMode
  // (app is wrapped in it: main.tsx). Pin that down mechanically rather
  // than by reasoning, matching this codebase's convention for
  // lifecycle-order-sensitive code (SyncProvider.test.tsx, EditablePage.test.tsx).
  manual = true;
  const { rerender } = render(
    <StrictMode><PdfViewer href={href} label="A" /></StrictMode>,
  );
  await act(async () => {});
  const loadsA = loadsFor(href);
  expect(loadsA.length).toBeGreaterThan(0);
  act(() => {
    for (const l of loadsA) l.resolveSuccess(5);
  });

  rerender(<StrictMode><PdfViewer href={href2} label="B" /></StrictMode>);
  await act(async () => {});
  const loadsB = loadsFor(href2);
  expect(loadsB.length).toBeGreaterThan(0);
  act(() => {
    for (const l of loadsB) l.resolveSuccess(2);
  });
  await act(async () => {
    for (const l of loadsB) l.resolvePage({ width: 100, height: 200 });
  });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

  // the old document's stale getPage(1) resolves late, even under
  // StrictMode's extra render/effect pass -- it must not resurrect stale
  // metadata for the document now on screen
  await act(async () => {
    for (const l of loadsA) l.resolvePage({ width: 1, height: 999 });
  });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
});
