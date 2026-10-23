// pattern: Functional Core
// What a diagram may fetch: nothing. A diagram's source is text anyone who
// writes markdown controls, the assistant included, so a URL it makes the
// browser load is an outbound channel, as an image src is.
//
// beautiful-mermaid escapes labels and drops url() style values, but its SVG
// opens with a Google Fonts @import; stripCssImports removes that.
//
// Stock mermaid's "strict" level is not enough. Its DOMPurify pass on label
// HTML keeps <img src>, media attributes and SVG url() references, its
// frontmatter and %%{init}%% config reach CSS with only a brace-balance
// check, and d3 creates some <image> elements outside DOMPurify (image
// shapes, sequence actor icons). mermaid.render also lays the diagram out
// in the live document, so a fetch starts before the SVG is returned:
// cleaning the output is too late. Hence three layers, all applied before
// render: secured config keys, a stricter DOMPurify config, and
// refusesStockRender for source whose effect the first two cannot reach.

// Mermaid 11's own default list restated, because initialize replaces the
// list rather than adding to it; mermaidSafety.test.ts checks it still
// covers the installed mermaid's default.
const MERMAID_DEFAULT_SECURE = [
  "secure", "securityLevel", "startOnLoad", "maxTextSize",
  "suppressErrorRendering", "maxEdges",
];

/** Config keys a diagram's own frontmatter or %%{init}%% may not set. */
export const STOCK_MERMAID_SECURE = [
  ...MERMAID_DEFAULT_SECURE,
  // each becomes CSS; mermaid checks only that its braces balance
  "themeCSS", "themeVariables", "fontFamily", "altFontFamily",
  // not settable today (not a known key), secured in case it becomes one
  "dompurifyConfig",
];

/** Applied by stock mermaid to every label it renders as HTML. The default
 * config keeps everything here; each entry made a request in a probe. */
export const STOCK_MERMAID_DOMPURIFY = {
  FORBID_TAGS: ["img", "image", "style", "feimage"],
  FORBID_ATTR: [
    "style", "src", "srcset", "poster", "background",
    // SVG presentation attributes that load an external url() reference
    "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end",
  ],
};

// Named entities a diagram may use. Any other could spell CSS punctuation,
// such as &lpar; for "(" or &commat; for "@". A name of hex digits alone is
// a colour such as "#f96;", and no HTML entity of that spelling yields
// ASCII.
const SAFE_NAMED_ENTITIES = new Set(["quot", "amp", "lt", "gt", "apos", "nbsp"]);
const HEX_NAME = /^[0-9a-f]+$/i;

// HTML's &#123; and &#x7b;, whose semicolon HTML does not require; mermaid's
// #123;; and the named forms &name; and #name;.
const ENTITY = /&#(\d+|x[0-9a-f]+);?|#(\d+);|[#&]([a-z][a-z0-9]*);/gi;

// Mermaid drops one trailing ";" from style and classDef lines before it
// reads entities, so that a closing "fill:#f96;" is not one.
function asMermaidReadsEntities(code: string): string {
  return code
    .replace(/style.*:\S*#.*;/g, (line) => line.slice(0, -1))
    .replace(/classDef.*:\S*#.*;/g, (line) => line.slice(0, -1));
}

function codePoint(digits: string, radix: number): string {
  return String.fromCodePoint(parseInt(digits, radix) % 0x110000);
}

function decodeNumericEntities(text: string): string {
  return text.replace(ENTITY, (whole, html?: string, mermaid?: string) => {
    if (html !== undefined) {
      return /^x/i.test(html) ? codePoint(html.slice(1), 16) : codePoint(html, 10);
    }
    return mermaid !== undefined ? codePoint(mermaid, 10) : whole;
  });
}

function hasUnsafeNamedEntity(text: string): boolean {
  for (const match of text.matchAll(ENTITY)) {
    const named = match[3];
    if (named === undefined) continue;
    if (!SAFE_NAMED_ENTITIES.has(named.toLowerCase()) && !HEX_NAME.test(named)) return true;
  }
  return false;
}

// A CSS fetch needs one of these. Vendor-prefixed forms (-webkit-image-set(,
// -webkit-cross-fade() contain them too.
const CSS_FETCH = /url\(|image\(|image-set\(|fade\(|src\(|@import|@font-face/i;
// v11 shape data, `A@{ img: "https://..." }`: d3 creates its <image> and a
// preloading Image() directly, so no sanitizer sees it.
const SHAPE_DATA = /@\{/;
const IMG_KEY = /img/i;
// Sequence diagrams' `properties` JSON can carry an actor icon URL that d3
// draws as an <image>; `details` loads the same JSON from a page element.
const ACTOR_PROPERTIES = /(^|[\n;])[^\S\n]*(properties|details)\b/i;

/**
 * True when stock mermaid must not render this source, because the
 * hardened config cannot stop what it would fetch. A backslash is refused
 * outright: CSS escapes (\75rl) and YAML or JSON escapes can spell any of
 * the patterns below. Entities are decoded first, because mermaid decodes
 * them into the SVG, where "url#40;" becomes "url(". The rule errs toward
 * refusing: a refused diagram shows its source, which loses nothing.
 */
export function refusesStockRender(code: string): boolean {
  if (code.includes("\\")) return true;
  // Decoded until stable, so an entity that spells another is caught; one
  // nested deeper than any real diagram needs is refused.
  let decoded = asMermaidReadsEntities(code);
  for (let depth = 0; ; depth++) {
    if (hasUnsafeNamedEntity(decoded)) return true;
    const next = decodeNumericEntities(decoded);
    if (next === decoded) break;
    if (depth === 3) return true;
    decoded = next;
  }
  if (decoded.includes("\\")) return true;
  if (CSS_FETCH.test(decoded)) return true;
  if (SHAPE_DATA.test(decoded) && IMG_KEY.test(decoded)) return true;
  return ACTOR_PROPERTIES.test(decoded);
}

// An @import rule in a <style> block: url(...) or a quoted string, then any
// media list, to its semicolon.
const CSS_IMPORT = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi;
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;

/** beautiful-mermaid's SVG without the @import rules in its <style> blocks.
 * The font stack they import is the app's system stack, so text renders the
 * same without them. */
export function stripCssImports(svg: string): string {
  return svg.replace(STYLE_BLOCK, (_whole, open: string, css: string, close: string) =>
    open + css.replace(CSS_IMPORT, "") + close);
}
