// pattern: Functional Core
import { scanMarkdownLinks, type MarkdownSpan } from "./markdown";
import { scanGrammar, type Span } from "./scan";

export type LinkReferenceResult =
  | { status: "linked"; text: string; match: "plain" | "markdown" }
  | { status: "no-safe-match" };

const ALNUM = /[\p{L}\p{N}]/u;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Bare http(s) URLs are atomic: a word that happens to sit inside one (host,
// path, or query) must never be wrapped, or the URL gets corrupted (e.g.
// "https://testpage.com/url" -> "https://[[Testpage]].com/url"). Mirrors the
// boundary + trailing-punctuation-trim rule tokenize.ts uses for autolinking
// bare URLs, so a word is "inside a URL" here exactly when it would render
// as part of an autolinked URL there.
const BARE_URL_RE = /https?:\/\/\S+/g;

function scanBareUrls(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(BARE_URL_RE)) {
    const start = match.index;
    if (start === undefined) continue;
    if (start > 0 && !/[\s([{]/.test(text[start - 1])) continue;
    const url = match[0].replace(/[.,;:!?'")\]}>]+$/, "");
    if (/^https?:\/\/$/.test(url)) continue;
    spans.push({ start, end: start + url.length });
  }
  return spans;
}

const overlaps = (left: Span, right: Span): boolean =>
  left.start < right.end && right.start < left.end;

const contains = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

const firstCodePoint = (value: string): string => [...value][0] ?? "";
const lastCodePoint = (value: string): string => [...value].at(-1) ?? "";
const codePointBefore = (value: string, offset: number): string =>
  [...value.slice(0, offset)].at(-1) ?? "";
const codePointAfter = (value: string, offset: number): string =>
  [...value.slice(offset)][0] ?? "";

function candidates(text: string, title: string): Span[] {
  const startsAlnum = ALNUM.test(firstCodePoint(title));
  const endsAlnum = ALNUM.test(lastCodePoint(title));
  const found: Span[] = [];

  for (const match of text.matchAll(new RegExp(escapeRegExp(title), "giu"))) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + match[0].length;
    if (startsAlnum && ALNUM.test(codePointBefore(text, start))) continue;
    if (endsAlnum && ALNUM.test(codePointAfter(text, end))) continue;
    found.push({ start, end });
  }

  return found;
}

const matchingMarkdown = (
  spans: readonly MarkdownSpan[],
  found: readonly Span[],
  grammarProtected: readonly Span[],
): boolean => spans.some((markdown) =>
  markdown.kind === "link"
  && !grammarProtected.some((span) => overlaps(markdown, span)
    && (span.start <= markdown.start || markdown.end <= span.end))
  && found.some((candidate) =>
    !grammarProtected.some((span) => overlaps(candidate, span))
    && (contains(markdown.label, candidate)
      || contains(markdown.destination, candidate))),
);

export function linkUnlinkedReference(
  text: string,
  canonicalTitle: string,
): LinkReferenceResult {
  if (canonicalTitle.length === 0) return { status: "no-safe-match" };

  const found = candidates(text, canonicalTitle);
  const grammarProtected = scanGrammar(text).tokens.filter((token) =>
    token.kind === "page-ref" || token.kind === "hashtag"
      || token.kind === "block-ref" || token.kind === "inline-code"
      || token.kind === "code-fence",
  );
  const markdown = scanMarkdownLinks(text);
  const bareUrls = scanBareUrls(text);
  const allProtected: readonly Span[] = [...grammarProtected, ...markdown, ...bareUrls];
  const plain = found.find((candidate) =>
    !allProtected.some((span) => overlaps(candidate, span)),
  );

  if (plain) {
    return {
      status: "linked",
      match: "plain",
      text: `${text.slice(0, plain.start)}[[${canonicalTitle}]]${text.slice(plain.end)}`,
    };
  }

  if (matchingMarkdown(markdown, found, grammarProtected)) {
    const separator = /\s$/u.test(text) ? "" : " ";
    return {
      status: "linked",
      match: "markdown",
      text: `${text}${separator}#[[${canonicalTitle}]]`,
    };
  }

  return { status: "no-safe-match" };
}
