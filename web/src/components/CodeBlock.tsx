// pattern: Functional Core
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";

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
