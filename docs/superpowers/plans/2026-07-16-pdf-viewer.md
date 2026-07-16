# Embedded PDF Viewer Implementation Plan (pkm-srek)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native `<embed>` PDF rendering with a PDF.js (react-pdf) viewer that scrolls multi-page PDFs inside a fixed-height card, shows a page indicator, and expands to a fullscreen overlay — working on iPad and offline.

**Architecture:** Detection of PDF links is unchanged (`isPdfAssetHref` in `InlineSegments.tsx`). `PdfEmbed` becomes a thin wrapper that lazy-loads a new `PdfViewer` component (react-pdf/pdfjs-dist land in their own async chunk, MermaidDiagram-style). `PdfViewer` renders all pages fit-to-width with IntersectionObserver-driven lazy page mounting, a "Page x of y" footer, and a portal fullscreen overlay. Pure logic (current-page selection, placeholder sizing) lives in a Functional Core module. Bundle budgets gain a `pdfjsOwnedBytes` cap mirroring `mermaidOwnedBytes`, and the other budgets get rebaselined from measured actuals.

**Tech Stack:** React 18.3, react-pdf ^10.4.1 (pins pdfjs-dist 5.4.296), Vite 6 + vite-plugin-pwa (Workbox), Vitest + Testing Library (jsdom), Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-16-pdf-viewer-design.md`

## Global Constraints

- Work happens in a git worktree on branch `fix/pkm-srek-pdf-viewer` (create via superpowers:using-git-worktrees before Task 1). Run every command from the worktree root; check `git status -sb` before EVERY commit (parallel sessions can switch the shared checkout's branch).
- All web commands run from `<worktree>/web/` with pnpm. Never start anything on port 8974 (production launchd service owns it); Playwright's E2E server uses 8975 (`E2E_PORT` overrides).
- Every new file with runtime behaviour declares `// pattern: Functional Core` or `// pattern: Imperative Shell` near the top (enforced by `pnpm check:fcis`).
- Unit coverage thresholds are enforced: statements 95, branches 91, functions 89, lines 95 (over `src/**`). New components must ship with tests that keep these green.
- Bundle budgets in `web/tooling/budgets.json` are hard build failures (one byte over fails `vite build`). Task 6 rebaselines them; until then `pnpm build`/`pnpm verify` is EXPECTED to fail on budgets after Task 3 — use `pnpm test:unit` / `pnpm typecheck` / `pnpm lint` per-task, full verify at the end.
- The scroll-only scope is deliberate: NO zoom controls, NO text layer, NO search (spec "Out of scope"). Do not add react-pdf's TextLayer/AnnotationLayer CSS imports.
- Commit after every task (conventional style, e.g. `feat(web): …`), and push (`git push -u origin fix/pkm-srek-pdf-viewer` on first push). Update the pkm-srek bean checklist as tasks complete; commit bean file changes with the code.

---

### Task 1: Pure viewer helpers (`pdfViewerCore`)

**Files:**
- Create: `web/src/components/pdfViewerCore.ts`
- Test: `web/src/components/pdfViewerCore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 3's `PdfViewer.tsx`):
  - `DEFAULT_PAGE_ASPECT: number`
  - `currentPageFromRatios(ratios: ReadonlyMap<number, number>): number`
  - `placeholderHeight(width: number, aspect: number | null): number`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/components/pdfViewerCore.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_ASPECT,
  currentPageFromRatios,
  placeholderHeight,
} from "./pdfViewerCore";

describe("currentPageFromRatios", () => {
  it("returns 1 when nothing has been measured", () => {
    expect(currentPageFromRatios(new Map())).toBe(1);
  });

  it("returns the page with the largest visible fraction", () => {
    const ratios = new Map([[1, 0.1], [2, 0.85], [3, 0.05]]);
    expect(currentPageFromRatios(ratios)).toBe(2);
  });

  it("breaks ties toward the earliest page", () => {
    const ratios = new Map([[3, 0.5], [2, 0.5]]);
    expect(currentPageFromRatios(ratios)).toBe(2);
  });

  it("ignores pages that scrolled fully out of view", () => {
    const ratios = new Map([[1, 0], [2, 0], [3, 0.4]]);
    expect(currentPageFromRatios(ratios)).toBe(3);
  });
});

describe("placeholderHeight", () => {
  it("multiplies width by the page aspect", () => {
    expect(placeholderHeight(600, 792 / 612)).toBe(Math.round(600 * (792 / 612)));
  });

  it("falls back to the A-series default before page 1 is measured", () => {
    expect(placeholderHeight(500, null)).toBe(Math.round(500 * DEFAULT_PAGE_ASPECT));
  });

  it("never returns less than 1 (unmeasured container)", () => {
    expect(placeholderHeight(0, null)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/pdfViewerCore.test.ts`
Expected: FAIL — cannot resolve `./pdfViewerCore`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/components/pdfViewerCore.ts
// pattern: Functional Core
// Pure helpers for the PDF viewer: which page the scroll position is "on"
// (from IntersectionObserver visible fractions) and how tall an unrendered
// page placeholder should be, so scrollbar geometry is close to final
// before pages rasterize.

/** Portrait page aspect (height/width) assumed until page 1's real
 * dimensions are known: ISO A-series sqrt(2). */
export const DEFAULT_PAGE_ASPECT = Math.SQRT2;

/** The page the indicator should report: largest visible fraction wins,
 * ties go to the earliest page, and 1 when nothing is measured yet. */
export function currentPageFromRatios(
  ratios: ReadonlyMap<number, number>,
): number {
  let best = 1;
  let bestRatio = 0;
  for (const [page, ratio] of ratios) {
    if (ratio > bestRatio || (ratio > 0 && ratio === bestRatio && page < best)) {
      best = page;
      bestRatio = ratio;
    }
  }
  return best;
}

/** Height (CSS px) for a page slot whose canvas hasn't rendered yet. */
export function placeholderHeight(
  width: number,
  aspect: number | null,
): number {
  return Math.max(1, Math.round(width * (aspect ?? DEFAULT_PAGE_ASPECT)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/pdfViewerCore.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/pdfViewerCore.ts web/src/components/pdfViewerCore.test.ts
git commit -m "feat(web): pure helpers for PDF viewer paging/placeholders (pkm-srek)"
```

---

### Task 2: `PdfFallbackLink` presentational fallback

**Files:**
- Create: `web/src/components/PdfFallbackLink.tsx`
- Test: `web/src/components/PdfFallbackLink.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3 and 4):
  - `PdfFallbackLink({ href, label, note }: { href: string; label: string; note?: string })` — renders the pre-viewer link UI; `note` (when set) renders a muted explanation line above the link.

This lives in its own file (not in `PdfEmbed.tsx`) so `PdfViewer` can import it without creating an import cycle with the module that lazy-loads `PdfViewer`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/PdfFallbackLink.test.tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PdfFallbackLink } from "./PdfFallbackLink";

const href = `/assets/${"ab".repeat(32)}/doc.pdf`;

it("renders a download link using the label", () => {
  render(<PdfFallbackLink href={href} label="Notes" />);
  const link = screen.getByRole("link", { name: "Notes" });
  expect(link).toHaveAttribute("href", href);
  expect(link).toHaveAttribute("download");
});

it("falls back to generic text when the label is empty", () => {
  render(<PdfFallbackLink href={href} label="" />);
  expect(screen.getByRole("link", { name: "Download PDF" })).toBeInTheDocument();
});

it("shows the note only when given", () => {
  const { rerender } = render(<PdfFallbackLink href={href} label="Notes" />);
  expect(screen.queryByText("Couldn't render this PDF.")).toBeNull();
  rerender(<PdfFallbackLink href={href} label="Notes" note="Couldn't render this PDF." />);
  expect(screen.getByText("Couldn't render this PDF.")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/PdfFallbackLink.test.tsx`
Expected: FAIL — cannot resolve `./PdfFallbackLink`.

- [ ] **Step 3: Write the implementation**

```tsx
// web/src/components/PdfFallbackLink.tsx
// pattern: Functional Core
// The plain link presentation of a PDF asset: shown before the lazy viewer
// chunk arrives, and as the degraded fallback when the chunk or the
// document fails to load. Props in, markup out; no I/O.
export function PdfFallbackLink({ href, label, note }:
    { href: string; label: string; note?: string }) {
  return (
    <span className="pdf-embed">
      {note !== undefined && <span className="pdf-error-note">{note}</span>}
      <a href={href} download className="pdf-download">
        {label || "Download PDF"}
      </a>
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/PdfFallbackLink.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PdfFallbackLink.tsx web/src/components/PdfFallbackLink.test.tsx
git commit -m "feat(web): PdfFallbackLink degraded/loading presentation (pkm-srek)"
```

---

### Task 3: `PdfViewer` component (react-pdf) + CSS

**Files:**
- Modify: `web/package.json` (add dependency `react-pdf`)
- Create: `web/src/components/PdfViewer.tsx`
- Test: `web/src/components/PdfViewer.test.tsx`
- Modify: `web/src/styles.css:357-359` (replace the `.pdf-*` rules)

**Interfaces:**
- Consumes: `PdfFallbackLink` (Task 2), `currentPageFromRatios` / `placeholderHeight` / `DEFAULT_PAGE_ASPECT` (Task 1), `react-pdf` (`Document`, `Page`, `pdfjs`).
- Produces (used by Task 4): named export `PdfViewer({ href, label }: { href: string; label: string })`.

**Behaviour contract:**
- Fixed-height scrollable frame (`.pdf-frame`) renders one slot per page; a slot is a sized placeholder until it approaches the viewport (IntersectionObserver, `rootMargin: "150% 0px"`), then mounts a react-pdf `<Page>` (no text/annotation layers).
- A second observer (thresholds 0/0.25/0.5/0.75/1) feeds visible fractions into `currentPageFromRatios` to drive "Page x of y".
- Footer: page indicator, download link, Expand button.
- Expand renders a fullscreen overlay via `createPortal(…, document.body)` INSIDE the react-pdf `<Document>` (portals keep React context, so the document is fetched/parsed once). While expanded the inline page list unmounts (indicator is driven by the overlay's list); Close button and Escape both collapse.
- Document load error → `PdfFallbackLink` with note "Couldn't render this PDF.".

- [ ] **Step 1: Install react-pdf**

```bash
cd web && pnpm add react-pdf
```

Expected: `react-pdf ^10.4.1` (or later 10.x) in dependencies; lockfile updated; `pdfjs-dist 5.4.296` appears as its pinned dependency. Do NOT add pdfjs-dist to package.json — the worker path resolves through react-pdf's dependency via Vite.

- [ ] **Step 2: Write the failing tests**

Notes on the test environment: jsdom has no IntersectionObserver/ResizeObserver — the file stubs both and drives the observer callbacks by hand. react-pdf is fully mocked (jsdom can't run pdf.js): the mock's `Document` invokes `onLoadSuccess` with a fake 3-page pdf (or `onLoadError` when the test sets a flag), and `Page` renders a `<canvas data-testid="page-N">`. `vi.unstubAllGlobals()` in this file's `afterEach` is safe — `src/test-setup.ts` re-installs its own stubs in a `beforeEach`.

```tsx
// web/src/components/PdfViewer.test.tsx
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/PdfViewer.test.tsx`
Expected: FAIL — cannot resolve `./PdfViewer`.

- [ ] **Step 4: Write the implementation**

```tsx
// web/src/components/PdfViewer.tsx
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
            <button type="button" className="btn-secondary" onClick={() => setExpanded(true)}>
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
              <button type="button" className="btn-secondary" onClick={() => setExpanded(false)}>
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
```

Implementation notes:
- The portal sits inside `<Document>` so both page lists share one loaded document (React context flows through portals). Only one list is mounted at a time, so `currentPage` is always driven by the visible one. Collapsing loses the inline scroll position — accepted simplification.
- If TypeScript rejects the `onLoadSuccess` structural type against react-pdf's prop type, cast at the prop site: `onLoadSuccess={onLoadSuccess as (pdf: never) => void}` is NOT acceptable — instead widen `LoadedPdf`'s `getViewport` parameter to match the complaint. The structural subset above is expected to check as-is.

- [ ] **Step 5: Replace the `.pdf-*` CSS**

In `web/src/styles.css`, replace lines 357–359:

```css
.pdf-embed { display: block; margin: 4px 0; }
.pdf-viewer { width: 100%; height: 480px; border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.pdf-download { display: inline-block; margin-top: 4px; font-size: 13px; }
```

with:

```css
.pdf-embed { display: block; margin: 4px 0; }
.pdf-frame { width: 100%; height: 480px; overflow-y: auto;
  border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: var(--color-bg-subtle); }
.pdf-page-slot { margin: 0 auto; }
.pdf-page-slot canvas { display: block; max-width: 100%; height: auto !important; }
.pdf-footer { display: flex; align-items: center; gap: 12px; margin-top: 4px;
  font-size: 13px; }
.pdf-page-indicator { color: var(--color-text-muted); }
.pdf-download { display: inline-block; font-size: 13px; }
.pdf-loading-note, .pdf-error-note { display: block;
  color: var(--color-text-muted); font-size: 13px; font-style: italic; }
.pdf-overlay { position: fixed; inset: 0; z-index: 1000;
  background: var(--color-bg); display: flex; flex-direction: column; }
.pdf-overlay-bar { display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; border-bottom: 1px solid var(--color-border); }
.pdf-overlay-title { font-weight: 600; margin-right: auto; }
.pdf-overlay .pdf-frame { flex: 1; height: auto; border: none; border-radius: 0; }
```

(`--color-bg-subtle`, `--color-bg`, `--color-text-muted`, `--color-border`, `--radius-card`, and `.btn-secondary` all already exist in `styles.css`. Check no other rule uses `.pdf-viewer` before deleting it: `grep -rn "pdf-viewer" web/src web/e2e`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/PdfViewer.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: all clean. (`pnpm build` is expected to FAIL on budgets from this task until Task 6 — don't run it as a gate here.)

- [ ] **Step 8: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/src/components/PdfViewer.tsx \
  web/src/components/PdfViewer.test.tsx web/src/styles.css
git commit -m "feat(web): react-pdf multi-page viewer with lazy page mounting (pkm-srek)"
```

---

### Task 4: Rewrite `PdfEmbed` as the lazy-loading wrapper

**Files:**
- Modify: `web/src/components/PdfEmbed.tsx` (full rewrite)
- Create: `web/src/components/PdfEmbed.test.tsx`
- Modify: `web/src/components/InlineSegments.test.tsx:82-92` (the `embed[src=…]` assertion)

**Interfaces:**
- Consumes: `PdfFallbackLink` (Task 2); dynamic `import("./PdfViewer")` → `{ PdfViewer }` (Task 3).
- Produces: `PdfEmbed({ href, label })` — same signature `InlineSegments.tsx:64` already uses; NO change to `InlineSegments.tsx` itself.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/PdfEmbed.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// The real PdfViewer drags react-pdf/pdfjs into jsdom; substitute a marker.
vi.mock("./PdfViewer", () => ({
  PdfViewer: ({ href, label }: { href: string; label: string }) => (
    <div data-testid="pdf-viewer">{label}:{href}</div>
  ),
}));

import { PdfEmbed } from "./PdfEmbed";

const href = `/assets/${"ab".repeat(32)}/doc.pdf`;

it("shows the plain link while loading, then swaps in the viewer", async () => {
  render(<PdfEmbed href={href} label="Notes" />);
  // synchronous first paint: the fallback link (never a blank slot)
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
  expect(screen.getByTestId("pdf-viewer")).toHaveTextContent(`Notes:${href}`);
});

it("keeps the link fallback with a note when the viewer chunk fails", async () => {
  vi.resetModules();
  vi.doMock("./PdfViewer", () => {
    throw new Error("chunk load failed");
  });
  const { PdfEmbed: FreshPdfEmbed } = await import("./PdfEmbed");
  render(<FreshPdfEmbed href={href} label="Notes" />);
  await waitFor(() =>
    expect(screen.getByText("Couldn't load the PDF viewer.")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  vi.doUnmock("./PdfViewer");
  vi.resetModules();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/PdfEmbed.test.tsx`
Expected: FAIL — current PdfEmbed renders an `<embed>`, no `pdf-viewer` testid appears.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `web/src/components/PdfEmbed.tsx`:

```tsx
// web/src/components/PdfEmbed.tsx
// pattern: Imperative Shell
// Entry point for PDF asset links. The real viewer (react-pdf + pdfjs-dist,
// several hundred KB) is loaded lazily on first render, MermaidDiagram-style:
// a module-level cached import() promise shared by every PDF on the page,
// reset on failure so one bad load doesn't wedge later attempts. Until the
// chunk arrives (and if it never does) the plain download link renders, so
// degraded behaviour is never worse than the pre-viewer UI.
import { type ComponentType, useEffect, useState } from "react";
import { PdfFallbackLink } from "./PdfFallbackLink";

type ViewerProps = { href: string; label: string };

let viewerPromise: Promise<ComponentType<ViewerProps>> | null = null;

function loadViewer(): Promise<ComponentType<ViewerProps>> {
  if (!viewerPromise) {
    viewerPromise = import("./PdfViewer").then((m) => m.PdfViewer);
    viewerPromise.catch(() => {
      viewerPromise = null;
    });
  }
  return viewerPromise;
}

type ViewerState =
  | { status: "loading" }
  | { status: "ok"; Viewer: ComponentType<ViewerProps> }
  | { status: "error" };

export function PdfEmbed({ href, label }: ViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    loadViewer().then(
      (Viewer) => {
        if (alive) setState({ status: "ok", Viewer });
      },
      () => {
        if (alive) setState({ status: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === "loading") return <PdfFallbackLink href={href} label={label} />;
  if (state.status === "error") {
    return <PdfFallbackLink href={href} label={label} note="Couldn't load the PDF viewer." />;
  }
  const { Viewer } = state;
  return <Viewer href={href} label={label} />;
}
```

- [ ] **Step 4: Update the InlineSegments test**

In `web/src/components/InlineSegments.test.tsx`, the mocked viewer must be registered before the component import at the top of the file — add with the other imports:

```tsx
vi.mock("./PdfViewer", () => ({
  PdfViewer: ({ href }: { href: string }) => <div data-testid="pdf-viewer" data-href={href} />,
}));
```

(if the file doesn't already import `vi` from vitest, extend its vitest import). Then replace the body of the test at lines 82–92:

```tsx
it("renders images, pdf embeds for /assets/*.pdf links, and external links", async () => {
  const sha = "ab".repeat(32);
  const { container } = renderText(
    `![shot](/assets/${sha}/pic.png) [Notes](/assets/${sha}/doc.pdf) [ext](https://x.org)`);
  expect(container.querySelector(`img[src="/assets/${sha}/pic.png"]`)).not.toBeNull();
  // the PDF link becomes the lazy viewer wrapper: link fallback first…
  expect(screen.getByRole("link", { name: "Notes" }))
    .toHaveAttribute("href", `/assets/${sha}/doc.pdf`);
  // …then the (mocked) viewer once the chunk resolves
  await waitFor(() =>
    expect(screen.getByTestId("pdf-viewer"))
      .toHaveAttribute("data-href", `/assets/${sha}/doc.pdf`));
  expect(screen.getByRole("link", { name: "ext" }))
    .toHaveAttribute("target", "_blank");
});
```

(add `waitFor` to the `@testing-library/react` import if missing; note the `Notes` role-link assertion now matches the fallback/footer link rather than a sibling of an `<embed>`).

- [ ] **Step 5: Run the affected tests**

Run: `cd web && pnpm vitest run src/components/PdfEmbed.test.tsx src/components/InlineSegments.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full unit suite + static checks**

Run: `cd web && pnpm test:unit && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: all pass, coverage thresholds still green. If coverage dips below a threshold, the gap will be in `PdfViewer.tsx`/`PdfEmbed.tsx` branches — add targeted unit tests (e.g. empty-label variants), don't lower thresholds.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/PdfEmbed.tsx web/src/components/PdfEmbed.test.tsx \
  web/src/components/InlineSegments.test.tsx
git commit -m "feat(web): lazy-load the PDF viewer from PdfEmbed (pkm-srek)"
```

---

### Task 5: `pdfjsOwnedBytes` budget machinery

**Files:**
- Modify: `web/tooling/buildBudgets.ts`
- Modify: `web/tooling/buildBudgets.test.ts`
- Modify: `web/tooling/viteBudgetPlugin.ts`
- Modify: `web/tooling/budgets.json`
- Modify: `web/vite.config.ts` (Workbox `globPatterns`)

**Interfaces:**
- Consumes: existing budget core/plugin.
- Produces: `evaluateBundleBudgets(files, chunks, owned: OwnedModuleSets, budgets?)` where `OwnedModuleSets = { mermaid: ReadonlySet<string>; pdfjs: ReadonlySet<string> }`; generic `chunkIsWhollyOwned(moduleIds, owned)` and `ownedChunkBytes(chunks, owned)` replacing the mermaid-specific pair; new `pdfjsOwnedBytes` budget key.

- [ ] **Step 1: Extend the budget-core tests (failing first)**

In `web/tooling/buildBudgets.test.ts`:

1. Change the import block to the generic names:

```ts
import {
  type BuildBudgets,
  type OutputChunkInfo,
  type OutputFile,
  chunkIsWhollyOwned,
  evaluateBundleBudgets,
  evaluatePrecacheBudgets,
  formatReport,
  ownedChunkBytes,
} from "./buildBudgets";
```

2. Extend the fixture budgets and ownership:

```ts
const budgets: BuildBudgets = {
  initialEntryBytes: 700,
  largestAssetBytes: 800,
  totalOutputBytes: 2400,
  precacheBytes: 1500,
  precacheEntries: 3,
  mermaidOwnedBytes: 500,
  pdfjsOwnedBytes: 400,
};

const owned = { mermaid: new Set(["m1", "m2"]), pdfjs: new Set(["p1", "p2"]) };
```

3. Add a pdfjs chunk to the baselines (and its file):

```ts
function baselineChunks(): OutputChunkInfo[] {
  return [
    { fileName: "index-abc.js", bytes: 700, isEntry: true, moduleIds: ["app"] },
    { fileName: "mermaid-abc.js", bytes: 500, isEntry: false, moduleIds: ["m1", "m2"] },
    { fileName: "PdfViewer-abc.js", bytes: 400, isEntry: false, moduleIds: ["p1", "p2"] },
  ];
}
function baselineFiles(): OutputFile[] {
  return [
    { fileName: "index-abc.js", bytes: 700 },
    { fileName: "sqlite-abc.wasm", bytes: 800 },
    { fileName: "mermaid-abc.js", bytes: 500 },
    { fileName: "PdfViewer-abc.js", bytes: 400 },
  ];
}
```

4. Update every `evaluateBundleBudgets(…, owned, budgets)` call site (the shape of `owned` changed), rename the `chunkIsMermaidOwned`/`mermaidOwnedBytes` describe block to use `chunkIsWhollyOwned(chunk.moduleIds, owned.mermaid)` / `ownedChunkBytes(chunks, owned.mermaid)`, keep the anti-smuggling cases as-is (same semantics, generic names), fix the "totals" test expectation to the new total (`2400`), and add:

```ts
describe("pdfjs ownership", () => {
  it("bundle evaluation caps pdfjs-owned chunk bytes independently", () => {
    const report = evaluateBundleBudgets(
      baselineFiles(), baselineChunks(), owned, budgets);
    const pdfjs = report.checks.find((c) => c.name === "pdfjsOwnedBytes")!;
    expect(pdfjs.actual).toBe(400);
    expect(pdfjs.ok).toBe(true);
  });

  it("a mixed pdfjs/app chunk does not count toward the pdfjs cap", () => {
    const chunks = [
      ...baselineChunks(),
      { fileName: "mixed.js", bytes: 99999, isEntry: false, moduleIds: ["p1", "app"] },
    ];
    expect(ownedChunkBytes(chunks, owned.pdfjs)).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tooling tests to verify they fail**

Run: `cd web && pnpm vitest run tooling/buildBudgets.test.ts`
Expected: FAIL — `chunkIsWhollyOwned` / `ownedChunkBytes` not exported, `pdfjsOwnedBytes` missing from `BuildBudgets`.

- [ ] **Step 3: Update `buildBudgets.ts`**

- Add to `BuildBudgets`:

```ts
  /** Raw bytes of chunks wholly owned by the lazy PDF viewer module graph
   * (PdfViewer.tsx + react-pdf + pdfjs-dist). */
  pdfjsOwnedBytes: number;
```

- Rename the ownership helpers generically (keeping doc comments' anti-smuggling rationale, now phrased for any owned graph):

```ts
export function chunkIsWhollyOwned(
  moduleIds: readonly string[],
  ownedModuleIds: ReadonlySet<string>,
): boolean {
  return moduleIds.length > 0 && moduleIds.every((id) => ownedModuleIds.has(id));
}

export function ownedChunkBytes(
  chunks: readonly OutputChunkInfo[],
  ownedModuleIds: ReadonlySet<string>,
): number {
  return chunks.reduce(
    (sum, c) => (chunkIsWhollyOwned(c.moduleIds, ownedModuleIds) ? sum + c.bytes : sum),
    0,
  );
}
```

- Add the owned-sets type and use it in `evaluateBundleBudgets`:

```ts
/** Module-id sets for each specially-capped dependency graph. */
export interface OwnedModuleSets {
  mermaid: ReadonlySet<string>;
  pdfjs: ReadonlySet<string>;
}
```

```ts
export function evaluateBundleBudgets(
  files: readonly OutputFile[],
  chunks: readonly OutputChunkInfo[],
  owned: OwnedModuleSets,
  budgets: BuildBudgets = BUDGETS,
): BudgetReport {
  const entryBytes = chunks
    .filter((c) => c.isEntry)
    .reduce((sum, c) => sum + c.bytes, 0);
  const largest = files.reduce((max, f) => (f.bytes > max ? f.bytes : max), 0);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const checks = [
    check("initialEntryBytes", budgets.initialEntryBytes, entryBytes),
    check("largestAssetBytes", budgets.largestAssetBytes, largest),
    check("totalOutputBytes", budgets.totalOutputBytes, total),
    check("mermaidOwnedBytes", budgets.mermaidOwnedBytes,
      ownedChunkBytes(chunks, owned.mermaid)),
    check("pdfjsOwnedBytes", budgets.pdfjsOwnedBytes,
      ownedChunkBytes(chunks, owned.pdfjs)),
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    largestContributors: topContributors(files),
  };
}
```

- [ ] **Step 4: Update `viteBudgetPlugin.ts`**

Generalize the collector (same reachability algorithm, parameterized seeds) and compute both sets:

```ts
/**
 * Module ids OWNED by a dependency graph: everything reachable from a seed
 * module (following both static and dynamic imports), MINUS anything the
 * eager app entry can reach through static imports. Subtracting the
 * eager-static set stops a module shared with the app from being attributed
 * to the capped graph, so an owned-bytes cap can never launder unrelated
 * application code.
 */
function collectOwned(graph: ModuleGraph, isSeed: (id: string) => boolean): Set<string> {
  const reach = (starts: string[], includeDynamic: boolean): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const info = graph.getModuleInfo(id);
      if (!info) continue;
      for (const dep of info.importedIds) stack.push(dep);
      if (includeDynamic) {
        for (const dep of info.dynamicallyImportedIds) stack.push(dep);
      }
    }
    return seen;
  };
  const allIds = [...graph.getModuleIds()];
  const entryIds = allIds.filter((id) => graph.getModuleInfo(id)?.isEntry);
  const seedIds = allIds.filter(isSeed);
  const appStatic = reach(entryIds, false);
  const ownedGraph = reach(seedIds, true);
  const owned = new Set<string>();
  for (const id of ownedGraph) if (!appStatic.has(id)) owned.add(id);
  return owned;
}

/** Mermaid graph seeds: mermaid package modules under node_modules. */
const isMermaidSeed = (id: string): boolean =>
  id.includes("node_modules") && /[\\/]mermaid[\\/]/.test(id);

/** PDF viewer graph seeds: the lazily-imported viewer module itself plus the
 * react-pdf/pdfjs-dist packages. Seeding PdfViewer.tsx is what lets the
 * emitted chunk (which contains that app module alongside the libraries)
 * count as wholly owned; its transitive-only helpers (pdfViewerCore) join
 * via reachability. Note the pdf.js WORKER is an emitted asset, not a chunk,
 * so it is guarded by largestAssetBytes/totalOutputBytes/precacheBytes, not
 * by this cap. */
const isPdfjsSeed = (id: string): boolean =>
  (id.includes("node_modules") && /[\\/](react-pdf|pdfjs-dist)[\\/]/.test(id)) ||
  /[\\/]src[\\/]components[\\/]PdfViewer\.tsx$/.test(id);
```

and in `generateBundle` replace the `collectMermaidOwned` call:

```ts
const graph = this as unknown as ModuleGraph;
const owned = {
  mermaid: collectOwned(graph, isMermaidSeed),
  pdfjs: collectOwned(graph, isPdfjsSeed),
};
const report = evaluateBundleBudgets(files, chunks, owned);
```

(delete `collectMermaidOwned`; keep everything else, including `precacheBudgetTransform`, unchanged.)

- [ ] **Step 5: Add the budget key and precache the worker**

In `web/tooling/budgets.json`, add to `limits` a deliberately-failing placeholder (Task 6 measures the real value):

```json
"pdfjsOwnedBytes": 1
```

and to `rationale`:

```json
"pdfjsOwnedBytes": "Raw bytes of chunks WHOLLY owned by the lazy PDF viewer module graph (PdfViewer.tsx + react-pdf + pdfjs-dist; Rollup module ownership, not file-name substrings), mirroring mermaidOwnedBytes. The pdf.js worker is an emitted .mjs asset rather than a chunk, so it is bounded by largestAssetBytes/totalOutputBytes/precacheBytes instead of this cap."
```

In `web/vite.config.ts`, the Workbox glob must pick up the emitted `pdf.worker.min-<hash>.mjs` asset or the viewer breaks offline:

```ts
globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,wasm}"],
```

(update the neighbouring comment to mention the pdf.js worker alongside the sqlite wasm.)

- [ ] **Step 6: Run the tooling tests to verify they pass**

Run: `cd web && pnpm vitest run tooling/buildBudgets.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS / clean. (`vite build` still fails — placeholder limit — that's Task 6.)

- [ ] **Step 7: Commit**

```bash
git add web/tooling/buildBudgets.ts web/tooling/buildBudgets.test.ts \
  web/tooling/viteBudgetPlugin.ts web/tooling/budgets.json web/vite.config.ts
git commit -m "feat(web): pdfjsOwnedBytes bundle budget + precache pdf.js worker (pkm-srek)"
```

---

### Task 6: Measure and rebaseline the budgets

**Files:**
- Modify: `web/tooling/budgets.json`

**Interfaces:**
- Consumes: budget report output printed by `vite build` (Task 5's machinery).
- Produces: a `budgets.json` whose limits pass with ~4–5% headroom over the new actuals.

- [ ] **Step 1: Build and capture the measured actuals**

Run: `cd web && pnpm build 2>&1 | grep -A12 "budget report"`
Expected: the bundle report FAILS (at minimum `pdfjsOwnedBytes` at its placeholder; likely `largestAssetBytes` — the pdf.js worker ≈1 MB raw exceeds the sqlite-wasm-based 907990 cap — plus `totalOutputBytes`; the precache report likely fails `precacheBytes`/`precacheEntries` after the worker + viewer chunk join the manifest). Record every `actual` value printed for: `initialEntryBytes`, `largestAssetBytes`, `totalOutputBytes`, `mermaidOwnedBytes`, `pdfjsOwnedBytes`, `precacheBytes`, `precacheEntries`.

- [ ] **Step 2: Sanity-check the chunk graph before accepting the numbers**

From the same build output / report contributors verify BOTH:
1. `initialEntryBytes` actual is unchanged (±1%) from 440910-ish — i.e. react-pdf did NOT leak into the eager entry. If it grew materially, find the static import that dragged it in (`PdfViewer` must only be reached via dynamic import) and fix before rebaselining.
2. `pdfjsOwnedBytes` actual is > 0 — i.e. the viewer chunk was recognized as wholly owned. If it reads 0, the ownership seeds are wrong (e.g. the chunk contains an unexpected app module); inspect with `npx vite build --debug` or add a temporary `console.log` of the offending chunk's `moduleIds` in the plugin, fix the seed predicate, rebuild.

- [ ] **Step 3: Rebaseline `budgets.json`**

For each limit whose actual changed, set `limit = ceil(actual * 1.045)` (the repo's ~4–5% headroom convention; for `precacheEntries` use actual + 3). Leave `initialEntryBytes` and `mermaidOwnedBytes` limits untouched (their actuals should not have moved). Update `measuredOn` to today's date and extend the `rationale` strings for every changed limit — at minimum note that `largestAssetBytes` is now set by the pdf.js worker (`pdf.worker.min-*.mjs`), not the sqlite wasm, and that `totalOutputBytes`/`precacheBytes`/`precacheEntries` grew by the PDF viewer family (worker asset + viewer chunk).

- [ ] **Step 4: Verify the build passes**

Run: `cd web && pnpm build`
Expected: both budget reports print `OK`; build succeeds. Confirm the worker was precached: `grep -o "pdf.worker[^\"]*" web/dist/sw.js | head -1` prints a `pdf.worker.min-<hash>.mjs` URL.

- [ ] **Step 5: Commit**

```bash
git add web/tooling/budgets.json
git commit -m "chore(web): rebaseline bundle budgets for the PDF viewer chunk/worker (pkm-srek)"
```

---

### Task 7: Playwright E2E — upload, scroll, expand

**Files:**
- Create: `web/e2e/pdf-fixture.ts`
- Create: `web/e2e/pdf.spec.ts`

**Interfaces:**
- Consumes: the running app (`pnpm e2e` builds and serves `web/dist` against `server/tests/e2e_serve.py`), `e2e/fixtures.ts` (`test`/`expect` with 5xx tracking), `POST /api/assets` (multipart, field name `file`, response `{ url, filename, mime, size }`).
- Produces: `makePdf(pageCount: number): Buffer` — a valid multi-page PDF built with exact xref offsets, deterministic bytes.

- [ ] **Step 1: Write the PDF fixture generator**

```ts
// web/e2e/pdf-fixture.ts
// Builds a small, valid, deterministic multi-page PDF entirely in-process,
// so the spec needs no committed binary. Object layout: 1=catalog, 2=pages,
// then (page,content) pairs per page, then one shared Helvetica font. Byte
// offsets are computed while concatenating, so the xref table is correct by
// construction (ASCII-only content, 1 char = 1 byte).
export function makePdf(pageCount: number): Buffer {
  const fontObjNum = 3 + pageCount * 2;
  const kids = Array.from(
    { length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    const stream = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
      `/Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
```

- [ ] **Step 2: Write the E2E spec**

The login/typing helpers copy the established pattern from `e2e/embeds.spec.ts` (each spec file is self-contained by repo convention).

```ts
// web/e2e/pdf.spec.ts
// The embedded PDF viewer end-to-end: upload a real 3-page PDF, link it in a
// block, and drive the react-pdf viewer -- pages rasterize to canvases, the
// indicator follows scroll, and the fullscreen overlay opens/closes (pkm-srek).
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { makePdf } from "./pdf-fixture";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("uploaded multi-page PDF renders, scrolls, and expands", async ({ page }) => {
  await login(page);

  // page.request shares the logged-in cookie jar
  const res = await page.request.post("/api/assets", {
    multipart: {
      file: { name: "three-page.pdf", mimeType: "application/pdf", buffer: makePdf(3) },
    },
  });
  expect(res.ok()).toBe(true);
  const { url } = await res.json() as { url: string };

  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill(`[three-page.pdf](${url})`);
  await input(page).press("Escape");

  // viewer chunk loads, document parses, page 1 rasterizes
  const frame = page.locator(".pdf-frame");
  await expect(frame).toBeVisible();
  await expect(page.locator(".pdf-page-slot canvas").first()).toBeVisible();
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 1 of 3");

  // scrolling the frame mounts/rasterizes the rest and moves the indicator
  await frame.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator(".pdf-page-slot canvas")).toHaveCount(3);
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 3 of 3");

  // expand to the fullscreen overlay; Escape collapses it
  await page.getByRole("button", { name: "Expand" }).click();
  const overlay = page.locator(".pdf-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("canvas").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});
```

- [ ] **Step 3: Run the E2E suite**

Run: `cd web && pnpm e2e` (builds first; server starts on 8975 — NEVER 8974)
Expected: all specs pass including `pdf.spec.ts`. Known wrinkles if it fails:
- Port clash on 8975 → another session is running E2E; rerun with `E2E_PORT=8985 pnpm e2e`.
- Both `.pdf-page-indicator` instances matching (inline + overlay footer are never mounted simultaneously in the frame path, but the footer indicator remains during expand — if strict-mode violations appear, scope the locator: `page.locator(".pdf-footer .pdf-page-indicator")` for the inline assertions and `overlay.locator(".pdf-page-indicator")` inside the overlay).
- With a 480px frame and `rootMargin: "150% 0px"`, pages 2–3 may mount before scrolling; the count/indicator assertions above are written to be valid either way.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/pdf-fixture.ts web/e2e/pdf.spec.ts
git commit -m "test(web): E2E coverage for the embedded PDF viewer (pkm-srek)"
```

---

### Task 8: Full verification, bean completion, merge prep

**Files:**
- Modify: `.beans/pkm-srek--pdf-viewer.md` (via `beans update`)

- [ ] **Step 1: Run the complete web verification**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, FCIS check, unit tests with coverage thresholds, budget-clean build, and Playwright all pass, warning-free.

- [ ] **Step 2: Server suite untouched — confirm no accidental server changes**

Run: `git status -sb && git diff --stat main...HEAD -- server/`
Expected: no server files changed (this is a web-only feature). If server files show up, something is wrong — stop and investigate.

- [ ] **Step 3: Update the bean**

```bash
beans update pkm-srek --body-append "## Summary of Changes

Replaced the native <embed> PDF rendering with a lazy-loaded PDF.js viewer
(react-pdf): multi-page scrolling in a fixed-height card with lazy page
mounting, 'Page x of y' indicator, download link, and a fullscreen overlay
reading mode (Esc/Close). Degrades to the plain download link when the
chunk or document fails. Added a pdfjsOwnedBytes bundle budget mirroring
mermaidOwnedBytes, precached the pdf.js worker (.mjs glob), and rebaselined
the size budgets. E2E covers upload -> render -> scroll -> expand."
```

(Leave status as in-progress; completion happens at merge per the finishing skill.)

- [ ] **Step 4: Commit and push**

```bash
git add .beans/pkm-srek--pdf-viewer.md
git commit -m "chore(beans): record pkm-srek implementation summary"
git push
```

- [ ] **Step 5: Finish the branch**

Invoke superpowers:finishing-a-development-branch — merge to main with `git merge --no-ff fix/pkm-srek-pdf-viewer`, run the verify suite once more on main, push, and mark the bean completed. Production deploy only if the user asks (via `~/.config/pkm/app/deploy/update.sh`, never the dev checkout's copy).
