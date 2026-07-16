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
