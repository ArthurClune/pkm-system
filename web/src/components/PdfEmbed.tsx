// pattern: Functional Core
export function PdfEmbed({ href, label }: { href: string; label: string }) {
  return (
    <span className="pdf-embed">
      <embed type="application/pdf" src={href} className="pdf-viewer" />
      <a href={href} download className="pdf-download">
        {label || "Download PDF"}
      </a>
    </span>
  );
}
