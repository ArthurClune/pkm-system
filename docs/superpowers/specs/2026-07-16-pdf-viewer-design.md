# Embedded PDF Viewer — Design (pkm-srek)

Date: 2026-07-16
Bean: pkm-srek

## Problem

PDF assets linked in pages currently render via `PdfEmbed.tsx`, which uses
`<embed type="application/pdf">` and delegates to the browser's native PDF
plugin. On iPadOS/iOS Safari the native embed shows at most the first page as
a static image (no scrolling, no multi-page), and in some configurations
nothing renders at all, leaving only the download link. Since the app is an
offline-capable PWA used on iPad, the native embed cannot be fixed — the PDF
must be rendered by the app itself.

## Decision

Render PDFs with Mozilla PDF.js via the `react-pdf` wrapper
(wojtekmaj/react-pdf), in a custom viewer styled with the app's existing
design tokens.

Alternatives considered and rejected:

- **Prebuilt PDF.js viewer in an iframe** — full Firefox-style toolbar for
  little code, but a ~2–3 MB static asset, visually alien to the app (no
  design tokens / dark mode), and awkward to integrate with the Vite build
  and service worker.
- **Raw `pdfjs-dist` with a hand-rolled canvas viewer** — maximum control but
  re-implements page lifecycle, render cancellation, and sizing that
  react-pdf already handles.
- **Commercial SDKs (Nutrient/PSPDFKit, Apryse)** — paid and oversized for a
  personal PKM.

## Scope

In scope:

- Multi-page rendering with scrolling, fit-to-width pages.
- "Page x of y" indicator.
- Download link (retained from current UI).
- Expand button opening a fullscreen overlay (modal) viewer; Esc/close
  returns to the page.
- Graceful fallback to the current link + download UI on any failure.

Out of scope (deliberately, per requirements discussion):

- Zoom controls, text selection (text layer), in-PDF search, thumbnails,
  printing, annotations. The text and annotation layers are explicitly
  disabled for cheaper rendering.

## Architecture

Detection is unchanged: `isPdfAssetHref` in `InlineSegments.tsx` continues to
route `/assets/…*.pdf` links to `PdfEmbed`.

### Components

- **`PdfEmbed` (existing, rewritten)** — thin wrapper and mount point.
  Lazy-loads the real viewer with `React.lazy` + dynamic import so
  `pdfjs-dist` (~400 KB gz plus worker) is a separate chunk fetched only when
  a page actually contains a PDF. While the chunk loads it shows the
  link-style placeholder; if the chunk or the document fails to load it falls
  back to the current link + download UI with a short "couldn't render PDF"
  note. Degraded behaviour is never worse than today.
- **`PdfViewer` (new)** — a fixed-height (~480px, current `.pdf-viewer` CSS)
  scrollable card rendering the document via react-pdf `<Document>` /
  `<Page>`. All pages are laid out fit-to-width, but offscreen pages mount
  lazily via IntersectionObserver: until a page nears the viewport it is a
  correctly-sized placeholder box, so a 100-page PDF does not rasterize 100
  canvases up front. `renderTextLayer={false}` and
  `renderAnnotationLayer={false}`.
- **Footer bar** on the card: "Page x of y" (driven by the same
  IntersectionObserver), the download link, and an expand button.
- **Fullscreen overlay** — expand opens the same `PdfViewer` at viewport
  height in a modal with dimmed backdrop, close button, and Esc handling.
  Reuse the app's existing modal/overlay pattern if one exists (check during
  planning); otherwise a minimal dedicated overlay.

### Worker & offline

The PDF.js worker is configured with the react-pdf recommended Vite pattern:

```ts
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
```

This emits the worker as a same-origin hashed build asset, which the service
worker precaches like any other bundle file. The viewer therefore works
offline whenever the PDF asset itself is available from the asset cache.
Offline with an uncached PDF → document load error → link fallback.

### FCIS

The viewer is observer/canvas/DOM-driven and will be annotated
`// pattern: Imperative Shell` (or `Mixed` with a reason if unavoidable).
Pure logic — page-fit width math, page-indicator derivation from visibility
state — is split into Functional Core helpers with unit tests.

## Constraints & risks

- **Bundle budgets:** `pnpm verify` enforces size budgets. The new lazy
  pdfjs chunk needs its own budget entry rather than inflating an existing
  one; pages without PDFs must not pay any of its cost (verified by the
  chunk graph).
- **Long documents:** lazy page mounting bounds memory/CPU; no full
  virtualization (unmounting far-offscreen pages) unless E2E shows it's
  needed.

## Error handling

- Chunk load failure, document load/parse failure, or offline-with-uncached
  asset → fall back to link + download UI plus a small "couldn't render PDF"
  note. No retry loops.
- Render errors on individual pages leave the placeholder box in place
  rather than breaking the whole viewer.

## Testing

- **Unit (vitest):** fallback rendering on load error; Functional Core
  helpers (fit-width math, page-indicator logic); existing `isPdfAssetHref`
  tests unchanged.
- **E2E (Playwright):** seed a small multi-page PDF fixture; assert multiple
  page canvases render as the frame scrolls, the page indicator updates, and
  the expand overlay opens and closes (button and Esc). Headless Chromium
  renders PDF.js canvases.
