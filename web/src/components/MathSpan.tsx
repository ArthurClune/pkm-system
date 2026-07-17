// pattern: Imperative Shell
// KaTeX (~280KB + CSS/fonts) is loaded lazily via dynamic import() on first
// math render, mirroring MermaidDiagram.tsx, so blocks without math never
// pay for it. Vite splits katex and its CSS into their own chunk.
//
// katex.renderToString() output is library-generated markup (never raw
// user/server text through dangerouslySetInnerHTML) -- the same trust
// boundary MermaidDiagram's SVG and CodeBlock's hljs output cross. KaTeX's
// default trust:false additionally refuses \href and friends.
import { useEffect, useState } from "react";

type KatexLib = typeof import("katex").default;

type RenderState =
  | { status: "loading" }
  | { status: "ok"; html: string }
  | { status: "error" };

// Loaded once for the whole page, shared by every math span on it --
// module-level-cache-Promise style, same as MermaidDiagram's loadMermaid().
// The CSS import rides along so the katex styles/fonts join the lazy chunk
// instead of the eager entry (initialEntryBytes headroom is ~16KB).
let katexPromise: Promise<KatexLib> | null = null;

function loadKatex(): Promise<KatexLib> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([mod]) => mod.default);
    // A failed chunk load shouldn't wedge every future math span.
    katexPromise.catch(() => { katexPromise = null; });
  }
  return katexPromise;
}

export function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loadKatex().then(
      (katex) => {
        try {
          const html = katex.renderToString(tex,
            { displayMode: display, throwOnError: true });
          if (alive) setState({ status: "ok", html });
        } catch {
          // Invalid TeX: degrade to the raw-source fallback below.
          if (alive) setState({ status: "error" });
        }
      },
      () => { if (alive) setState({ status: "error" }); },
    );
    return () => { alive = false; };
  }, [tex, display]);

  // math-display is a block-styled <span>, not a <div>: the segment can sit
  // inside an h1-h3 block wrapper where a div is invalid nesting.
  const cls = display ? "math-display" : "math-inline";
  if (state.status !== "ok") {
    const stateCls = state.status === "error" ? " math-error" : " math-loading";
    return <span className={cls + stateCls}>{`$$${tex}$$`}</span>;
  }
  return (
    <span
      className={cls}
      // library-generated markup (never raw user/server text) -- see the
      // trust-boundary note in this file's header comment.
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  );
}
