# LaTeX Support (pkm-lr96) — Design

Date: 2026-07-17
Bean: pkm-lr96
Status: approved

## Goal

Render `$$...$$` content as LaTeX math via KaTeX, both as a standalone block and
inline within a block's text. Example source content: the imported Roam page
`[[Software Estimation]]`.

## Decisions

- **Library: KaTeX**, lazy-loaded. Roam itself renders with KaTeX, so imported
  content renders with full fidelity. MathJax (heavier, async, unneeded
  coverage) and Temml/MathML (smaller but browser-dependent fidelity) were
  considered and rejected.
- **Delimiters: `$$...$$` only.** Single-dollar `$...$` is NOT math — avoids
  false positives on currency and matches the Roam corpus.
- **Display vs inline:** a block whose entire text (after trimming whitespace)
  is exactly one `$$...$$` expression renders in KaTeX display mode (centered,
  large operators). Any `$$...$$` appearing mid-text renders inline-style,
  flowing with the surrounding text.
- **Error handling: raw-text fallback.** If KaTeX throws, show the original
  `$$...$$` source as plain text with a subtle tint. Nothing hidden or lost.
- **No `/math` slash command** (typing `$$` is trivial; add later if wanted).
- **Server untouched.** Roam import already passes `$$...$$` through verbatim.
  `server/src/pkm/refs.py` is deliberately NOT taught math-opacity: a
  `[[Page]]` inside `$$...$$` would still create a back-reference server-side
  while not rendering as a link client-side. Real TeX essentially never
  contains `[[...]]`; accepted inconsistency to keep this web-only.

## Grammar (`web/src/grammar/tokenize.ts`)

- New segment kind: `{ kind: "math"; tex: string; display: boolean }`.
- Block-level pass: detect the whole-block case and emit a display-math
  segment (alongside the existing code-fence/query/pdf-embed handling).
- Inline pass: scan for `$$...$$` and emit inline math segments.
- Precedence and opacity:
  - Code wins: `$$` inside inline code or fences stays literal (the shared
    scanner already blanks code before anything else runs).
  - Math interior is opaque to the render grammar: no emphasis, markdown
    links, autolinks, or `[[wikilinks]]` are parsed inside `$$...$$`. The
    interior is verbatim TeX.
- Non-matches: unclosed `$$` and empty `$$$$` are plain text.

## Rendering (`web/src/components/`)

- New `MathSpan` component modeled on `MermaidDiagram.tsx`:
  - Module-level cached promise around `import("katex")` so KaTeX ships as its
    own lazy chunk; failed chunk load resets the promise for retry.
  - States: loading (show raw source as-is), ok, error (raw source, subtle
    tint).
  - Render via `katex.renderToString(tex, { displayMode, throwOnError: true })`
    into `dangerouslySetInnerHTML` — library-generated markup, same trust
    boundary argument as mermaid's SVG.
- `InlineSegments.tsx` gains a `case "math":` mapping to `MathSpan`.
- Editing behaviour unchanged: the focused block shows raw text in its
  textarea; math renders when the block loses focus (same as code/mermaid).

## CSS, fonts, bundle budgets

- `katex/dist/katex.min.css` is imported inside the lazy module so the CSS and
  its font references stay out of the initial entry (which has only ~16 KB of
  headroom against `initialEntryBytes`).
- New `katexOwnedBytes` budget: seed matching `node_modules/katex/` in
  `web/tooling/viteBudgetPlugin.ts`, limit in `web/tooling/budgets.json`
  (pattern copied from mermaid/pdfjs).
- PWA precache: KaTeX references ~20 woff2 fonts; browsers fetch only the
  fonts actually used. Precache the core set (KaTeX_Main regular/bold/italic,
  KaTeX_Math-Italic, KaTeX_Size1–4, KaTeX_AMS) plus the CSS, bumping
  `precacheBytes`/`precacheEntries` as needed. Exotic fonts (Fraktur, Script,
  Typewriter, …) load on demand when online and fall back to system fonts
  offline.

## Testing

- Tokenizer unit tests: inline math mid-text; whole-block display detection
  (including surrounding whitespace); multiple `$$...$$` in one block;
  unclosed `$$`; empty `$$$$`; `$$` inside inline code and fences stays
  literal; emphasis/wikilinks inside math not parsed.
- Component tests: valid TeX renders KaTeX markup; KaTeX throw → raw fallback
  with tint class.
- E2E: create a block containing `$$...$$`, blur, assert `.katex` output;
  assert display-mode styling for a whole-block expression and inline flow for
  mid-text math.
- `cd web && pnpm verify` must pass, including bundle budgets.
