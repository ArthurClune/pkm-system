// pattern: Functional Core
// The plain link presentation of a PDF asset: shown before the lazy viewer
// chunk arrives, as the degraded fallback when the chunk or the document
// fails to load, and (with `onOpen`) as the click-to-load resting state of a
// deferred embed. Props in, markup out; no I/O.
import type { MouseEvent } from "react";

export function PdfFallbackLink({ href, label, note, onOpen }:
    { href: string; label: string; note?: string; onOpen?: (e: MouseEvent) => void }) {
  return (
    <span className="pdf-embed">
      {!!note && <span className="pdf-error-note">{note}</span>}
      <a href={href} download className="pdf-download">
        {label || "Download PDF"}
      </a>
      {onOpen !== undefined && (
        <button type="button" className="btn-secondary pdf-open" onClick={onOpen}>
          Open
        </button>
      )}
    </span>
  );
}
