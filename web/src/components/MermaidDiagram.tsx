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
// hljs.highlight() output crosses; see CodeBlock.tsx's comment. Stock
// mermaid additionally runs securityLevel "strict"; beautiful-mermaid
// escapes label text during its own SVG serialization.
//
// Theming: the beautiful-mermaid path re-resolves the design tokens and
// re-renders when the effective theme changes (useEffectiveTheme). The
// stock fallback path keeps its historical initialize-time theme snapshot;
// re-plumbing it for live flips isn't worth it for a path that only serves
// exotic diagrams.
import { useEffect, useId, useState } from "react";
import type { Mermaid } from "mermaid";
import { CodeBlock } from "./CodeBlock";
import { beautifulMermaidOptions, mermaidThemeVariables } from "./mermaidTheme";
import { useEffectiveTheme } from "../useEffectiveTheme";

type RenderState =
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error" };

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

async function renderWithFallback(code: string, renderId: string): Promise<string> {
  try {
    const bm = await loadBeautifulMermaid();
    const style = getComputedStyle(document.documentElement);
    return await bm.renderMermaid(
      code,
      beautifulMermaidOptions((name) => style.getPropertyValue(name)),
    );
  } catch {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(renderId, code);
    return svg;
  }
}

export function MermaidDiagram({ code }: { code: string }) {
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
    setState({ status: "loading" });
    renderWithFallback(code, renderId).then(
      (svg) => { if (alive) setState({ status: "ok", svg }); },
      () => {
        // Both renderers failed: degrade to the raw-source fallback below
        // rather than crash or leave a blank block.
        if (alive) setState({ status: "error" });
      },
    );
    return () => { alive = false; };
  }, [code, renderId, effectiveTheme]);

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
