// pattern: Imperative Shell
// Two renderers, tried in order. beautiful-mermaid (ELK layout, app-token
// theming via mermaidTheme.ts's beautifulMermaidOptions) is primary; any
// render failure falls back silently to stock mermaid, so diagram families
// beautiful-mermaid doesn't cover (gantt, pie, mindmap, ...) keep working.
// Only when both fail does the raw-source error block appear.
//
// Both libraries are heavy, so each is loaded lazily via a cached
// module-level import() promise on first use (Vite splits them into their
// own chunks); most pages load neither, a page with diagrams loads only the
// beautiful-mermaid chunk, and the stock mermaid chunk loads solely when a
// fallback actually fires.
//
// Both renderers return library-generated SVG (never dangerouslySetInnerHTML
// of unsanitized server/user text) -- the same trust boundary CodeBlock's
// hljs.highlight() output crosses; see CodeBlock.tsx's comment. No diagram
// may fetch, and mermaidSafety.ts says how each renderer is held to that.
// Under UntrustedContentContext (assistant replies) the stock fallback also
// waits behind ClickToLoad: a diagram beautiful-mermaid can't render shows
// its source and a "Render diagram" button, keyed by the source.
//
// Theming: the beautiful-mermaid path re-resolves the design tokens and
// re-renders when the effective theme changes (useEffectiveTheme). The
// stock fallback path keeps its historical initialize-time theme snapshot;
// re-plumbing it for live flips isn't worth it for a path that only serves
// exotic diagrams.
//
// Rendered SVG is cached by (theme, code): mermaid layout is the most
// expensive synchronous computation in the app (the beautiful-mermaid chunk
// alone is 1.5 MB), so remounting a diagram that's already been rendered
// once (e.g. navigating away and back) should never re-run it. The cache is
// consulted before renderWithFallback is even called, so a hit never awaits
// loadBeautifulMermaid()'s dynamic import. Only successful renders are
// cached -- an error is transient/theme-independent enough (a chunk load
// blip, a momentarily-bad diagram) that caching it would wedge future
// remounts into permanent failure.
//
// The stock-mermaid fallback bakes its `renderId` argument into the
// returned SVG's own id attribute (and any internal same-document
// references) -- and, more importantly, stock mermaid's render() looks that
// id up in `document`, deletes any existing element with it, appends its
// own, and reads the result back by id. Two fallback diagrams mounting in
// the same commit MUST render with distinct real ids (never a shared
// placeholder) or they clobber each other's DOM lookup. So every render
// still goes out with this instance's own `renderId` -- the placeholder
// only replaces it afterwards, for the copy that goes into the cache: on a
// successful render, `svg.split(renderId).join(MERMAID_CACHE_RENDER_ID)`
// normalises the id-dependent SVG into an id-independent one before it's
// stored, and `withRenderId` substitutes the current instance's real id
// back in on every use that reads from state -- hit or miss alike -- so a
// cache hit never shows the placeholder or another instance's id.
import { useContext, useEffect, useId, useState } from "react";
import type { Mermaid } from "mermaid";
import { UntrustedContentContext } from "../contexts";
import { ClickToLoad } from "./ClickToLoad";
import { CodeBlock } from "./CodeBlock";
import {
  refusesStockRender, STOCK_MERMAID_DOMPURIFY, STOCK_MERMAID_SECURE, stripCssImports,
} from "./mermaidSafety";
import { beautifulMermaidOptions, mermaidThemeVariables } from "./mermaidTheme";
import { createBoundedCache } from "./renderCache";
import { useEffectiveTheme } from "../useEffectiveTheme";

type RenderState =
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error" }
  // untrusted source beautiful-mermaid couldn't render: stock waits for a click
  | { status: "gated" };

// auto: beautiful-mermaid, falling back to stock. gated: beautiful-mermaid
// only, the fallback left to a click. stock: the fallback, after that click.
type RenderMode = "auto" | "gated" | "stock";

// Which renderer made a cached SVG, so a stock render cached from a note
// still waits for a click when the same source appears in a reply.
type CachedRender = { svg: string; stock: boolean };

type BeautifulMermaid = typeof import("./beautifulMermaid");

// Loaded and initialized once for the whole page, shared by every diagram
// on it: avoids re-fetching each chunk (and re-running stock mermaid's
// initialize()) per fenced block when several appear on the same page. This
// also sidesteps a real race when multiple diagrams mount in the same commit
// and each independently calls import() -- the module loader only settles
// that specifier's import once, module-level-cache-Promise style, matching
// bluesky.ts's didCache pattern for resolveHandle.
let bmPromise: Promise<BeautifulMermaid> | null = null;
let mermaidPromise: Promise<Mermaid> | null = null;

function loadBeautifulMermaid(): Promise<BeautifulMermaid> {
  if (!bmPromise) {
    bmPromise = import("./beautifulMermaid");
    // A failed chunk load shouldn't wedge every future diagram on the page.
    bmPromise.catch(() => { bmPromise = null; });
  }
  return bmPromise;
}

function isDarkTheme(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      // "base" + themeVariables derived from the app's design tokens
      // (mermaidTheme.ts) instead of mermaid's stock default/dark themes.
      // Tokens are resolved here, once, so they match whichever palette is
      // active when the fallback first fires.
      const style = getComputedStyle(document.documentElement);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        secure: STOCK_MERMAID_SECURE,
        dompurifyConfig: STOCK_MERMAID_DOMPURIFY,
        theme: "base",
        themeVariables: mermaidThemeVariables(isDarkTheme(), (name) =>
          style.getPropertyValue(name),
        ),
      });
      return mermaid;
    });
    mermaidPromise.catch(() => { mermaidPromise = null; });
  }
  return mermaidPromise;
}

async function renderBeautiful(code: string): Promise<string> {
  const bm = await loadBeautifulMermaid();
  const style = getComputedStyle(document.documentElement);
  const svg = await bm.renderMermaid(
    code,
    beautifulMermaidOptions((name) => style.getPropertyValue(name)),
  );
  return stripCssImports(svg);
}

// Refused source never reaches mermaid.render, which lays the diagram out
// in the live document: anything it would fetch is fetched during render.
async function renderStock(code: string, renderId: string): Promise<string> {
  if (refusesStockRender(code)) throw new Error("mermaid: source refused for stock render");
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(renderId, code);
  return svg;
}

async function renderWithFallback(
  code: string, renderId: string, mode: RenderMode,
): Promise<CachedRender | "gated"> {
  if (mode !== "stock") {
    try {
      return { svg: await renderBeautiful(code), stock: false };
    } catch {
      if (mode === "gated") return "gated";
    }
  }
  return { svg: await renderStock(code, renderId), stock: true };
}

// The placeholder id-independent SVG is normalised to before caching (see
// this file's header comment); exported only so MermaidDiagram.test.tsx can
// assert it never leaks into rendered DOM or into a real render() call. Not
// a real per-instance id -- every consumer rewrites it via withRenderId()
// before display. Private-Use-Area characters (valid in XML/SVG text, but
// not something a diagram label or the mermaid/KaTeX source would ever
// contain) bracket the readable part so an ordinary label containing the
// same words as this string still can't collide with it; withRenderId's
// plain string substitution has no way to tell a genuine occurrence from an
// accidental one, so this is a mitigation, not a guarantee.
export const MERMAID_CACHE_RENDER_ID = "mermaid-render-cache-id";

const MERMAID_CACHE_LIMIT = 2000;
const mermaidCache = createBoundedCache<CachedRender>(MERMAID_CACHE_LIMIT);

function withRenderId(svg: string, renderId: string): string {
  return svg.split(MERMAID_CACHE_RENDER_ID).join(renderId);
}

export function MermaidDiagram({ code }: { code: string }) {
  const untrusted = useContext(UntrustedContentContext);
  return <MermaidRender code={code} mode={untrusted ? "gated" : "auto"} />;
}

function MermaidRender({ code, mode }: { code: string; mode: RenderMode }) {
  // useId is stable for this component instance and unique across the page,
  // so two fallback diagrams rendered at once never collide on stock
  // mermaid's render id.
  const renderId = `mermaid-${useId().replace(/:/g, "")}`;
  const [state, setState] = useState<RenderState>({ status: "loading" });
  // In the effect's dependencies so a theme flip re-renders the diagram
  // with freshly resolved tokens (beautiful-mermaid path only; the stock
  // fallback re-runs too but keeps its initialize-time snapshot).
  const effectiveTheme = useEffectiveTheme();

  useEffect(() => {
    let alive = true;
    const cacheKey = `${effectiveTheme} ${code}`;
    const cached = mermaidCache.get(cacheKey);
    if (cached !== undefined) {
      // Cache hit: resolve synchronously, without even calling
      // renderWithFallback -- so loadBeautifulMermaid()'s dynamic import is
      // never awaited (or invoked at all) on a remount of an already-seen
      // diagram.
      setState(mode === "gated" && cached.stock ? { status: "gated" }
        : { status: "ok", svg: withRenderId(cached.svg, renderId) });
      return;
    }
    setState({ status: "loading" });
    // Rendered with this instance's real renderId -- not the placeholder --
    // so two fallback diagrams mounting at once never collide on stock
    // mermaid's DOM-based render-by-id lookup (see this file's header
    // comment). The result is normalised to the placeholder before it's
    // cached; withRenderId then substitutes the real id back in for
    // display, exactly as it does on a hit.
    renderWithFallback(code, renderId, mode).then(
      (rendered) => {
        if (rendered === "gated") {
          if (alive) setState({ status: "gated" });
          return;
        }
        const normalized = rendered.svg.split(renderId).join(MERMAID_CACHE_RENDER_ID);
        mermaidCache.set(cacheKey, { svg: normalized, stock: rendered.stock });
        if (alive) setState({ status: "ok", svg: withRenderId(normalized, renderId) });
      },
      () => {
        // Both renderers failed: degrade to the raw-source fallback below
        // rather than crash or leave a blank block. Not cached -- a failure
        // is transient/theme-independent enough that caching it would wedge
        // future remounts into permanent failure.
        if (alive) setState({ status: "error" });
      },
    );
    return () => { alive = false; };
  }, [code, renderId, effectiveTheme, mode]);

  if (state.status === "gated") {
    return (
      <ClickToLoad revealKey={code} label="Render diagram"
                   preview={<CodeBlock lang="mermaid" code={code} />}>
        <MermaidRender code={code} mode="stock" />
      </ClickToLoad>
    );
  }
  if (state.status === "error") {
    return (
      <div className="mermaid-diagram-error">
        <p className="mermaid-diagram-error-note">Couldn't render this diagram.</p>
        <CodeBlock lang="mermaid" code={code} />
      </div>
    );
  }
  if (state.status === "loading") {
    // Same shell as CodeBlock's unhighlighted case, so there's no layout
    // flash once a renderer chunk finishes loading and the SVG swaps in.
    return (
      <pre className="code-block mermaid-diagram-loading">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="mermaid-diagram"
      // library-generated SVG (never raw user/server text) -- see the
      // trust-boundary note in this file's header comment.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
