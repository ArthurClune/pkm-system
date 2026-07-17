// pattern: Imperative Shell
// Dispatches each tokenized segment to its renderer. isPdfAssetHref/
// isSafeHref/pdfLabelFromHref below are pure, but the module as a whole composes several
// Imperative Shell components (AssetImage, BlockRef, PageLink, TodoCheckbox,
// BlueskyEmbed, MermaidDiagram, QueryBlock) that read React context, fetch,
// or navigate, so it's a shell rather than a pure rendering decision.
import type { BlockSegment } from "../grammar/tokenize";
import { AssetImage } from "./AssetImage";
import { BlockRef } from "./BlockRef";
import { isBlueskyPostUrl } from "./bluesky";
import { BlueskyEmbed } from "./BlueskyEmbed";
import { CodeBlock } from "./CodeBlock";
import { MathSpan } from "./MathSpan";
import { MermaidDiagram } from "./MermaidDiagram";
import { PageLink } from "./PageLink";
import { PdfEmbed } from "./PdfEmbed";
import { QueryBlock } from "./QueryBlock";
import { TodoCheckbox } from "./TodoCheckbox";

function isPdfAssetHref(href: string): boolean {
  return href.startsWith("/assets/") && href.toLowerCase().endsWith(".pdf");
}

/** Display label for a {{[[pdf]]: …}} macro, which carries no link text:
 * the decoded filename portion of the href (raw on malformed encoding). */
function pdfLabelFromHref(href: string): string {
  const name = href.slice(href.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Plan-4 carry-forward: [x](javascript:…) in block text must not become a
 * clickable anchor. http(s), mailto, and site-relative (single-slash) only.
 * Control chars are rejected outright (browsers strip tab/CR/LF before URL
 * parsing, defeating prefix checks) and the second char after a leading /
 * may not be / or \ (protocol-relative escapes). */
function isSafeHref(href: string): boolean {
  if (/[\u0000-\u001f]/.test(href)) return false;
  if (/^(https?:|mailto:)/i.test(href)) return true;
  return href.startsWith("/") && !/^\/[/\\]/.test(href);
}

export function InlineSegments({ segments, depth = 0 }:
    { segments: BlockSegment[]; depth?: number }) {
  return (
    <>
      {segments.map((seg, i) => <Segment key={i} seg={seg} depth={depth} />)}
    </>
  );
}

function Segment({ seg, depth }: { seg: BlockSegment; depth: number }) {
  switch (seg.kind) {
    case "text":
      return <>{seg.text}</>;
    case "linebreak":
      return <br />;
    case "inline-code":
      return <code className="inline-code">{seg.code}</code>;
    case "math":
      return <MathSpan tex={seg.tex} display={seg.display} />;
    case "page-ref":
      return <PageLink title={seg.title} tag={seg.tag} />;
    case "attribute":
      return (
        <span className="attribute">
          <PageLink title={seg.name} tag={false} />
        </span>
      );
    case "block-ref":
      return <BlockRef uid={seg.uid} depth={depth} />;
    case "image":
      return <AssetImage src={seg.src} alt={seg.alt} />;
    case "pdf-embed":
      if (isPdfAssetHref(seg.href)) {
        return <PdfEmbed href={seg.href} label={pdfLabelFromHref(seg.href)} />;
      }
      if (!isSafeHref(seg.href)) return <>{seg.href}</>;
      return <a href={seg.href} target="_blank" rel="noreferrer">{seg.href}</a>;
    case "link":
      if (isPdfAssetHref(seg.href)) return <PdfEmbed href={seg.href} label={seg.text} />;
      if (isBlueskyPostUrl(seg.href)) return <BlueskyEmbed href={seg.href} />;
      if (!isSafeHref(seg.href)) return <>{seg.text}</>;
      return <a href={seg.href} target="_blank" rel="noreferrer">{seg.text}</a>;
    case "bold":
      return <strong><InlineSegments segments={seg.children} depth={depth} /></strong>;
    case "italic":
      return <em><InlineSegments segments={seg.children} depth={depth} /></em>;
    case "strike":
      return <s><InlineSegments segments={seg.children} depth={depth} /></s>;
    case "highlight":
      return <mark className="highlight"><InlineSegments segments={seg.children} depth={depth} /></mark>;
    case "todo":
      return <TodoCheckbox done={seg.done} />;
    case "code-block":
      if (seg.lang === "mermaid") return <MermaidDiagram code={seg.code} />;
      return <CodeBlock lang={seg.lang} code={seg.code} />;
    case "query":
      return <QueryBlock expr={seg.expr} depth={depth} />;
  }
}
