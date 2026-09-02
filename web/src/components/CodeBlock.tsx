// pattern: Imperative Shell
// highlight.js/lib/common (~37 bundled grammars) is loaded lazily via a
// cached module-level import() promise on first code-block render,
// mirroring MathSpan.tsx's loadKatex() -- Vite splits it into its own
// chunk, so pages/messages without a code fence never pay for it. Until it
// loads (and for any language hljs doesn't recognize), the block renders
// as plain unstyled text -- no blank flash, same policy as MathSpan's
// raw-source fallback while KaTeX loads.
//
// hljs.highlight() output is library-generated markup (never raw
// user/server text through dangerouslySetInnerHTML) -- the same trust
// boundary MathSpan's KaTeX output and MermaidDiagram's SVG cross.
//
// No highlight.js theme CSS import here: Vite CSS imports are global, and
// stock github.css/github-dark.css both hard-code colors, so importing
// both would fight over which wins rather than switch with the app's
// theme. Instead, the .hljs-* token colors are copied into styles.css as
// --hljs-* custom properties (light values from github.css, dark from
// github-dark.css), which vary with data-theme the same way the rest of
// the theme does. See styles.css's "highlight.js token colors" section.
import { useEffect, useState } from "react";

type HljsLib = typeof import("highlight.js/lib/common").default;

let hljsPromise: Promise<HljsLib> | null = null;

function loadHljs(): Promise<HljsLib> {
  if (!hljsPromise) {
    hljsPromise = import("highlight.js/lib/common").then((mod) => mod.default);
    // A failed chunk load shouldn't wedge every future code block.
    hljsPromise.catch(() => { hljsPromise = null; });
  }
  return hljsPromise;
}

// Two-level Map (lang -> code -> html) rather than a joined string key: a
// joined key needs a delimiter that can never appear in `code`, and no
// printable one is safe (a NUL byte works but makes this file look binary
// to grep/git diff, which is worse). Nesting on the exact `lang`/`code`
// values sidesteps the collision problem entirely.
//
// Bounded by a whole-map clear rather than an LRU: an LRU only earns its
// complexity when eviction order matters, and it doesn't here -- once the
// working set of visible code blocks exceeds this size we'd be thrashing
// either way, so a full reset is the simplest thing that bounds memory.
// Exported (with cachedHighlight below) so tests can exercise the bound
// directly instead of rendering thousands of components.
export const HIGHLIGHT_CACHE_LIMIT = 2000;
const highlightCache = new Map<string, Map<string, string>>();
let highlightCacheSize = 0;

/** Looks up (lang, code) in the bounded cache, computing and storing via
 * `compute` on a miss. Pure apart from the module-level cache Maps
 * themselves. */
export function cachedHighlight(lang: string, code: string, compute: () => string): string {
  const cached = highlightCache.get(lang)?.get(code);
  if (cached !== undefined) return cached;
  const html = compute();
  if (highlightCacheSize >= HIGHLIGHT_CACHE_LIMIT) {
    highlightCache.clear();
    highlightCacheSize = 0;
  }
  let byCode = highlightCache.get(lang);
  if (!byCode) {
    byCode = new Map();
    highlightCache.set(lang, byCode);
  }
  byCode.set(code, html);
  highlightCacheSize += 1;
  return html;
}

export function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const [hljs, setHljs] = useState<HljsLib | null>(null);

  useEffect(() => {
    if (!lang) return;
    let alive = true;
    loadHljs().then(
      (lib) => { if (alive) setHljs(lib); },
      () => { /* stays on the plain-text fallback below */ },
    );
    return () => { alive = false; };
  }, [lang]);

  if (lang && hljs && hljs.getLanguage(lang)) {
    // Auto-detect stays off: only the fence's language tag selects a
    // grammar. hljs escapes its input; this HTML is library-generated, not
    // server text (the "no dangerouslySetInnerHTML" rule targets FTS
    // snippets).
    const html = cachedHighlight(lang, code, () => hljs.highlight(code, { language: lang }).value);
    return (
      <pre className="code-block">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  }
  return (
    <pre className="code-block">
      <code>{code}</code>
    </pre>
  );
}
