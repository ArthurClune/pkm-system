// pattern: Functional Core
// What a table cell shows for a segment the outline would render as an
// embed: a one-line label (a PDF or image opens its viewer; other media
// goes to the line that holds it), or, in a plain table, where that line is
// the cell itself, the media in a form that fits a cell. The tests mirror
// the dispatch in InlineSegments' Segment, so a segment is media here
// exactly when the outline would render it as an embed.
import type { BlockUid, RawTitle } from "../api/brands";
import type { CellMediaTarget } from "../contexts";
import type { BlockSegment } from "../grammar/tokenize";
import { isBlueskyPostUrl } from "./bluesky";
import { isPdfHref, pdfLabelFromHref } from "./externalMedia";

export type CellMedia =
  | { kind: "pdf"; href: string; label: string }
  | { kind: "image"; src: string; alt: string; label: string }
  | { kind: "line"; label: string; page: RawTitle; uid: BlockUid }
  | { kind: "code"; lang: string | null; code: string }
  | { kind: "link"; href: string }
  | { kind: "source"; text: string };

export type LabelMedia = Extract<CellMedia, { kind: "pdf" | "image" | "line" }>;

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

export function cellMedia(
  seg: BlockSegment, target: CellMediaTarget,
): CellMedia | null {
  const line = (label: string, inPlace: CellMedia): CellMedia =>
    target.table === "plain"
      ? inPlace
      : { kind: "line", label, page: target.page, uid: target.uid };
  switch (seg.kind) {
    case "pdf-embed":
      if (!isPdfHref(seg.href)) return null;
      return { kind: "pdf", href: seg.href, label: pdfLabelFromHref(seg.href) };
    case "link":
      if (isPdfHref(seg.href)) {
        return { kind: "pdf", href: seg.href, label: seg.text };
      }
      if (seg.text === seg.href && isBlueskyPostUrl(seg.href)) {
        return line("Bluesky post", { kind: "link", href: seg.href });
      }
      return null;
    case "image":
      return {
        kind: "image", src: seg.src, alt: seg.alt,
        label: imageLabel(seg.src, seg.alt),
      };
    case "code-block":
      return seg.lang === "mermaid"
        ? line("Mermaid diagram", { kind: "code", lang: null, code: seg.code })
        : line("Code block", { kind: "code", lang: seg.lang, code: seg.code });
    case "query":
      return line("Query", { kind: "source", text: seg.source });
    default:
      return null;
  }
}
