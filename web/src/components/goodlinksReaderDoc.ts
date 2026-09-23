// pattern: Functional Core
// Everything the GoodLinks reader decides without touching the DOM: the
// note for each failure, the saved-date line, and the document the iframe
// renders. `readerDocument` is the only place in the app that assembles
// HTML it did not generate itself, and it only ever receives HTML the
// server has already reduced to its allowlist; the iframe sandbox (no
// scripts, no same-origin) is the second barrier. Do not widen either.
export const READER_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export type ReaderPalette = { bg: string; text: string; link: string };

// The server's 503 detail for a refused API token. Its ordinary 503
// detail says "on the host", and the reader says "on the Mac" instead, so
// only this one detail is shown as sent.
export const UNAUTHORIZED_DETAIL = "Goodlinks rejected the API token";

export function failureNote(status: number, detail?: string): string {
  if (status === 503 && detail === UNAUTHORIZED_DETAIL) return UNAUTHORIZED_DETAIL;
  if (status === 503) return "Goodlinks is not running on the Mac";
  if (status === 404) return "No longer in Goodlinks";
  if (status === 0) return "Needs the server";
  return "Couldn't load this article.";
}

const SAVED_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function formatSaved(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return `saved ${SAVED_FORMAT.format(new Date(t))}`;
}

export function readerDocument(html: string, palette: ReaderPalette): string {
  const css = [
    `html { background: ${palette.bg}; color: ${palette.text}; }`,
    "body { margin: 0 auto; padding: 24px 20px 64px; max-width: 42rem; font: 17px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }",
    `a { color: ${palette.link}; }`,
    "img { max-width: 100%; height: auto; }",
    "pre { overflow-x: auto; padding: 12px; }",
    "table { border-collapse: collapse; max-width: 100%; overflow-x: auto; display: block; }",
    "td, th { border: 1px solid currentColor; padding: 4px 8px; }",
    "blockquote { margin: 0; padding-left: 1em; border-left: 3px solid currentColor; opacity: .85; }",
  ].join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>${css}</style></head><body>${html}</body></html>`;
}
