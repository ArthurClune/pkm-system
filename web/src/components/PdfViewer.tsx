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
import { currentPageFromRatios, placeholderHeight } from "./pdfViewerCore";

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
          style={{ minHeight: placeholderHeight(width, aspect) }}
        >
          {mounted.has(n) && (
            <Page
              pageNumber={n}
              width={width > 0 ? width : undefined}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function PdfViewer({ href, label }: { href: string; label: string }) {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    <span className="pdf-embed">
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
            <button type="button" className="btn-secondary" onClick={(e) => {
              // Stop the click from bubbling to the enclosing block's
              // click-to-edit handler (EditableBlockTree) -- otherwise the
              // block re-enters edit mode and unmounts this viewer (and the
              // expanded state we're about to set) before the overlay renders.
              e.stopPropagation();
              setExpanded(true);
            }}>
              Expand
            </button>
          </span>
        )}
        {doc !== null && expanded && createPortal(
          <div className="pdf-overlay" role="dialog" aria-label={label || "PDF"}>
            <div className="pdf-overlay-bar">
              <span className="pdf-overlay-title">{label || "PDF"}</span>
              <span className="pdf-page-indicator">
                Page {currentPage} of {doc.numPages}
              </span>
              <a href={href} download className="pdf-download">Download</a>
              <button type="button" className="btn-secondary" onClick={(e) => {
                // Same bubbling hazard as the Expand button above -- the
                // overlay is portalled to document.body, but this button is
                // still a descendant of the block in the React tree.
                e.stopPropagation();
                setExpanded(false);
              }}>
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
