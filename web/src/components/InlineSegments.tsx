// pattern: Functional Core
import type { BlockSegment } from "../grammar/tokenize";
import { AssetImage } from "./AssetImage";
import { BlockRef } from "./BlockRef";
import { CodeBlock } from "./CodeBlock";
import { PageLink } from "./PageLink";
import { PdfEmbed } from "./PdfEmbed";
import { QueryBlock } from "./QueryBlock";
import { TodoCheckbox } from "./TodoCheckbox";

function isPdfAssetHref(href: string): boolean {
  return href.startsWith("/assets/") && href.toLowerCase().endsWith(".pdf");
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
    case "page-ref":
      return <PageLink title={seg.title} tag={seg.tag} />;
    case "attribute":
      return (
        <span className="attribute">
          <PageLink title={seg.name} tag={false} />::
        </span>
      );
    case "block-ref":
      return <BlockRef uid={seg.uid} depth={depth} />;
    case "image":
      return <AssetImage src={seg.src} alt={seg.alt} />;
    case "link":
      return isPdfAssetHref(seg.href)
        ? <PdfEmbed href={seg.href} label={seg.text} />
        : <a href={seg.href} target="_blank" rel="noreferrer">{seg.text}</a>;
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
      return <CodeBlock lang={seg.lang} code={seg.code} />;
    case "query":
      return <QueryBlock expr={seg.expr} />;
  }
}
