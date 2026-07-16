// pattern: Imperative Shell
// mermaid is ~1MB; importing it eagerly would bloat the initial bundle for a
// feature most pages never use, so it's loaded lazily via dynamic import()
// on first render. Vite splits it into its own chunk automatically.
//
// mermaid.render() returns library-generated SVG (never dangerouslySetInnerHTML
// of unsanitized server/user text) -- the same trust boundary CodeBlock's
// hljs.highlight() output crosses; see CodeBlock.tsx's comment. securityLevel
// "strict" (mermaid's default) additionally sanitizes any HTML/script-like
// content embedded in diagram labels before it reaches the DOM.
import { useEffect, useId, useState } from "react";
import type { Mermaid } from "mermaid";
import { CodeBlock } from "./CodeBlock";

type RenderState =
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error" };

/** Reads the effective theme once, at mount, rather than tracking live
 * theme changes -- a diagram already on screen won't re-theme if the user
 * flips light/dark mid-session, which is an acceptable simplification here
 * (see styles.css / useTheme.ts for how data-theme is stamped). */
function currentMermaidTheme(): "dark" | "default" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return "dark";
  if (attr === "light") return "default";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "default";
}

// Loaded and initialized once for the whole page, shared by every diagram
// on it: avoids re-fetching the ~1MB chunk (and re-running initialize())
// per fenced block when several appear on the same page. This also
// sidesteps a real race when multiple diagrams mount in the same commit
// and each independently calls import("mermaid") -- the module loader
// only settles that specifier's import once, module-level-cache-Promise
// style, matching bluesky.ts's didCache pattern for resolveHandle.
let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: currentMermaidTheme(),
      });
      return mermaid;
    });
    // A failed chunk load shouldn't wedge every future diagram on the page.
    mermaidPromise.catch(() => { mermaidPromise = null; });
  }
  return mermaidPromise;
}

export function MermaidDiagram({ code }: { code: string }) {
  // useId is stable for this component instance and unique across the page,
  // so two diagrams rendered at once never collide on mermaid's render id.
  const renderId = `mermaid-${useId().replace(/:/g, "")}`;
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loadMermaid().then(
      async (mermaid) => {
        try {
          const { svg } = await mermaid.render(renderId, code);
          if (alive) setState({ status: "ok", svg });
        } catch {
          // Invalid diagram source: degrade to the raw-source fallback below
          // rather than crash or leave a blank block.
          if (alive) setState({ status: "error" });
        }
      },
      () => { if (alive) setState({ status: "error" }); },
    );
    return () => { alive = false; };
  }, [code, renderId]);

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
    // flash once mermaid's chunk finishes loading and the SVG swaps in.
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
