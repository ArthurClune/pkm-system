// pattern: Imperative Shell
// PDF.js (via react-pdf) viewer for /assets/*.pdf links: a fixed-height
// scrollable frame rendering every page fit-to-width, plus a fullscreen
// overlay reading mode. Offscreen pages are sized placeholders until they
// near the viewport (IntersectionObserver), so long documents don't
// rasterize every canvas up front. Text/annotation layers are disabled --
// this is deliberately a scroll-only viewer (pkm-srek spec).
//
// This module is loaded lazily by PdfEmbed (dynamic import), so react-pdf/
// pdfjs-dist stay out of the eager entry chunk. The worker resolves to a
// same-origin emitted build asset (precached by the service worker), so
// rendering works offline whenever the PDF asset itself is in the runtime
// asset cache.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import { PdfFallbackLink } from "./PdfFallbackLink";
import { currentPageFromRatios, focusWrapTarget, placeholderHeight } from "./pdfViewerCore";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** The slice of pdf.js's PDFDocumentProxy this viewer reads. Structural on
 * purpose: pdfjs-dist is a transitive (react-pdf-pinned) dependency, so its
 * types aren't importable under pnpm's strict node_modules. */
interface LoadedPdf {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(opts: { scale: number }): { width: number; height: number };
  }>;
}

interface DocState {
  numPages: number;
  /** height/width of page 1 at scale 1, for placeholder sizing; null until
   * measured (all pages assumed uniform -- corrected when each renders). */
  aspect: number | null;
}

function PdfPages({ numPages, aspect, onCurrentPage }: {
  numPages: number;
  aspect: number | null;
  onCurrentPage: (page: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // page 1 mounts eagerly so something renders before any observer fires
  const [mounted, setMounted] = useState<ReadonlySet<number>>(new Set([1]));
  // pages whose canvas has rasterized: their real height replaces the
  // placeholder minHeight, so mixed-page-size PDFs don't keep page-1-shaped
  // whitespace under shorter pages
  const [rendered, setRendered] = useState<ReadonlySet<number>>(new Set());
  const ratiosRef = useRef(new Map<number, number>());

  // fit-to-width: track the frame's content width
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One observer mounts pages as they approach (generous margin); a second
  // tracks visible fractions for the "Page x of y" indicator.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const pageOf = (t: Element) => Number((t as HTMLElement).dataset.page);
    const mounter = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).map((e) => pageOf(e.target));
        if (seen.length === 0) return;
        setMounted((prev) => {
          const next = new Set(prev);
          for (const p of seen) next.add(p);
          return next;
        });
      },
      { root: frame, rootMargin: "150% 0px" },
    );
    const tracker = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratiosRef.current.set(pageOf(e.target), e.intersectionRatio);
        onCurrentPage(currentPageFromRatios(ratiosRef.current));
      },
      { root: frame, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const slot of frame.querySelectorAll("[data-page]")) {
      mounter.observe(slot);
      tracker.observe(slot);
    }
    return () => {
      mounter.disconnect();
      tracker.disconnect();
    };
  }, [numPages, onCurrentPage]);

  return (
    <div className="pdf-frame" ref={frameRef}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          className="pdf-page-slot"
          data-page={n}
          style={{ minHeight: rendered.has(n) ? undefined : placeholderHeight(width, aspect) }}
        >
          {mounted.has(n) && (
            <Page
              pageNumber={n}
              width={width > 0 ? width : undefined}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              onRenderSuccess={() =>
                setRendered((prev) => (prev.has(n) ? prev : new Set(prev).add(n)))
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Everything the overlay's focus trap can land on. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PdfViewer({ href, label }: { href: string; label: string }) {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const overlayRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal behaviour while expanded: focus moves into the dialog (and back to
  // Expand on close), Tab is trapped inside it, Escape closes it, and the
  // page behind can't scroll. The listener lives on window because clicks on
  // non-focusable overlay content can drop focus to <body>, where a dialog-
  // scoped handler would miss the next Tab.
  useEffect(() => {
    if (!expanded) return;
    const expandButton = expandRef.current;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false);
        return;
      }
      if (e.key !== "Tab" || !overlayRef.current) return;
      const focusables = Array.from(overlayRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const target = focusWrapTarget(
        focusables,
        document.activeElement as HTMLElement | null,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      expandButton?.focus();
    };
  }, [expanded]);

  const onLoadSuccess = (pdf: LoadedPdf) => {
    setDoc({ numPages: pdf.numPages, aspect: null });
    pdf.getPage(1).then(
      (page) => {
        const v = page.getViewport({ scale: 1 });
        setDoc({ numPages: pdf.numPages, aspect: v.height / v.width });
      },
      () => {
        // keep the default aspect; placeholders are approximate anyway
      },
    );
  };

  if (failed) {
    return <PdfFallbackLink href={href} label={label} note="Couldn't render this PDF." />;
  }

  return (
    // The whole viewer is an interactive island: it renders inside
    // EditableBlockTree's `.block-text`, whose unconditional onClick
    // re-enters block-edit mode and unmounts this component. Every click
    // anywhere in here (frame, footer, Expand, Download) must be stopped
    // here, once, rather than patched per-element -- otherwise a native
    // <embed> would have swallowed the click, but this viewer's DOM
    // doesn't.
    <span className="pdf-embed" onClick={(e) => e.stopPropagation()}>
      <Document
        file={href}
        onLoadSuccess={onLoadSuccess}
        onLoadError={() => setFailed(true)}
        loading={<span className="pdf-loading-note">Loading PDF…</span>}
      >
        {doc !== null && !expanded && (
          <PdfPages numPages={doc.numPages} aspect={doc.aspect} onCurrentPage={setCurrentPage} />
        )}
        {doc !== null && (
          <span className="pdf-footer">
            <span className="pdf-page-indicator">
              Page {currentPage} of {doc.numPages}
            </span>
            <a href={href} download className="pdf-download">
              {label || "Download PDF"}
            </a>
            <button
              type="button"
              className="btn-secondary"
              ref={expandRef}
              onClick={() => setExpanded(true)}
            >
              Expand
            </button>
          </span>
        )}
        {doc !== null && expanded && createPortal(
          // Portalled to document.body, but React portals propagate
          // synthetic events through the REACT tree, not the DOM tree -- so
          // this is still a descendant of `.block-text` for bubbling
          // purposes and needs its own containment (see the .pdf-embed
          // handler above for the full hazard).
          <div
            className="pdf-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={label || "PDF"}
            ref={overlayRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pdf-overlay-bar">
              <span className="pdf-overlay-title">{label || "PDF"}</span>
              <span className="pdf-page-indicator">
                Page {currentPage} of {doc.numPages}
              </span>
              <a href={href} download className="pdf-download">Download</a>
              <button
                type="button"
                className="btn-secondary"
                ref={closeRef}
                onClick={() => setExpanded(false)}
              >
                Close
              </button>
            </div>
            <PdfPages numPages={doc.numPages} aspect={doc.aspect} onCurrentPage={setCurrentPage} />
          </div>,
          document.body,
        )}
      </Document>
    </span>
  );
}
