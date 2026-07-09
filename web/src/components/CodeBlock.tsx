// pattern: Functional Core
import hljs from "highlight.js/lib/common";
// No highlight.js theme CSS import here: Vite CSS imports are global, and
// stock github.css/github-dark.css both hard-code colors, so importing
// both would fight over which wins rather than switch with the app's
// theme. Instead, the .hljs-* token colors are copied into styles.css as
// --hljs-* custom properties (light values from github.css, dark from
// github-dark.css), which vary with data-theme the same way the rest of
// the theme does. See styles.css's "highlight.js token colors" section.

export function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  if (lang && hljs.getLanguage(lang)) {
    // Auto-detect stays off: only the fence's language tag selects a grammar.
    // hljs escapes its input; this HTML is library-generated, not server text
    // (the "no dangerouslySetInnerHTML" rule targets FTS snippets).
    const html = hljs.highlight(code, { language: lang }).value;
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
