// pattern: Functional Core
// Which inline segments a table cell shows as a one-line label instead of
// the media itself, and what the label says. The tests mirror the dispatch
// in InlineSegments' Segment, so a segment is media here exactly when the
// outline would render it as an embed.
import type { BlockSegment } from "../grammar/tokenize";
import { isBlueskyPostUrl } from "./bluesky";
import { isPdfHref, pdfLabelFromHref } from "./externalMedia";

export type CellMedia =
  | { kind: "pdf"; href: string; label: string }
  | { kind: "image"; src: string; alt: string; label: string }
  | { kind: "line"; label: string };

function imageLabel(src: string, alt: string): string {
  if (alt) return alt;
  const path = src.split(/[?#]/, 1)[0];
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name) return "image";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function cellMedia(seg: BlockSegment): CellMedia | null {
  switch (seg.kind) {
    case "pdf-embed":
      if (!isPdfHref(seg.href)) return null;
      return { kind: "pdf", href: seg.href, label: pdfLabelFromHref(seg.href) };
    case "link":
      if (isPdfHref(seg.href)) {
        return { kind: "pdf", href: seg.href, label: seg.text };
      }
      if (seg.text === seg.href && isBlueskyPostUrl(seg.href)) {
        return { kind: "line", label: "Bluesky post" };
      }
      return null;
    case "image":
      return {
        kind: "image", src: seg.src, alt: seg.alt,
        label: imageLabel(seg.src, seg.alt),
      };
    case "code-block":
      return {
        kind: "line",
        label: seg.lang === "mermaid" ? "Mermaid diagram" : "Code block",
      };
    case "query":
      return { kind: "line", label: "Query" };
    default:
      return null;
  }
}
