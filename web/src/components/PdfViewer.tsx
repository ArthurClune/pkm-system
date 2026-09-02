// pattern: Imperative Shell
// PDF.js (via react-pdf) viewer for /assets/*.pdf links: a fixed-height
// scrollable frame rendering every page fit-to-width, plus a fullscreen
// overlay reading mode. Offscreen pages are sized placeholders until they
// near the viewport (IntersectionObserver), and go back to being
// placeholders once the scroll leaves them behind, so a long document
// rasterizes neither every canvas up front nor every canvas it has passed.
// Text/annotation layers are disabled -- this is deliberately a scroll-only
// viewer (pkm-srek spec).
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
import { currentPageFromRatios, focusWrapTarget, mountedPageWindow,
         placeholderHeight, retainPages } from "./pdfViewerCore";

/** How many pages either side of one the mount observer reports near the
 * viewport stay mounted. The observer's own 150% rootMargin already covers
 * roughly a viewport and a half; this is the slack on top of it, so a small
 * scroll never unmounts a page it is about to need again. */
const MOUNT_RADIUS = 3;

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

function PdfPages({ numPages, aspect, onCurrentPage, scrollRegionLabel }: {
  numPages: number;
  aspect: number | null;
  onCurrentPage: (page: number) => void;
  /** When set, the frame becomes an explicit, labelled tab stop. The
   * overlay needs this: its focus trap only cycles through explicit
   * tabindexes, so without one a keyboard user could never reach the frame
   * to scroll the document. The inline frame relies on the browsers'
   * native scrollable-container tab stop instead. */
  scrollRegionLabel?: string;
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
  // which pages the mount observer currently reports inside its margin,
  // accumulated because an IntersectionObserver callback carries only the
  // pages whose intersection CHANGED
  const nearRef = useRef(new Set<number>());

  // fit-to-width: track the frame's content width
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One observer mounts pages as they approach (generous margin) and
  // unmounts those the scroll left behind; a second tracks visible fractions
  // for the "Page x of y" indicator.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const pageOf = (t: Element) => Number((t as HTMLElement).dataset.page);
    nearRef.current.clear(); // a new document's slots are all fresh
    const mounter = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) nearRef.current.add(pageOf(e.target));
          else nearRef.current.delete(pageOf(e.target));
        }
        // Nothing near at all is the pre-first-callback state, not a real
        // scroll position: keep whatever is mounted rather than collapsing
        // the document to page 1.
        if (nearRef.current.size === 0) return;
        const next = mountedPageWindow(nearRef.current, numPages, MOUNT_RADIUS);
        setMounted(next);
        // An unmounted page's canvas is gone, so it must go back to being a
        // sized placeholder -- both to keep the scrollbar geometry and so it
        // isn't briefly zero-height if the scroll comes back to it.
        setRendered((prev) => retainPages(prev, next));
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
    <div
      className="pdf-frame"
      ref={frameRef}
      tabIndex={scrollRegionLabel === undefined ? undefined : 0}
      role={scrollRegionLabel === undefined ? undefined : "region"}
      aria-label={scrollRegionLabel}
    >
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

/** Everything the overlay's focus trap can land on. Scoped to what this
 * overlay actually contains (links, buttons, the tabindexed scroll frame) --
 * extend it before adding other control types (inputs, contenteditable) to
 * the overlay chrome. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Inline-then-expand viewer for PDF embeds in block content. With `onClose`
 * set it instead renders as a fullscreen overlay dialog from the first
 * frame (no inline frame, no Expand): the /files browser uses this so a PDF
 * card opens in-app on every surface -- in the iOS standalone PWA a plain
 * same-origin navigation would take over the app with no way back. In that
 * mode Close/Escape call `onClose`; the parent owns unmounting.
 */
export function PdfViewer({ href, label, onClose }:
    { href: string; label: string; onClose?: () => void }) {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const overlayRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Generation guard + per-document state reset, both done synchronously
  // during render rather than in an effect. A new href is a new document:
  // the previous one's metadata, failure, expansion, and page state must
  // not survive the switch, and a slow completion from the old document
  // must not be able to write into the new one's state once it does
  // switch. An effect can't safely do the reset here: effects fire
  // child-before-parent, so a same-tick synchronous load completion in the
  // Document child (as in this component's own tests, and possibly a
  // cached real load) would run *before* a reset effect in this parent and
  // get wiped out again. Resetting inline during render sidesteps that
  // ordering hazard entirely -- this is React's documented pattern for
  // "adjusting state when a prop changes" (it re-renders once, before
  // commit, so the Document child never observes the stale state).
  const genRef = useRef(0);
  const prevHrefRef = useRef(href);
  if (prevHrefRef.current !== href) {
    prevHrefRef.current = href;
    genRef.current += 1;
    setDoc(null);
    setFailed(false);
    setExpanded(false);
    setCurrentPage(1);
  }
  const gen = genRef.current;

  // Overlay-only mode never renders the inline frame, so its dialog is
  // "open" for the component's whole lifetime.
  const overlayOpen = onClose !== undefined || expanded;
  // Latest dismiss action for the modal-behaviour effect, held in a ref so
  // an unstable onClose prop can't re-run the effect (which would re-steal
  // focus to Close on every parent render).
  const dismissRef = useRef<() => void>(() => {});
  dismissRef.current = onClose ?? (() => setExpanded(false));

  // Modal behaviour while the overlay is open: focus moves into the dialog
  // (and back to Expand on close, when Expand exists), Tab is trapped inside
  // it, Escape dismisses it, and the page behind can't scroll. The listener
  // lives on window because clicks on non-focusable overlay content can drop
  // focus to <body>, where a dialog-scoped handler would miss the next Tab.
  useEffect(() => {
    if (!overlayOpen) return;
    const expandButton = expandRef.current;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismissRef.current();
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
  }, [overlayOpen]);

  const onLoadSuccess = (pdf: LoadedPdf) => {
    if (gen !== genRef.current) return; // stale: href moved on before this load finished
    setDoc({ numPages: pdf.numPages, aspect: null });
    pdf.getPage(1).then(
      (page) => {
        if (gen !== genRef.current) return; // stale: href moved on while getPage(1) was in flight
        const v = page.getViewport({ scale: 1 });
        setDoc({ numPages: pdf.numPages, aspect: v.height / v.width });
      },
      () => {
        // keep the default aspect; placeholders are approximate anyway --
        // no gen guard needed here since this branch never calls setState
      },
    );
  };

  const onLoadError = () => {
    if (gen !== genRef.current) return; // stale: href moved on before this load failed
    setFailed(true);
  };

  if (onClose !== undefined) {
    return createPortal(
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
          {doc !== null && (
            <span className="pdf-page-indicator">
              Page {currentPage} of {doc.numPages}
            </span>
          )}
          <a href={href} download className="pdf-download">Download</a>
          <button type="button" className="btn-secondary" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
        {failed ? (
          <PdfFallbackLink href={href} label={label} note="Couldn't render this PDF." />
        ) : (
          <Document
            file={href}
            onLoadSuccess={onLoadSuccess}
            onLoadError={onLoadError}
            loading={<span className="pdf-loading-note">Loading PDF…</span>}
          >
            {doc !== null && (
              <PdfPages
                numPages={doc.numPages}
                aspect={doc.aspect}
                onCurrentPage={setCurrentPage}
                scrollRegionLabel={label || "PDF"}
              />
            )}
          </Document>
        )}
      </div>,
      document.body,
    );
  }

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
        onLoadError={onLoadError}
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
            <PdfPages
              numPages={doc.numPages}
              aspect={doc.aspect}
              onCurrentPage={setCurrentPage}
              scrollRegionLabel={label || "PDF"}
            />
          </div>,
          document.body,
        )}
      </Document>
    </span>
  );
}
